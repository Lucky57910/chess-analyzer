"""Freeze the Python scoring model into a JSON fixture the JS port must match.

The judgment/accuracy model lives in `app.services.engine` and is being ported
to JavaScript for the Android app. A port of 400 lines of floating-point maths
needs an oracle, and Chess.com's own accuracy is not one: it comes from CAPS2,
a different model, so it can tell you a number looks plausible but never that
`move_accuracy` was transcribed correctly.

So the oracle is this file's output. It records three layers:

  * `pure`     - the stateless functions, over grids that include the edges
                 (mate scores, the clip boundary, exact .x5 rounding ties).
  * `pipeline` - `_deep_targets`, `_volatility_weights`, `_blend_accuracy` and
                 `aggregate` over synthetic move lists, including the degenerate
                 short ones where the sliding window collapses.
  * `games`    - two real games run through `analyse_pgn` end to end, with every
                 engine call recorded in order. The JS test replays those
                 recordings instead of running Stockfish, so it re-derives the
                 whole result - deep-pass selection included - with no engine
                 and no nondeterminism.

Run from `backend/`:

    .venv/Scripts/python.exe scripts/dump_golden.py

The generated JSON is committed. Once the backend is deleted this script goes
with it and the fixture stays: it is the frozen reference, not a derived file.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import chess
import chess.pgn

from app.config import settings
from app.services import engine

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "engine" / "__fixtures__" / "golden.json"

# The Opera Game: sacrifices, a forced mate, and a sharp enough eval curve to
# put a good number of positions through the deep pass. The second is four
# moves long, which is the case where the accuracy window is larger than the
# game and every branch guarding against that has to fire.
GAMES = {
    "opera": """[Event "Paris"]
