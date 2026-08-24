"""Orchestration: pull games from Chess.com, feed pending ones to Stockfish."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import Analysis, Game, User
from app.services import chess_com, engine

log = logging.getLogger(__name__)

MAX_ANALYSIS_ATTEMPTS = 3


def sync_user_games(db: Session, user: User, months: int | None = None) -> int:
    """Import new games for one user. Returns how many were inserted.

    `months` = None polls only the current month (the cheap 15s path);
    an int pulls that many recent archives (the catch-up path after a login).
    """
    if not user.chess_com_username:
        return 0

    if months is None:
        raw_games = chess_com.fetch_current_month(user.chess_com_username)
    else:
        raw_games = chess_com.fetch_recent_months(user.chess_com_username, months)

    known = {
        chess_com_id: (row_id, accuracy)
        for row_id, chess_com_id, accuracy in db.execute(
            select(Game.id, Game.chess_com_game_id, Game.chess_com_accuracy).where(
                Game.user_id == user.id
            )
        ).all()
    }

    inserted = 0
    newest = user.last_game_end_time
    for raw in raw_games:
        data = chess_com.normalize_game(raw, user.chess_com_username)
        if data is None:
            continue
        chess_com_id = data["chess_com_game_id"]
        if chess_com_id in known:
            # Chess.com only fills the accuracy in once the game has been
            # reviewed on their side, which often happens after the import.
            row_id, stored = known[chess_com_id]
            if stored is None and data["chess_com_accuracy"] is not None:
                db.execute(
                    update(Game)
                    .where(Game.id == row_id)
                    .values(chess_com_accuracy=data["chess_com_accuracy"])
                )
            continue
        db.add(Game(user_id=user.id, **data))
        known[chess_com_id] = (None, data["chess_com_accuracy"])
        newest = max(newest, data["end_time"])
        inserted += 1

    user.last_synced_at = datetime.now(timezone.utc)
    user.last_game_end_time = newest
    try:
        db.commit()
    except IntegrityError:  # concurrent poll won the race
        db.rollback()
        return 0
    return inserted


def sync_all_users(db: Session) -> int:
    total = 0
    users = db.scalars(select(User).where(User.chess_com_username.is_not(None))).all()
    for user in users:
        try:
            total += sync_user_games(db, user)
        except Exception as exc:  # one bad user must not stall the poller
            log.warning("sync failed for user %s: %s", user.username, exc)
            db.rollback()
    return total


def next_pending_game(db: Session) -> Game | None:
    return db.scalars(
        select(Game)
        .where(Game.analysis_status == "pending")
        .where(Game.analysis_attempts < MAX_ANALYSIS_ATTEMPTS)
        .order_by(Game.end_time.desc())
        .limit(1)
    ).first()


def analyse_game(db: Session, game: Game) -> Analysis | None:
    """Run Stockfish over one game and persist the result."""
    game.analysis_status = "running"
    game.analysis_attempts += 1
    db.commit()

    try:
        result = engine.analyse_pgn(game.pgn)
    except engine.EngineUnavailable as exc:
        # Not the game's fault: leave it pending and do not burn an attempt.
        game.analysis_status = "pending"
        game.analysis_attempts -= 1
        game.analysis_error = str(exc)
        db.commit()
        raise
    except Exception as exc:
        game.analysis_status = "error"
        game.analysis_error = f"{type(exc).__name__}: {exc}"
        db.commit()
        log.warning("analysis failed for game %s: %s", game.id, exc)
        return None

    moves = result["moves"]
    errors = [m for m in moves if m["judgment"] in ("mistake", "blunder")]
    blunders = [m for m in moves if m["judgment"] == "blunder"]

    analysis = game.analysis or Analysis(game_id=game.id)
    analysis.engine_depth = result["engine_depth"]
    analysis.engine_name = result["engine_name"]
    analysis.moves_evaluated = len(moves)
    analysis.moves = moves
    analysis.errors = errors
    analysis.blunders = blunders
    analysis.accuracy_white = result["accuracy_white"]
    analysis.accuracy_black = result["accuracy_black"]
    analysis.acpl_white = result["acpl_white"]
    analysis.acpl_black = result["acpl_black"]
    analysis.judgment_counts = result["judgment_counts"]
    analysis.phase_stats = result["phase_stats"]
    analysis.updated_at = datetime.now(timezone.utc)

    db.add(analysis)
    game.analysis_status = "done"
    game.analysis_error = None
    db.commit()
    log.info("analysed game %s (%s plies)", game.id, len(moves))
    return analysis


def analyse_next_pending(db: Session) -> bool:
    """Analyse one queued game. Returns True if work was done."""
    game = next_pending_game(db)
    if game is None:
        return False
    try:
        analyse_game(db, game)
    except engine.EngineUnavailable as exc:
        log.error("engine unavailable, analysis paused: %s", exc)
        return False
    return True


def recompute_stored_accuracies(db: Session) -> int:
    """Re-derive stored aggregates from the per-move data already on disk.

    The numbers inside `Analysis.moves` are raw engine output, so changing the
    aggregation model (arithmetic mean -> Lichess weighted/harmonic blend) does
    not need Stockfish to run again. Returns how many rows actually changed.
    """
    changed = 0
    for row in db.scalars(select(Analysis)).all():
        moves = row.moves or []
        if not moves:
            continue
        before = (row.accuracy_white, row.accuracy_black)
        for key, value in engine.aggregate(moves).items():
            setattr(row, key, value)
        if before != (row.accuracy_white, row.accuracy_black):
            changed += 1
    db.commit()
    return changed


def user_facing_accuracy(analysis: Analysis, game: Game) -> float | None:
    return analysis.accuracy_white if game.user_color == "white" else analysis.accuracy_black


def sync_months_default() -> int:
    return settings.sync_months_on_login
