"""Freeze the Python data layer into a JSON fixture the JS port must match.

Companion to dump_golden.py, which covers the judgment model. This one covers
what surrounds it: turning a Chess.com archive entry into a row, and turning
rows back into the dashboard numbers.

Two layers:

  * `normalize` - `chess_com.normalize_game` over archive entries chosen for
    their branches, not their realism: both colours, every draw code, a win by
    each termination, a variant and a missing PGN (both rejected), an opening
    that arrives via ECOUrl instead of the Opening header.
  * `stats` - the real `stats()`, `trends()` and `mistake_patterns()` functions
    with `_load_games` stubbed, over a deterministic set of games. These are
    ordinary functions; FastAPI's Depends() defaults only matter when FastAPI
    calls them, so they are called directly here.

The archive entries are synthetic. api.chess.com is unreachable from this
machine (the corporate proxy blocks it), and it would not help anyway: the
fixture's job is to pin what the Python does with a given input, not to prove
the input was real.

Run from `backend/`:

    .venv/Scripts/python.exe scripts/dump_data_golden.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routes import stats as stats_module
from app.services import chess_com

OUT = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "data"
    / "__fixtures__"
    / "golden-data.json"
)

ME = "maxime"

PGN_WITH_OPENING = """[Event "Live Chess"]
[White "maxime"]
[Black "rival"]
[Result "1-0"]
[ECO "B90"]
[ECOUrl "https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation"]

1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 1-0
"""

PGN_NAMED_OPENING = """[Event "Live Chess"]
[White "rival"]
[Black "maxime"]
[Result "0-1"]
[ECO "C50"]
[Opening "Italian Game"]

1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 0-1
"""

PGN_BARE = """[Event "Live Chess"]
[White "maxime"]
[Black "rival"]
[Result "1/2-1/2"]

