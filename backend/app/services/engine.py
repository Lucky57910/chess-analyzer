"""Stockfish driver: turns a PGN into a per-ply evaluation curve.

One engine process is kept alive and reused across games; it is guarded by a
lock because the analysis worker is the usual caller but the /refresh route can
race with it.
"""

from __future__ import annotations

import io
import logging
import math
import statistics
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

# Accuracy aggregation (Lichess model). The window slides over the win% curve
# and its standard deviation becomes the weight of the move played inside it.
ACCURACY_WINDOW_MIN = 2
ACCURACY_WINDOW_MAX = 8
WEIGHT_MIN = 0.5
WEIGHT_MAX = 12.0
HARMONIC_FLOOR = 0.5

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


def _evaluate(eng, board: chess.Board, limit: chess.engine.Limit, token: object) -> dict:
    """One engine call, folded into the shape the rest of the module expects.

    `token` identifies the game: python-chess sends `ucinewgame` whenever it
    changes, so the transposition table is shared across the positions of one
    game - which is what makes the sweep cheap - and cleared between games,
    which keeps a re-analysis of the same game reproducible.
    """
    info = eng.analyse(board, limit, game=token)
    score = info["score"].white()
    pv = info.get("pv") or []
    best = pv[0] if pv else None
    return {
        "cp": score.score(mate_score=MATE_CP),
        "mate": score.mate(),
        "best_uci": best.uci() if best else None,
        "best_san": board.san(best) if best else None,
        "depth": info.get("depth"),
    }


def _deep_targets(positions: list[dict]) -> list[int]:
    """Positions the shallow pass says are worth a real search.

    Wherever the evaluation moves by more than the threshold, that pair and its
    neighbours are queued for the deep pass. Targets come out as contiguous
    runs on purpose: accuracy compares consecutive positions, so both ends of
    a comparison must have been searched to the same depth or the difference in
    search alone shows up as a mistake. Only the edge of a run straddles two
    depths, and an edge sits in a stretch quiet enough not to have been flagged.

    No exemption for opening moves: the shallow pass covers them for almost
    nothing, and a quiet opening simply never trips the threshold, while a real
    early blunder still gets its deep search.
    """
    window = settings.engine_deep_window
    flagged: set[int] = set()
    for i in range(1, len(positions)):
        drift = abs(_clip(positions[i]["cp"]) - _clip(positions[i - 1]["cp"]))
        if drift >= settings.engine_deep_threshold_cp:
            flagged.update(range(max(0, i - window), min(len(positions), i + window + 1)))
    return sorted(flagged)


def analyse_pgn(pgn: str, depth: int | None = None) -> dict:
    """Evaluate every position of the game, then derive per-move stats.

    Two passes. A cheap one sweeps every position, then the expensive one
    revisits only the positions where the cheap one saw the evaluation move.
    Quiet positions are quiet at any depth, so paying full price for them buys
    nothing; spending that budget on the sharp ones is what makes a depth the
    free tier could never afford everywhere affordable at all.

    Position i is evaluated once per pass: its eval is the "before" of move i
    and the "after" of move i-1, so the sweep costs N+1 engine calls.
    """
    depth = depth or settings.engine_depth
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        raise ValueError("Unreadable PGN")

    start = game.board()
    moves = list(game.mainline_moves())[: settings.max_plies]
    if not moves:
        raise ValueError("PGN contains no moves")

    scan_limit = chess.engine.Limit(depth=min(settings.engine_scan_depth, depth))
    deep_limit = chess.engine.Limit(depth=depth, time=settings.engine_max_time)

    with _engine_lock:
        eng = _open_engine()
        engine_name = eng.id.get("name", "stockfish")

        fens: list[str] = []
        meta: list[dict] = []
        cursor = chess.Board(start.fen())
        for ply in range(len(moves) + 1):
            fens.append(cursor.fen())
            meta.append({"phase": _phase(cursor), "fullmove": cursor.fullmove_number})
            if ply < len(moves):
                cursor.push(moves[ply])

        token = object()
        positions = [_evaluate(eng, chess.Board(fen), scan_limit, token) for fen in fens]

        targets = _deep_targets(positions)
        for index in targets:
            positions[index] = _evaluate(eng, chess.Board(fens[index]), deep_limit, token)

    # Only the deepened positions are expected to reach `depth`; the rest are
    # meant to sit at the scan depth.
    truncated = [positions[i]["depth"] for i in targets if (positions[i]["depth"] or depth) < depth]
    if truncated and len(truncated) > len(targets) / 2:
        log.warning(
            "deep pass hit the time cap on %s/%s positions (reached depth %s, wanted %s); "
            "raise ENGINE_MAX_TIME or lower ENGINE_DEPTH",
            len(truncated), len(targets), min(truncated), depth,
        )

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
                # No FEN here: the client replays the PGN it already holds.
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
        # The requested depth, not the reached one: staleness is measured
        # against it, and a time cap that always bites would otherwise queue
        # the same game forever.
        "engine_depth": depth,
        "deep_positions": len(targets),
        "scanned_positions": len(positions),
        "moves": result_moves,
        **aggregate(result_moves),
    }


