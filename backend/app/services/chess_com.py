"""Chess.com Published-Data API client.

The public API needs no authentication, but it *does* reject requests without a
descriptive User-Agent, so every call goes through `_client()`.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime, timezone

import chess.pgn
import httpx

from app.config import settings

log = logging.getLogger(__name__)

BASE = "https://api.chess.com/pub"

DRAW_RESULTS = {
    "agreed",
    "repetition",
    "stalemate",
    "insufficient",
    "50move",
    "timevsinsufficient",
}


class ChessComError(RuntimeError):
    pass


def _client() -> httpx.Client:
    return httpx.Client(
        timeout=20.0,
        follow_redirects=True,
        headers={"User-Agent": settings.chess_com_user_agent, "Accept": "application/json"},
    )


def player_exists(username: str) -> bool:
    with _client() as c:
        r = c.get(f"{BASE}/player/{username.lower()}")
        return r.status_code == 200


def list_archives(username: str) -> list[str]:
    """Monthly archive URLs, oldest first."""
    with _client() as c:
        r = c.get(f"{BASE}/player/{username.lower()}/games/archives")
        if r.status_code == 404:
            raise ChessComError(f"Chess.com user '{username}' not found")
        r.raise_for_status()
        return r.json().get("archives", [])


def fetch_archive(url: str) -> list[dict]:
    with _client() as c:
        r = c.get(url)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        return r.json().get("games", [])


def fetch_current_month(username: str) -> list[dict]:
    now = datetime.now(timezone.utc)
    return fetch_archive(f"{BASE}/player/{username.lower()}/games/{now.year}/{now.month:02d}")


def fetch_recent_months(username: str, months: int) -> list[dict]:
    """Last `months` archives (including the current one), oldest first."""
    archives = list_archives(username)
    games: list[dict] = []
    for url in archives[-max(months, 1) :]:
        games.extend(fetch_archive(url))
    return games


def _pgn_headers(pgn: str) -> dict:
    try:
        game = chess.pgn.read_game(io.StringIO(pgn))
    except Exception:  # malformed PGN should never kill a sync
        return {}
    return dict(game.headers) if game else {}


def normalize_game(raw: dict, chess_com_username: str) -> dict | None:
    """Turn a Chess.com archive entry into kwargs for `Game`.

    Returns None for anything we cannot analyse (variants, missing PGN).
    """
    if raw.get("rules") != "chess":
        return None
    pgn = raw.get("pgn")
    if not pgn:
        return None

    me = chess_com_username.lower()
    white = raw.get("white") or {}
    black = raw.get("black") or {}

    if (white.get("username") or "").lower() == me:
        mine, theirs, color = white, black, "white"
    elif (black.get("username") or "").lower() == me:
        mine, theirs, color = black, white, "black"
    else:
        return None

    raw_result = mine.get("result", "")
    if raw_result == "win":
        result = "win"
    elif raw_result in DRAW_RESULTS:
        result = "draw"
    else:
        result = "loss"

    # Termination is whichever side's result code is not the generic "win".
    termination = theirs.get("result") if raw_result == "win" else raw_result

    headers = _pgn_headers(pgn)
    end_time = int(raw.get("end_time") or 0)

    # Only present once the game has been reviewed on Chess.com.
    accuracies = raw.get("accuracies") or {}
    chess_com_accuracy = accuracies.get(color)

    return {
        "chess_com_game_id": str(raw.get("uuid") or raw.get("url") or end_time),
        "url": raw.get("url"),
        "pgn": pgn,
        "user_color": color,
        "user_rating": mine.get("rating"),
        "opponent_username": theirs.get("username") or "?",
        "opponent_rating": theirs.get("rating"),
        "result": result,
        "termination": termination,
        "time_class": raw.get("time_class"),
        "time_control": raw.get("time_control"),
        "rated": bool(raw.get("rated", True)),
        "eco": (headers.get("ECO") or None),
        "opening": _opening_name(headers),
        "chess_com_accuracy": chess_com_accuracy,
        "played_at": datetime.fromtimestamp(end_time, tz=timezone.utc),
        "end_time": end_time,
    }


def _opening_name(headers: dict) -> str | None:
    """Chess.com puts the opening in ECOUrl, e.g. .../openings/Sicilian-Defense-Najdorf."""
    if headers.get("Opening"):
        return headers["Opening"][:160]
    url = headers.get("ECOUrl")
    if not url:
        return None
    return url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ")[:160]
