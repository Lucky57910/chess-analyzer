"""Background jobs: poll Chess.com, then drain the analysis queue.

Both jobs are `max_instances=1` — the analysis worker holds a CPU core for the
length of a game, and overlapping pollers would just duplicate work.
"""

from __future__ import annotations

import logging
import time

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings
from app.db.session import SessionLocal
from app.services import analysis

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None

_last_request_at = 0.0
_deferred_since = 0.0


def note_request() -> None:
    """Marks the server as busy. Called from the HTTP middleware."""
    global _last_request_at
    _last_request_at = time.monotonic()


def _should_defer() -> bool:
    """True while HTTP traffic is recent enough that Stockfish would be felt."""
    global _deferred_since
    now = time.monotonic()
    if now - _last_request_at >= settings.analysis_quiet_seconds:
        _deferred_since = 0.0
        return False
    if not _deferred_since:
        _deferred_since = now
        return True
    if now - _deferred_since >= settings.analysis_max_defer_seconds:
        _deferred_since = 0.0  # take the CPU back, the queue has waited enough
        return False
    return True


def _poll_job() -> None:
    db = SessionLocal()
    try:
        count = analysis.sync_all_users(db)
        if count:
            log.info("poller imported %s new game(s)", count)
    except Exception as exc:
        log.warning("poll job error: %s", exc)
    finally:
        db.close()


def _analysis_job() -> None:
    if _should_defer():
        return
    db = SessionLocal()
    try:
        # Drain a few per tick so a backlog after a sleep clears reasonably fast.
        for _ in range(3):
            if not analysis.analyse_next_pending(db):
                break
    except Exception as exc:
        log.warning("analysis job error: %s", exc)
    finally:
        db.close()


def start_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler

    sched = BackgroundScheduler(timezone="UTC")
    sched.add_job(
        _poll_job,
        "interval",
        seconds=settings.poll_interval_seconds,
        id="poll_chess_com",
        max_instances=1,
        coalesce=True,
    )
    sched.add_job(
        _analysis_job,
        "interval",
        seconds=settings.analysis_interval_seconds,
        id="analysis_worker",
        max_instances=1,
        coalesce=True,
    )
    sched.start()
    _scheduler = sched
    log.info(
        "scheduler started (poll %ss, analysis %ss)",
        settings.poll_interval_seconds,
        settings.analysis_interval_seconds,
    )
    return sched


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
