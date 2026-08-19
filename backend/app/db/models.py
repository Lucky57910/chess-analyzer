from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    chess_com_username: Mapped[str | None] = mapped_column(String(64), index=True, default=None)
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_game_end_time: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    games: Mapped[list["Game"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Game(Base):
    __tablename__ = "games"
    __table_args__ = (UniqueConstraint("user_id", "chess_com_game_id", name="uq_user_game"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    chess_com_game_id: Mapped[str] = mapped_column(String(128), index=True)
    url: Mapped[str | None] = mapped_column(String(255), default=None)
    pgn: Mapped[str] = mapped_column(Text)

    user_color: Mapped[str] = mapped_column(String(5))  # white | black
    user_rating: Mapped[int | None] = mapped_column(Integer, default=None)
    opponent_username: Mapped[str] = mapped_column(String(64), default="")
    opponent_rating: Mapped[int | None] = mapped_column(Integer, default=None)

    result: Mapped[str] = mapped_column(String(8))  # win | loss | draw
    termination: Mapped[str | None] = mapped_column(String(64), default=None)
    time_class: Mapped[str | None] = mapped_column(String(16), index=True, default=None)
    time_control: Mapped[str | None] = mapped_column(String(32), default=None)
    rated: Mapped[bool] = mapped_column(Boolean, default=True)
    eco: Mapped[str | None] = mapped_column(String(16), default=None)
    opening: Mapped[str | None] = mapped_column(String(160), default=None)

    played_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    end_time: Mapped[int] = mapped_column(Integer, default=0, index=True)

    analysis_status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    analysis_error: Mapped[str | None] = mapped_column(Text, default=None)
    analysis_attempts: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship(back_populates="games")
    analysis: Mapped["Analysis | None"] = relationship(
        back_populates="game", cascade="all, delete-orphan", uselist=False
    )


class Analysis(Base):
    __tablename__ = "analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), unique=True, index=True
    )

    engine_depth: Mapped[int] = mapped_column(Integer, default=0)
    engine_name: Mapped[str | None] = mapped_column(String(64), default=None)
    moves_evaluated: Mapped[int] = mapped_column(Integer, default=0)

    # full per-ply detail: eval curve, best move, cp loss, judgment, phase
    moves: Mapped[list] = mapped_column(JSON, default=list)
    # subsets for cheap dashboard queries
    errors: Mapped[list] = mapped_column(JSON, default=list)
    blunders: Mapped[list] = mapped_column(JSON, default=list)

    accuracy_white: Mapped[float | None] = mapped_column(Float, default=None)
    accuracy_black: Mapped[float | None] = mapped_column(Float, default=None)
    acpl_white: Mapped[float | None] = mapped_column(Float, default=None)
    acpl_black: Mapped[float | None] = mapped_column(Float, default=None)

    # {"white": {"inaccuracy": 2, "mistake": 1, "blunder": 0}, "black": {...}}
    judgment_counts: Mapped[dict] = mapped_column(JSON, default=dict)
    # {"white": {"opening": {"acpl":.., "moves":..}, ...}, "black": {...}}
    phase_stats: Mapped[dict] = mapped_column(JSON, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    game: Mapped[Game] = relationship(back_populates="analysis")
