from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import Analysis, Game, User
from app.db.session import SessionLocal, get_db
from app.deps import get_current_user
from app.schemas import AnalysisOut, GameDetailOut, GameOut, SyncResponse
from app.services import analysis as analysis_service

router = APIRouter(prefix="/api", tags=["games"])


def _serialize(game: Game, detail: bool = False):
    model = GameDetailOut if detail else GameOut
    out = model.model_validate(game)
    a = game.analysis
    if a is not None:
        color = game.user_color
        out.accuracy = a.accuracy_white if color == "white" else a.accuracy_black
        out.acpl = a.acpl_white if color == "white" else a.acpl_black
        counts = (a.judgment_counts or {}).get(color, {})
        out.inaccuracies = counts.get("inaccuracy")
        out.mistakes = counts.get("mistake")
        out.blunders = counts.get("blunder")
    return out


def _owned_game(game_id: int, user: User, db: Session) -> Game:
    game = db.get(Game, game_id)
    if game is None or game.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found")
    return game


@router.get("/games", response_model=list[GameOut])
def list_games(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    result: str | None = Query(None, pattern="^(win|loss|draw)$"),
    time_class: str | None = None,
    color: str | None = Query(None, pattern="^(white|black)$"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Game).where(Game.user_id == user.id)
    if result:
        stmt = stmt.where(Game.result == result)
    if time_class:
        stmt = stmt.where(Game.time_class == time_class)
    if color:
        stmt = stmt.where(Game.user_color == color)
    stmt = stmt.order_by(Game.end_time.desc()).offset(offset).limit(limit)
    return [_serialize(g) for g in db.scalars(stmt).all()]


@router.get("/games/{game_id}", response_model=GameDetailOut)
def get_game(game_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _serialize(_owned_game(game_id, user, db), detail=True)


# Rows analysed before the payload was slimmed still carry this per move.
STALE_MOVE_FIELDS = ("fen_after",)


@router.get("/games/{game_id}/analysis", response_model=AnalysisOut)
def get_analysis(
    game_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    game = _owned_game(game_id, user, db)
    if game.analysis is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"No analysis yet (status: {game.analysis_status})",
        )
    out = AnalysisOut.model_validate(game.analysis)
    out.moves = [
        {k: v for k, v in move.items() if k not in STALE_MOVE_FIELDS} for move in out.moves
    ]
    return out


@router.post("/games/{game_id}/refresh", response_model=GameDetailOut)
def refresh_analysis(
    game_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Re-queue a game; the worker picks it up on its next tick."""
    game = _owned_game(game_id, user, db)
    game.analysis_status = "pending"
    game.analysis_error = None
    game.analysis_attempts = 0
    db.commit()
    return _serialize(game, detail=True)


def _sync_task(user_id: int, months: int) -> None:
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        if user:
            analysis_service.sync_user_games(db, user, months=months)
    finally:
        db.close()


@router.post("/sync", response_model=SyncResponse)
def sync_now(
    tasks: BackgroundTasks,
    months: int = Query(1, ge=1, le=24),
    background: bool = Query(False, description="Return immediately and import in the background"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not user.chess_com_username:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Set your Chess.com username first")

    if background:
        tasks.add_task(_sync_task, user.id, months)
        imported = 0
    else:
        imported = analysis_service.sync_user_games(db, user, months=months)

    pending = db.scalar(
        select(func.count(Game.id))
        .where(Game.user_id == user.id)
        .where(Game.analysis_status.in_(("pending", "running")))
    )
    return SyncResponse(
        imported=imported,
        pending_analysis=pending or 0,
        chess_com_username=user.chess_com_username,
    )


@router.get("/sync/status")
def sync_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Game.analysis_status, func.count(Game.id))
        .where(Game.user_id == user.id)
        .group_by(Game.analysis_status)
    ).all()
    counts = {status_: count for status_, count in rows}
    return {
        "last_synced_at": user.last_synced_at,
        "chess_com_username": user.chess_com_username,
        "total": sum(counts.values()),
        "pending": counts.get("pending", 0),
        "running": counts.get("running", 0),
        "done": counts.get("done", 0),
        "error": counts.get("error", 0),
        "poll_interval_seconds": settings.poll_interval_seconds,
    }


@router.delete("/games/{game_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_game(
    game_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    db.delete(_owned_game(game_id, user, db))
    db.commit()


@router.get("/analyses/count")
def analyses_count(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    total = db.scalar(
        select(func.count(Analysis.id)).join(Game).where(Game.user_id == user.id)
    )
    return {"analysed": total or 0}
