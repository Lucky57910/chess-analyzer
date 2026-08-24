from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer


def _as_utc(value: datetime | None) -> str | None:
    """SQLite hands back naive datetimes; everything we store is UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


UtcDatetime = Annotated[datetime, PlainSerializer(_as_utc, return_type=str)]


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=128)
    chess_com_username: str | None = Field(default=None, max_length=64)
    registration_code: str | None = None


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UpdateMeRequest(BaseModel):
    chess_com_username: str | None = Field(default=None, max_length=64)
    preferences: dict | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    chess_com_username: str | None
    preferences: dict
    last_synced_at: UtcDatetime | None
    created_at: UtcDatetime


class GameOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    chess_com_game_id: str
    url: str | None
    user_color: str
    user_rating: int | None
    opponent_username: str
    opponent_rating: int | None
    result: str
    termination: str | None
    time_class: str | None
    time_control: str | None
    rated: bool
    eco: str | None
    opening: str | None
    played_at: UtcDatetime
    analysis_status: str
    analysis_error: str | None

    # Chess.com's own number, for side-by-side comparison with ours
    chess_com_accuracy: float | None = None

    # flattened from the analysis, so the dashboard needs one request
    accuracy: float | None = None
    acpl: float | None = None
    inaccuracies: int | None = None
    mistakes: int | None = None
    blunders: int | None = None


class GameDetailOut(GameOut):
    pgn: str


class AnalysisOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    game_id: int
    engine_name: str | None
    engine_depth: int
    moves_evaluated: int
    moves: list
    accuracy_white: float | None
    accuracy_black: float | None
    acpl_white: float | None
    acpl_black: float | None
    judgment_counts: dict
    phase_stats: dict
    created_at: UtcDatetime
    updated_at: UtcDatetime


class SyncResponse(BaseModel):
    imported: int
    pending_analysis: int
    chess_com_username: str | None


class StatsOut(BaseModel):
    games: int
    analysed: int
    wins: int
    losses: int
    draws: int
    win_rate: float
    avg_accuracy: float | None
    avg_acpl: float | None
    blunders_per_game: float | None
    mistakes_per_game: float | None
    inaccuracies_per_game: float | None
    weakest_phase: str | None
    by_time_class: list[dict]
    by_color: list[dict]
    top_opponents: list[dict]
    top_openings: list[dict]
    phase_acpl: dict


class TrendPoint(BaseModel):
    period: str
    games: int
    win_rate: float
    avg_accuracy: float | None
    avg_acpl: float | None
