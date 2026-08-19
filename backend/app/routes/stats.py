from __future__ import annotations

from collections import Counter, defaultdict

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db.models import Game, User
from app.db.session import get_db
from app.deps import get_current_user
from app.schemas import StatsOut, TrendPoint

router = APIRouter(prefix="/api/stats", tags=["stats"])

PHASES = ("opening", "middlegame", "endgame")


def _load_games(db: Session, user: User, days: int | None = None) -> list[Game]:
    stmt = (
        select(Game)
        .options(selectinload(Game.analysis))
        .where(Game.user_id == user.id)
        .order_by(Game.end_time.desc())
    )
    games = list(db.scalars(stmt).all())
    if days:
        cutoff = max((g.end_time for g in games), default=0) - days * 86400
        games = [g for g in games if g.end_time >= cutoff]
    return games


def _mine(game: Game):
    """(accuracy, acpl, judgment counts, phase stats) from the user point of view."""
    a = game.analysis
    if a is None:
        return None
    c = game.user_color
    return {
        "accuracy": a.accuracy_white if c == "white" else a.accuracy_black,
        "acpl": a.acpl_white if c == "white" else a.acpl_black,
        "counts": (a.judgment_counts or {}).get(c, {}),
        "phases": (a.phase_stats or {}).get(c, {}),
    }


def _rate(wins: int, draws: int, total: int) -> float:
    if not total:
        return 0.0
    return round(100 * (wins + 0.5 * draws) / total, 1)


def _breakdown(games: list[Game], key) -> list[dict]:
    buckets: dict = defaultdict(list)
    for g in games:
        buckets[key(g) or "unknown"].append(g)
    rows = []
    for name, group in buckets.items():
        wins = sum(1 for g in group if g.result == "win")
        draws = sum(1 for g in group if g.result == "draw")
        accs = [m["accuracy"] for g in group if (m := _mine(g)) and m["accuracy"] is not None]
        rows.append(
            {
                "name": name,
                "games": len(group),
                "wins": wins,
                "draws": draws,
                "losses": len(group) - wins - draws,
                "win_rate": _rate(wins, draws, len(group)),
                "avg_accuracy": round(sum(accs) / len(accs), 1) if accs else None,
            }
        )
    return sorted(rows, key=lambda r: r["games"], reverse=True)


@router.get("", response_model=StatsOut)
def stats(
    days: int | None = Query(None, ge=1, le=3650),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    games = _load_games(db, user, days)
    total = len(games)
    wins = sum(1 for g in games if g.result == "win")
    draws = sum(1 for g in games if g.result == "draw")
    losses = total - wins - draws

    analysed = [(g, m) for g in games if (m := _mine(g)) is not None]
    accs = [m["accuracy"] for _, m in analysed if m["accuracy"] is not None]
    acpls = [m["acpl"] for _, m in analysed if m["acpl"] is not None]

    judgments = Counter()
    for _, m in analysed:
        for k in ("inaccuracy", "mistake", "blunder"):
            judgments[k] += m["counts"].get(k, 0)

    phase_totals: dict[str, list[float]] = {p: [] for p in PHASES}
    for _, m in analysed:
        for phase, data in (m["phases"] or {}).items():
            if phase in phase_totals and data.get("acpl") is not None:
                phase_totals[phase].append(data["acpl"])
    phase_acpl = {
        p: round(sum(v) / len(v), 1) for p, v in phase_totals.items() if v
    }
    weakest = max(phase_acpl, key=phase_acpl.get) if phase_acpl else None

    n = len(analysed) or 1
    return StatsOut(
        games=total,
        analysed=len(analysed),
        wins=wins,
        losses=losses,
        draws=draws,
        win_rate=_rate(wins, draws, total),
        avg_accuracy=round(sum(accs) / len(accs), 1) if accs else None,
        avg_acpl=round(sum(acpls) / len(acpls), 1) if acpls else None,
        blunders_per_game=round(judgments["blunder"] / n, 2) if analysed else None,
        mistakes_per_game=round(judgments["mistake"] / n, 2) if analysed else None,
        inaccuracies_per_game=round(judgments["inaccuracy"] / n, 2) if analysed else None,
        weakest_phase=weakest,
        by_time_class=_breakdown(games, lambda g: g.time_class),
        by_color=_breakdown(games, lambda g: g.user_color),
        top_opponents=_breakdown(games, lambda g: g.opponent_username)[:10],
        top_openings=_breakdown(games, lambda g: g.opening)[:10],
        phase_acpl=phase_acpl,
    )


@router.get("/trends", response_model=list[TrendPoint])
def trends(
    period: str = Query("week", pattern="^(day|week|month)$"),
    limit: int = Query(12, ge=1, le=60),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    games = _load_games(db, user)

    def bucket(game: Game) -> str:
        d = game.played_at
        if period == "day":
            return d.strftime("%Y-%m-%d")
        if period == "month":
            return d.strftime("%Y-%m")
        year, week, _ = d.isocalendar()
        return f"{year}-W{week:02d}"

    grouped: dict[str, list[Game]] = defaultdict(list)
    for g in games:
        grouped[bucket(g)].append(g)

    points: list[TrendPoint] = []
    for key in sorted(grouped)[-limit:]:
        group = grouped[key]
        wins = sum(1 for g in group if g.result == "win")
        draws = sum(1 for g in group if g.result == "draw")
        stats_ = [m for g in group if (m := _mine(g))]
        accs = [m["accuracy"] for m in stats_ if m["accuracy"] is not None]
        acpls = [m["acpl"] for m in stats_ if m["acpl"] is not None]
        points.append(
            TrendPoint(
                period=key,
                games=len(group),
                win_rate=_rate(wins, draws, len(group)),
                avg_accuracy=round(sum(accs) / len(accs), 1) if accs else None,
                avg_acpl=round(sum(acpls) / len(acpls), 1) if acpls else None,
            )
        )
    return points


@router.get("/mistakes")
def mistake_patterns(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Where the damage happens: worst moves and the move numbers they cluster on."""
    games = _load_games(db, user)
    worst: list[dict] = []
    by_move_number: Counter = Counter()

    for game in games:
        if game.analysis is None:
            continue
        for move in game.analysis.errors or []:
            if move["color"] != game.user_color:
                continue
            by_move_number[move["move_number"]] += 1
            worst.append(
                {
                    "game_id": game.id,
                    "played_at": game.played_at,
                    "opponent": game.opponent_username,
                    "move_number": move["move_number"],
                    "ply": move["ply"],
                    "san": move["san"],
                    "best_move_san": move["best_move_san"],
                    "cp_loss": move["cp_loss"],
                    "judgment": move["judgment"],
                    "phase": move["phase"],
                }
            )

    worst.sort(key=lambda m: m["cp_loss"], reverse=True)
    return {
        "worst_moves": worst[:25],
        "by_move_number": [
            {"move_number": k, "count": v} for k, v in sorted(by_move_number.items())
        ],
    }