def _position_win_percents(moves: list[dict]) -> list[float]:
    """White-POV win% for every position of the game, starting position included."""
    if not moves:
        return []
    opening = moves[0].get("eval_cp_before")
    series = [win_percent_white(opening if opening is not None else 0)]
    series += [win_percent_white(m["eval_cp"] if m["eval_cp"] is not None else 0) for m in moves]
    return series


def _volatility_weights(win_percents: list[float]) -> list[float]:
    """How much each move counts, from how sharp the position was around it.

    A slip in a knife-edge position matters more than one in a settled endgame,
    so every move is weighted by the standard deviation of the win% inside a
    sliding window. The first window is repeated to cover the opening moves,
    which have no history behind them.
    """
    n = len(win_percents)
    if n < 2:
        return [WEIGHT_MIN] * n
    size = max(ACCURACY_WINDOW_MIN, min(ACCURACY_WINDOW_MAX, n // 10))
    if n <= size:
        windows = [win_percents] * n
    else:
        windows = [win_percents[:size]] * (size - 1)
        windows += [win_percents[i : i + size] for i in range(n - size + 1)]
    return [max(WEIGHT_MIN, min(WEIGHT_MAX, statistics.pstdev(w))) for w in windows]


def _blend_accuracy(pairs: list[tuple[float, float]]) -> float | None:
    """Lichess' game accuracy: the mean of a weighted mean and a harmonic mean.

    The plain arithmetic mean we used before let two blunders hide behind forty
    quiet moves, which is why our numbers read ~15 points above Chess.com's. The
    harmonic half punishes a single terrible move the way a human reviewer does.
    """
    if not pairs:
        return None
    total_weight = sum(weight for _, weight in pairs)
    weighted = (
        sum(acc * weight for acc, weight in pairs) / total_weight
        if total_weight
        else sum(acc for acc, _ in pairs) / len(pairs)
    )
    # One exact zero would drag the harmonic mean to zero and swallow the whole
    # game, so the per-move values are floored just above it.
    harmonic = len(pairs) / sum(1 / max(acc, HARMONIC_FLOOR) for acc, _ in pairs)
    return round(max(0.0, min(100.0, (weighted + harmonic) / 2)), 1)


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
    weights = _volatility_weights(_position_win_percents(moves))
    for color in ("white", "black"):
        side = [m for m in moves if m["color"] == color]
        if not side:
            continue
        out[f"accuracy_{color}"] = _blend_accuracy(
            [(m["accuracy"], w) for m, w in zip(moves, weights) if m["color"] == color]
        )
        out[f"acpl_{color}"] = round(sum(m["cp_loss"] for m in side) / len(side), 1)
        out["judgment_counts"][color] = {
            j: sum(1 for m in side if m["judgment"] == j)
            for j in ("inaccuracy", "mistake", "blunder")
        }
        phases: dict = {}
        for phase in ("opening", "middlegame", "endgame"):
            in_phase = [m for m in side if m["phase"] == phase]
            if in_phase:
                in_phase_plies = {m["ply"] for m in in_phase}
                phases[phase] = {
                    "moves": len(in_phase),
                    "acpl": round(sum(m["cp_loss"] for m in in_phase) / len(in_phase), 1),
                    "accuracy": _blend_accuracy(
                        [
                            (m["accuracy"], w)
                            for m, w in zip(moves, weights)
                            if m["ply"] in in_phase_plies
                        ]
                    ),
                }
        out["phase_stats"][color] = phases
    return out