1.d4 d5 1/2-1/2
"""


def entry(**overrides) -> dict:
    """An archive entry with the shape Chess.com returns."""
    base = {
        "uuid": "uuid-1",
        "url": "https://www.chess.com/game/live/1",
        "pgn": PGN_WITH_OPENING,
        "rules": "chess",
        "time_class": "blitz",
        "time_control": "300",
        "rated": True,
        "end_time": 1_756_000_000,
        "white": {"username": "maxime", "rating": 1400, "result": "win"},
        "black": {"username": "rival", "rating": 1380, "result": "resigned"},
    }
    base.update(overrides)
    return base


NORMALIZE_CASES = {
    "win_as_white": entry(),
    "loss_as_black": entry(
        uuid="uuid-2",
        pgn=PGN_NAMED_OPENING,
        white={"username": "rival", "rating": 1500, "result": "win"},
        black={"username": "MAXIME", "rating": 1450, "result": "checkmated"},
    ),
    # Every code in DRAW_RESULTS has to land on "draw", and the mirrored code on
    # the other side must not be mistaken for a termination.
    **{
        f"draw_{code}": entry(
            uuid=f"uuid-draw-{code}",
            pgn=PGN_BARE,
            white={"username": "maxime", "rating": 1400, "result": code},
            black={"username": "rival", "rating": 1400, "result": code},
        )
        for code in sorted(chess_com.DRAW_RESULTS)
    },
    "win_on_time": entry(
        uuid="uuid-3",
        white={"username": "maxime", "rating": 1400, "result": "win"},
        black={"username": "rival", "rating": 1380, "result": "timeout"},
    ),
    "loss_on_abandonment": entry(
        uuid="uuid-4",
        white={"username": "maxime", "rating": 1400, "result": "abandoned"},
        black={"username": "rival", "rating": 1380, "result": "win"},
    ),
    "with_accuracies": entry(
        uuid="uuid-5",
        accuracies={"white": 87.34, "black": 71.02},
    ),
    "unrated": entry(uuid="uuid-6", rated=False),
    # The opening arrives as a slug in ECOUrl when there is no Opening header.
    "opening_from_eco_url": entry(uuid="uuid-7", pgn=PGN_WITH_OPENING),
    "opening_from_header": entry(
        uuid="uuid-8",
        pgn=PGN_NAMED_OPENING,
        white={"username": "rival", "rating": 1500, "result": "win"},
        black={"username": "maxime", "rating": 1450, "result": "resigned"},
    ),
    "no_opening_at_all": entry(uuid="uuid-9", pgn=PGN_BARE),
    "missing_uuid_falls_back_to_url": entry(uuid=None),
    "chess960_is_rejected": entry(uuid="uuid-10", rules="chess960"),
    "missing_pgn_is_rejected": entry(uuid="uuid-11", pgn=None),
    "other_player_is_rejected": entry(
        uuid="uuid-12",
        white={"username": "someone", "rating": 1400, "result": "win"},
        black={"username": "else", "rating": 1380, "result": "resigned"},
    ),
    "missing_ratings": entry(
        uuid="uuid-13",
        white={"username": "maxime", "result": "win"},
        black={"username": "rival", "result": "resigned"},
    ),
}


def make_game(index: int, **overrides):
    """A Game/Analysis pair shaped the way the stats functions read them."""
    seed = (index * 1103515245 + 12345) % (2**31)
    r = seed / (2**31)
    color = "white" if index % 2 == 0 else "black"
    result = ("win", "loss", "draw")[index % 3]

    analysis = SimpleNamespace(
        accuracy_white=round(60 + r * 39, 1),
        accuracy_black=round(55 + (1 - r) * 40, 1),
        acpl_white=round(10 + r * 90, 1),
        acpl_black=round(15 + (1 - r) * 80, 1),
        judgment_counts={
            "white": {"inaccuracy": index % 4, "mistake": index % 3, "blunder": index % 2},
            "black": {"inaccuracy": index % 3, "mistake": index % 2, "blunder": index % 5},
        },
        phase_stats={
            side: {
                "opening": {"moves": 12, "acpl": round(5 + r * 20, 1), "accuracy": 90.0},
                "middlegame": {"moves": 20, "acpl": round(30 + r * 60, 1), "accuracy": 70.0},
                "endgame": {"moves": 8, "acpl": round(15 + r * 30, 1), "accuracy": 80.0},
            }
            for side in ("white", "black")
        },
        errors=[
            {
                "ply": 21,
                "move_number": 11 + (index % 7),
                "color": color,
                "san": "Nf3",
                "best_move_san": "Bb5",
                "cp_loss": 120 + index * 13,
                "judgment": "mistake",
                "phase": "middlegame",
            },
            {
                "ply": 30,
                "move_number": 15 + (index % 5),
                "color": "black" if color == "white" else "white",
                "san": "Qh4",
                "best_move_san": "Qe7",
                "cp_loss": 400 + index * 7,
                "judgment": "blunder",
                "phase": "middlegame",
            },
        ],
    )

    end_time = 1_756_000_000 - index * 86_400 * 3
    game = SimpleNamespace(
        id=index + 1,
        user_color=color,
        result=result,
        time_class=("blitz", "rapid", "bullet")[index % 3],
        opponent_username=f"rival{index % 4}",
        opening=("Sicilian Defense", "Italian Game", None)[index % 3],
        end_time=end_time,
        played_at=datetime.fromtimestamp(end_time, tz=timezone.utc),
        analysis=analysis,
    )
    for key, value in overrides.items():
        setattr(game, key, value)
    return game


def build_stats_cases() -> list[dict]:
    unanalysed = make_game(3)
    unanalysed.analysis = None

    populations = {
        "empty": [],
        "single_game": [make_game(0)],
        "mixed_20": [make_game(i) for i in range(20)],
        # A population where some games were never analysed exercises every
        # `if analysis is None` branch and the divide-by-len guards.
        "with_unanalysed": [make_game(0), unanalysed, make_game(1), make_game(2)],
    }

    original = stats_module._load_games
    cases = []
    try:
        for name, games in populations.items():
            stats_module._load_games = lambda db, user, days=None, _g=games: (
                [g for g in _g if days is None or g.end_time >= max((x.end_time for x in _g), default=0) - days * 86400]
            )
            user = SimpleNamespace(id=1)
            case = {
                "name": name,
                "games": [
                    {
                        "id": g.id,
                        "user_color": g.user_color,
                        "result": g.result,
                        "time_class": g.time_class,
                        "opponent_username": g.opponent_username,
                        "opening": g.opening,
                        "end_time": g.end_time,
                        "played_at": g.played_at.isoformat(),
                        "analysis": None
                        if g.analysis is None
                        else {
                            "accuracy_white": g.analysis.accuracy_white,
                            "accuracy_black": g.analysis.accuracy_black,
                            "acpl_white": g.analysis.acpl_white,
                            "acpl_black": g.analysis.acpl_black,
                            "judgment_counts": g.analysis.judgment_counts,
                            "phase_stats": g.analysis.phase_stats,
                            "errors": g.analysis.errors,
                        },
                    }
                    for g in games
                ],
                "stats": stats_module.stats(days=None, user=user, db=None).model_dump(),
                "trends": {
                    period: [
                        p.model_dump()
                        for p in stats_module.trends(
                            period=period, limit=12, user=user, db=None
                        )
                    ]
                    for period in ("day", "week", "month")
                },
                "mistakes": stats_module.mistake_patterns(user=user, db=None),
            }
            # played_at is a datetime inside mistake_patterns; make it comparable.
            for row in case["mistakes"]["worst_moves"]:
                row["played_at"] = row["played_at"].isoformat()
            cases.append(case)
    finally:
        stats_module._load_games = original
    return cases


def main() -> None:
    payload = {
        "_readme": (
            "Generated by backend/scripts/dump_data_golden.py from "
            "app/services/chess_com.py and app/routes/stats.py. The JS port in "
            "src/data/ must reproduce every value here. Do not hand-edit."
        ),
        "draw_results": sorted(chess_com.DRAW_RESULTS),
        "normalize": [
            {"name": name, "raw": raw, "out": chess_com.normalize_game(raw, ME)}
            for name, raw in NORMALIZE_CASES.items()
        ],
        "stats": build_stats_cases(),
    }

    # normalize_game returns a datetime for played_at; JSON needs a string, and
    # the JS side stores an ISO string anyway.
    for case in payload["normalize"]:
        if case["out"] and isinstance(case["out"].get("played_at"), datetime):
            case["out"]["played_at"] = case["out"]["played_at"].isoformat()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")

    rejected = sum(1 for c in payload["normalize"] if c["out"] is None)
    print(f"wrote {OUT}")
    print(f"  {len(payload['normalize'])} normalize cases ({rejected} rejected)")
    print(f"  {len(payload['stats'])} stats populations")


if __name__ == "__main__":
    main()
