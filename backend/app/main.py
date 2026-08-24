from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.config import settings
from app.db.session import SessionLocal, init_db
from app.routes import auth, games, stats
from app.services import analysis, engine, scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


def _recompute_accuracies() -> None:
    db = SessionLocal()
    try:
        log.info("recomputed accuracies for %s analysis row(s)",
                 analysis.recompute_stored_accuracies(db))
    except Exception as exc:  # a background chore must never take the app down
        log.warning("accuracy recompute failed: %s", exc)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    info = engine.engine_info()
    if info["available"]:
        log.info("engine ready: %s", info["name"])
    else:
        log.warning("engine NOT ready: %s", info.get("error"))
    if settings.recompute_accuracy_on_boot:
        # Off the boot path deliberately. The startup hook gates the health
        # check, and on the free tier a slow boot is exactly what makes the
        # first visit of the day time out in the browser.
        threading.Thread(target=_recompute_accuracies, daemon=True).start()
    scheduler.start_scheduler()
    yield
    scheduler.stop_scheduler()
    engine.close_engine()


app = FastAPI(title="Chess Analyzer", version="1.0.0", lifespan=lifespan)

# Added before CORS so CORS ends up the outer layer and still answers preflight.
# Analysis payloads are long JSON move lists and compress by roughly 10x.
app.add_middleware(GZipMiddleware, minimum_size=500)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def track_activity(request: Request, call_next):
    """Let the analysis worker know somebody is using the site."""
    scheduler.note_request()
    try:
        return await call_next(request)
    finally:
        scheduler.note_request()


app.include_router(auth.router)
app.include_router(games.router)
app.include_router(stats.router)


@app.get("/")
def root():
    return {"service": "chess-analyzer", "docs": "/docs"}


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "engine": engine.engine_info(),
        "poll_interval_seconds": settings.poll_interval_seconds,
        "engine_depth": settings.engine_depth,
    }
