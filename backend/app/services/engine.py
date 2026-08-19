"""Stockfish driver: turns a PGN into a per-ply evaluation curve.

One engine process is kept alive and reused across games; it is guarded by a
lock because the analysis worker is the usual caller but the /refresh route can
race with it.
"""

from __future__ import annotations

import io
import logging
import math
import threading

import chess
import chess.engine
import chess.pgn

from app.config import settings

log = logging.getLogger(__name__)

MATE_CP = 10_000
CLIP_CP = 1_000  # beyond +-10 pawns a position is winning; further gain is noise

INACCURACY_CP = 50
MISTAKE_CP = 100
BLUNDER_CP = 300

_engine: chess.engine.SimpleEngine | None = None
_engine_lock = threading.Lock()


class EngineUnavailable(RuntimeError):
    pass


def _open_engine() -> chess.engine.SimpleEngine:
    global _engine
    if _engine is not None:
        return _engine
    try:
        eng = chess.engine.SimpleEngine.popen_uci(settings.stockfish_path)
    except (FileNotFoundError, PermissionError, OSError) as exc:
        raise EngineUnavailable(
            f"Stockfish not found at {settings.stockfish_path!r}. "
            "Install it and set STOCKFISH_PATH."
        ) from exc
    try:
        eng.configure({"Threads": settings.engine_threads, "Hash": settings.engine_hash_mb})
    except chess.engine.EngineError:
        pass  # some builds reject one of these; defaults are fine
    _engine = eng
    return eng


def close_engine() -> None:
    global _engine
    with _engine_lock:
        if _engine is not None:
            try:
                _engine.quit()
            except Exception:
                pass
            _engine = None


def engine_info() -> dict:
    """Health probe used by /api/health."""
    try:
        with _engine_lock:
            eng = _open_engine()
            name = eng.id.get("name", "stockfish")
        return {"available": True, "name": name, "path": settings.stockfish_path}
    except EngineUnavailable as exc:
        return {"available": False, "error": str(exc), "path": settings.stockfish_path}


def _clip(cp: int) -> int:
    return max(-CLIP_CP, min(CLIP_CP, cp))


def win_percent_white(cp: int) -> float:
    """Lichess win-probability model, from the White point of view."""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * _clip(cp))) - 1)


def move_accuracy(win_before: float, win_after: float) -> float:
    """Lichess per-move accuracy; both win% already from the mover point of view."""
    drop = max(0.0, win_before - win_after)
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * drop) - 3.1669))


def _judgment(cp_loss: int) -> str | None:
    if cp_loss >= BLUNDER_CP:
        return "blunder"
    if cp_loss >= MISTAKE_CP:
        return "mistake"
    if cp_loss >= INACCURACY_CP:
        return "inaccuracy"
    return None


def _phase(board: chess.Board) -> str:
    """Opening until move 12, endgame once the heavy material is gone."""
    pieces = sum(
        len(board.pieces(pt, color))
        for pt in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
        for color in (chess.WHITE, chess.BLACK)
    )
    if pieces <= 6:
        return "endgame"
    if board.fullmove_number <= 12:
        return "opening"
    return "middlegame"


def analyse_pgn(pgn: str, depth: int | None = None) -> dict:
    """Evaluate every position of the game once, then derive per-move stats.

    Position i is evaluated a single time: its eval is the "before" of move i
    and the "after" of move i-1, so an N-move game costs N+1 engine calls.
    """
    depth = depth or settings.engine_depth
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        raise ValueError("Unreadable PGN")

    start = game.board()
    moves = list(game.mainline_moves())[: settings.max_plies]
    if not moves:
        raise ValueError("PGN contains no moves")

    limit = chess.engine.Limit(depth=depth, time=settings.engine_max_time)

    with _engine_lock:
        eng = _open_engine()
        engine_name = eng.id.get("name", "stockfish")

        positions: list[dict] = []  # eval of each position, White POV
        meta: list[dict] = []
        cursor = chess.Board(start.fen())

        for ply in range(len(moves) + 1):
            info = eng.analyse(cursor, limit)
            score = info["score"].white()
            pv = info.get("pv") or []
            best = pv[0] if pv else None
            positions.append(
                {
                    "cp": score.score(mate_score=MATE_CP),
                    "mate": score.mate(),
                    "best_uci": best.uci() if best else None,
                    "best_san": cursor.san(best) if best else None,
                }
            )
            meta.append({"phase": _phase(cursor), "fullmove": cursor.fullmove_number})
            if ply < len(moves):
                cursor.push(moves[ply])

    # Second pass: replay the game, pairing consecutive evals.
    result_moves: list[dict] = []
    replay = chess.Board(start.fen())
    for i, move in enumerate(moves):
        mover_white = replay.turn == chess.WHITE
        san = replay.san(move)
        before, after = positions[i], positions[i + 1]

        sign = 1 if mover_white else -1
        is_best = before["best_uci"] == move.uci()
        # Playing the engine top move cannot lose value; any delta here is
        # search noise from evaluating the two positions at different plies.
        cp_loss = 0 if is_best else max(0, (_clip(before["cp"]) - _clip(after["cp"])) * sign)

        win_before = win_percent_white(before["cp"])
        win_after = win_percent_white(after["cp"])
        if not mover_white:
            win_before, win_after = 100 - win_before, 100 - win_after
        if is_best:
            win_after = max(win_after, win_before)

        replay.push(move)

        result_moves.append(
            {
                "ply": i + 1,
                "move_number": meta[i]["fullmove"],
                "color": "white" if mover_white else "black",
                "san": san,
                "uci": move.uci(),
                "fen_after": replay.fen(),
                "eval_cp": after["cp"],  # White POV, drives the graph
                "eval_mate": after["mate"],
                "eval_cp_before": before["cp"],
                "eval_mate_before": before["mate"],
                "best_move_san": before["best_san"],
                "best_move_uci": before["best_uci"],
                "is_best": is_best,
                "cp_loss": cp_loss,
                "accuracy": round(move_accuracy(win_before, win_after), 1),
                "judgment": _judgment(cp_loss),
                "phase": meta[i]["phase"],
            }
        )

    return {
        "engine_name": engine_name,
        "engine_depth": depth,
        "moves": result_moves,
        **aggregate(result_moves),
    }


def aggregate(moves: list[dict]) -> dict:
    """Per-colour accuracy, ACPL, judgment counts and phase breakdown."""
    out: dict = {
        "accuracy_white": None,
        "accuracy_black": None,
        "acpl_white": None,
        "acpl_black": None,
        "judgment_counts": {},
        "phase_stats": {},
    }
    for color in ("white", "black"):
        side = [m for m in moves if m["color"] == color]
        if not side:
            continue
        out[f"accuracy_{color}"] = round(sum(m["accuracy"] for m in side) / len(side), 1)
        out[f"acpl_{color}"] = round(sum(m["cp_loss"] for m in side) / len(side), 1)
        out["judgment_counts"][color] = {
            j: sum(1 for m in side if m["judgment"] == j)
            for j in ("inaccuracy", "mistake", "blunder")
        }
        phases: dict = {}
        for phase in ("opening", "middlegame", "endgame"):
            in_phase = [m for m in side if m["phase"] == phase]
            if in_phase:
                phases[phase] = {
                    "moves": len(in_phase),
                    "acpl": round(sum(m["cp_loss"] for m in in_phase) / len(in_phase), 1),
                    "accuracy": round(sum(m["accuracy"] for m in in_phase) / len(in_phase), 1),
                }
        out["phase_stats"][color] = phases
    return out
