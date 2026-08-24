"""Re-derive the stored accuracies with the current aggregation model.

The per-move numbers in `Analysis.moves` are raw engine output and do not
change when the aggregation formula does, so switching to the Lichess model
only needs a pass over the database - no Stockfish, no re-analysis.

Run it from the `backend` directory so the local `.env` is picked up:

    python scripts/recompute_accuracy.py

On a host with no shell, set RECOMPUTE_ACCURACY_ON_BOOT=true instead, restart
once, then unset it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal, init_db  # noqa: E402
from app.services.analysis import recompute_stored_accuracies  # noqa: E402


def main() -> int:
    init_db()
    db = SessionLocal()
    try:
        print(f"{recompute_stored_accuracies(db)} analysis row(s) updated")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
