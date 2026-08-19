from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import create_access_token, hash_password, verify_password
from app.db.models import User
from app.db.session import SessionLocal, get_db
from app.deps import get_current_user
from app.schemas import LoginRequest, RegisterRequest, TokenResponse, UpdateMeRequest, UserOut
from app.services import analysis, chess_com

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


def catch_up_sync(user_id: int) -> None:
    """Backfill recent months after a login.

    On a free-tier host the instance sleeps, so the 15s poller misses games.
    Every login pulls the last few archives to close that gap.
    """
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        if user and user.chess_com_username:
            count = analysis.sync_user_games(db, user, months=settings.sync_months_on_login)
            if count:
                log.info("catch-up sync imported %s game(s) for %s", count, user.username)
    except Exception as exc:
        log.warning("catch-up sync failed: %s", exc)
    finally:
        db.close()


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if settings.registration_code and payload.registration_code != settings.registration_code:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid registration code")

    username = payload.username.strip().lower()
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")

    chess_com_username = (payload.chess_com_username or "").strip().lower() or None
    if chess_com_username and not chess_com.player_exists(chess_com_username):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"No Chess.com player named '{chess_com_username}'"
        )

    user = User(
        username=username,
        password_hash=hash_password(payload.password),
        chess_com_username=chess_com_username,
        preferences={},
    )
    db.add(user)
    db.commit()

    if chess_com_username:
        tasks.add_task(catch_up_sync, user.id)
    return TokenResponse(access_token=create_access_token(user.id))


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == payload.username.strip().lower()))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password")
    tasks.add_task(catch_up_sync, user.id)
    return TokenResponse(access_token=create_access_token(user.id))


@router.post("/logout")
def logout():
    """Tokens are stateless; the client drops it. Kept for API symmetry."""
    return {"ok": True}


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.patch("/me", response_model=UserOut)
def update_me(
    payload: UpdateMeRequest,
    tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.chess_com_username is not None:
        name = payload.chess_com_username.strip().lower() or None
        if name and not chess_com.player_exists(name):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"No Chess.com player named '{name}'")
        user.chess_com_username = name
        user.last_game_end_time = 0
    if payload.preferences is not None:
        user.preferences = payload.preferences
    db.commit()

    if user.chess_com_username:
        tasks.add_task(catch_up_sync, user.id)
    return user
