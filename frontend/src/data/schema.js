/**
 * Local SQLite schema, from backend/app/db/models.py.
 *
 * One difference that removes a third of it: there are no users. The database
 * lives on one phone and belongs to whoever unlocked it, so the accounts table,
 * the password hashes, the per-row `user_id` and every "scoped to the token's
 * user" clause are gone. What was a user column is now either a `settings` row
 * or nothing at all.
 *
 * JSON columns are TEXT holding JSON, the way SQLite stores them anyway. The
 * repository parses on the way out so callers never see the encoding.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS games (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chess_com_game_id   TEXT NOT NULL UNIQUE,
  url                 TEXT,
  pgn                 TEXT NOT NULL,

  user_color          TEXT NOT NULL,
  user_rating         INTEGER,
  opponent_username   TEXT NOT NULL DEFAULT '',
  opponent_rating     INTEGER,

  result              TEXT NOT NULL,
  termination         TEXT,
  time_class          TEXT,
  time_control        TEXT,
  rated               INTEGER NOT NULL DEFAULT 1,
  eco                 TEXT,
  opening             TEXT,

  played_at           TEXT NOT NULL,
  end_time            INTEGER NOT NULL DEFAULT 0,

  chess_com_accuracy  REAL,

  analysis_status     TEXT NOT NULL DEFAULT 'pending',
  analysis_error      TEXT,
  analysis_attempts   INTEGER NOT NULL DEFAULT 0,

  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_games_end_time ON games (end_time DESC);
CREATE INDEX IF NOT EXISTS ix_games_status   ON games (analysis_status);
CREATE INDEX IF NOT EXISTS ix_games_class    ON games (time_class);

CREATE TABLE IF NOT EXISTS analyses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id          INTEGER NOT NULL UNIQUE REFERENCES games (id) ON DELETE CASCADE,

  engine_depth     INTEGER NOT NULL DEFAULT 0,
  engine_name      TEXT,
  moves_evaluated  INTEGER NOT NULL DEFAULT 0,

  moves            TEXT NOT NULL DEFAULT '[]',
  errors           TEXT NOT NULL DEFAULT '[]',
  blunders         TEXT NOT NULL DEFAULT '[]',

  accuracy_white   REAL,
  accuracy_black   REAL,
  acpl_white       REAL,
  acpl_black       REAL,

  judgment_counts  TEXT NOT NULL DEFAULT '{}',
  phase_stats      TEXT NOT NULL DEFAULT '{}',

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
`;

/** Columns holding JSON, parsed on read and stringified on write. */
export const JSON_COLUMNS = ["moves", "errors", "blunders", "judgment_counts", "phase_stats"];
