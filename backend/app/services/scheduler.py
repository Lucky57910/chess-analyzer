"""Background jobs: poll Chess.com, then drain the analysis queue.

Both jobs are `max_instances=1` — the analysis worker holds a CPU core for the
length of a game, and overlapping pollers would just duplicate work.
"""

from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings
from app.db.session import SessionLocal
from app.services import analysis

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


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
