from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.session import SessionLocal, init_db
from app.routes import auth, games, stats
from app.services import analysis, engine, scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    info = engine.engine_info()
    if info["available"]:
        log.info("engine ready: %s", info["name"])
    else:
        log.warning("engine NOT ready: %s", info.get("error"))
    if settings.recompute_accuracy_on_boot:
        db = SessionLocal()
        try:
            changed = analysis.recompute_stored_accuracies(db)
            log.info("recomputed accuracies for %s analysis row(s)", changed)
        finally:
            db.close()
    scheduler.start_scheduler()
    yield
    scheduler.stop_scheduler()
    engine.close_engine()


app = FastAPI(title="Chess Analyzer", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
