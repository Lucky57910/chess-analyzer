import logging
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./chess.db"

    secret_key: str = "dev-secret-change-me"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 30
    registration_code: str = ""

    stockfish_path: str = "stockfish"
    engine_depth: int = 14
    engine_max_time: float = 1.5
    engine_threads: int = 1
    engine_hash_mb: int = 64
    max_plies: int = 200

    # One-shot switch for hosts with no shell (Render free): re-derives stored
    # accuracies at boot after the aggregation model changes, then can go back
    # to false. Cheap - it never touches the engine.
    recompute_accuracy_on_boot: bool = False

    poll_interval_seconds: int = 90
    analysis_interval_seconds: int = 5

    # The analysis worker and the web server share one CPU on the free tier, so
    # the worker stands down while requests are coming in - but never for longer
    # than `analysis_max_defer_seconds`, or a browsing session would starve it.
    analysis_quiet_seconds: float = 3.0
    analysis_max_defer_seconds: float = 120.0
    sync_months_on_login: int = 3

    chess_com_user_agent: str = "chess-analyzer/1.0"
    cors_origins: str = "http://localhost:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()


def use_system_certificates() -> None:
    """Trust the OS certificate store.

    Networks that intercept TLS (corporate proxies) sign traffic with a root CA
    that lives in the Windows/macOS store but not in certifi, so httpx fails
    with CERTIFICATE_VERIFY_FAILED. This is a no-op on a clean Linux host.
    """
    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception as exc:  # never let TLS wiring stop the app from booting
        log.warning("truststore unavailable, falling back to certifi: %s", exc)


use_system_certificates()