[White "Morphy, Paul"]
[Black "Duke Karl"]
[Result "1-0"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0
""",
    "scholars_mate": """[Event "Casual"]
[White "Rival"]
[Black "Maxime"]
[Result "1-0"]

1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7# 1-0
""",
}

# Includes both sides of every threshold, the clip boundary, and the mate score
# the engine actually reports.
CP_GRID = [
    -engine.MATE_CP, -9999, -5000, -1001, -1000, -999, -700, -300, -299, -150,
    -101, -100, -99, -51, -50, -49, -1, 0, 1, 49, 50, 51, 99, 100, 101, 150,
    299, 300, 700, 999, 1000, 1001, 5000, 9999, engine.MATE_CP,
]

WIN_PAIRS = [
    (a, b)
    for a in (0.0, 0.5, 12.5, 25.0, 49.9, 50.0, 62.5, 75.0, 87.5, 99.5, 100.0)
    for b in (0.0, 12.5, 37.5, 50.0, 50.5, 75.0, 100.0)
]

# round(x, 1) is banker's rounding in Python and half-up in JS, and an ACPL is
# a sum of integers over a count, so exact .x5 ties are routine rather than
# exotic. Every one of these is a real divergence if the port uses Math.round.
ROUND_CASES = [
    0.0, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95,
    1.25, 2.25, 2.35, 12.25, 12.35, 49.05, 87.65, 99.95, 100.0,
    -0.05, -0.25, -12.25, 33.333333, 66.666666, 1e-9,
]


def _sequence(n: int, seed: int) -> list[float]:
    """Deterministic pseudo-random win% series - no `random`, so no seed drift
    between Python versions."""
    out = []
    x = seed
    for _ in range(n):
        x = (x * 1103515245 + 12345) % (2**31)
        out.append(round(x / (2**31) * 100, 4))
    return out


def _synthetic_moves(n: int, seed: int) -> list[dict]:
    """A move list shaped exactly like `analyse_pgn` emits, for `aggregate`."""
    moves = []
    x = seed
    for i in range(n):
        x = (x * 1103515245 + 12345) % (2**31)
        r = x / (2**31)
        cp_loss = int(r * 420)
        cp = int((r - 0.5) * 1800)
        moves.append(
            {
                "ply": i + 1,
                "move_number": i // 2 + 1,
                "color": "white" if i % 2 == 0 else "black",
                "san": f"m{i}",
                "uci": "e2e4",
                "eval_cp": cp,
                "eval_mate": None,
                "eval_cp_before": cp - cp_loss,
                "eval_mate_before": None,
                "best_move_san": "Nf3",
                "best_move_uci": "g1f3",
                "is_best": cp_loss == 0,
                "cp_loss": cp_loss,
                "accuracy": round(
                    engine.move_accuracy(
                        engine.win_percent_white(cp - cp_loss), engine.win_percent_white(cp)
                    ),
                    1,
                ),
                "judgment": engine._judgment(cp_loss),
                "phase": ("opening", "middlegame", "endgame")[min(2, i // 12)],
            }
        )
    return moves


def _record_game(pgn: str) -> dict:
    """Run `analyse_pgn` for real, taping every engine call in call order.

    The tape is what makes the JS test hermetic: it replays these answers
    through the JS orchestrator, which therefore has to pick the same deep-pass
    targets and pair the same positions to land on the same result.
    """
    calls: list[dict] = []
    original = engine._evaluate

    def taped(eng, board, limit, token):
        result = original(eng, board, limit, token)
        calls.append(
            {
                "fen": board.fen(),
                "limit_depth": limit.depth,
                "limit_time": limit.time,
                "result": result,
            }
        )
        return result

    engine._evaluate = taped
    try:
        result = engine.analyse_pgn(pgn)
    finally:
        engine._evaluate = original

    game = chess.pgn.read_game(io.StringIO(pgn))
    return {
        "pgn": pgn,
        "settings": {
            "engine_depth": settings.engine_depth,
            "engine_scan_depth": settings.engine_scan_depth,
            "engine_deep_threshold_cp": settings.engine_deep_threshold_cp,
            "engine_deep_window": settings.engine_deep_window,
            "engine_max_time": settings.engine_max_time,
            "max_plies": settings.max_plies,
        },
        "calls": calls,
        "expected": result,
        "start_fen": game.board().fen(),
    }


def main() -> None:
    positions_cases = [
        [{"cp": cp} for cp in seq]
        for seq in (
            [],
            [0],
            [0, 0],
            [0, 149, 298],
            [0, 150, 300],
            [0, 20, 40, 60, 400, 410, 420, 100, 90],
            [0, -200, 0, 200, 0, -200, 0],
            [10000, -10000, 10000],
            [0, 1000, 1001, 2000, -5000],
        )
    ]

    payload = {
        "_readme": (
            "Generated by backend/scripts/dump_golden.py from the Python "
            "implementation in app/services/engine.py. The JS port in "
            "src/engine/ must reproduce every value here exactly. Do not "
            "hand-edit: regenerate, and if a number moves, that is a "
            "behaviour change and needs saying out loud."
        ),
        "constants": {
            "MATE_CP": engine.MATE_CP,
            "CLIP_CP": engine.CLIP_CP,
            "INACCURACY_CP": engine.INACCURACY_CP,
            "MISTAKE_CP": engine.MISTAKE_CP,
            "BLUNDER_CP": engine.BLUNDER_CP,
            "ACCURACY_WINDOW_MIN": engine.ACCURACY_WINDOW_MIN,
            "ACCURACY_WINDOW_MAX": engine.ACCURACY_WINDOW_MAX,
            "WEIGHT_MIN": engine.WEIGHT_MIN,
            "WEIGHT_MAX": engine.WEIGHT_MAX,
            "HARMONIC_FLOOR": engine.HARMONIC_FLOOR,
        },
        "pure": {
            "clip": [{"cp": cp, "out": engine._clip(cp)} for cp in CP_GRID],
            "win_percent_white": [
                {"cp": cp, "out": engine.win_percent_white(cp)} for cp in CP_GRID
            ],
            "move_accuracy": [
                {"before": a, "after": b, "out": engine.move_accuracy(a, b)}
                for a, b in WIN_PAIRS
            ],
            "judgment": [
                {"cp_loss": v, "out": engine._judgment(v)}
                for v in (0, 1, 49, 50, 51, 99, 100, 101, 299, 300, 301, 1000, 9999)
            ],
            "round1": [{"value": v, "out": round(v, 1)} for v in ROUND_CASES],
        },
        "pipeline": {
            "deep_targets": [
                {"positions": case, "out": engine._deep_targets(case)}
                for case in positions_cases
            ],
            "volatility_weights": [
                {"win_percents": seq, "out": engine._volatility_weights(seq)}
                for seq in (
                    [],
                    [50.0],
                    [50.0, 60.0],
                    _sequence(3, 7),
                    _sequence(5, 11),
                    _sequence(9, 13),
                    _sequence(10, 17),
                    _sequence(11, 19),
                    _sequence(21, 23),
                    _sequence(41, 29),
                    _sequence(80, 31),
                    _sequence(200, 37),
                )
            ],
            "blend_accuracy": [
                {"pairs": pairs, "out": engine._blend_accuracy(pairs)}
                for pairs in (
                    [],
                    [(100.0, 1.0)],
                    [(0.0, 1.0)],
                    [(0.0, 0.0), (100.0, 0.0)],
                    [(95.0, 0.5), (12.0, 12.0), (88.0, 3.25)],
                    [(100.0, 1.0)] * 40 + [(0.0, 1.0)],
                    [(50.0, 2.0), (50.0, 2.0), (50.0, 2.0)],
                )
            ],
            "aggregate": [
                {"moves": moves, "out": engine.aggregate(moves)}
                for moves in (
                    [],
                    _synthetic_moves(1, 41),
                    _synthetic_moves(2, 43),
                    _synthetic_moves(7, 47),
                    _synthetic_moves(24, 53),
                    _synthetic_moves(61, 59),
                    _synthetic_moves(120, 61),
                )
            ],
        },
        "games": {name: _record_game(pgn) for name, pgn in GAMES.items()},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")

    total = sum(len(g["calls"]) for g in payload["games"].values())
    print(f"wrote {OUT}")
    print(f"  {len(payload['pure']['win_percent_white'])} win% cases")
    print(f"  {len(payload['pipeline']['aggregate'])} aggregate cases")
    print(f"  {len(payload['games'])} games, {total} taped engine calls")


if __name__ == "__main__":
    main()
