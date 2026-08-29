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

export const SCHEMA_VERSION = 4;

/**
 * The version handed to the SQLite plugin, which is not our schema version.
 *
 * `createConnection` takes a version and drives the plugin's own upgrade
 * machinery from it. We do our own migrations against `PRAGMA user_version`,
 * so this stays where it was when the first database was created: asking the
 * plugin for a version above the one it recorded, with no upgrade statement
 * registered, is how you get an app that refuses to open its database on a
 * phone and nowhere else.
 */
export const DATABASE_VERSION = 1;

/**
 * The version 1 schema, frozen.
 *
 * Every statement is `IF NOT EXISTS`, so this is the creation script on a new
 * database and a no-op on an existing one. It is deliberately not kept up to
 * date: a baseline that drifts while the migrations also change means new
 * installs and old ones stop agreeing, and the difference only shows up on
 * somebody's phone. Anything after version 1 is a step in `MIGRATIONS`.
 */
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
export const JSON_COLUMNS = [
  "moves",
  "errors",
  "blunders",
  "judgment_counts",
  "phase_stats",
  "coach",
];

/**
 * Everything that has happened to the schema since version 1.
 *
 * Ordered, applied once each, and stamped one at a time so an interrupted
 * upgrade resumes where it stopped rather than starting over. Three rules,
 * because the database on the phone is the only copy of analyses that took it
 * hours to compute:
 *
 *   1. **Every step is idempotent.** The version is stamped after the step
 *      succeeds, not with it, so a process killed in between re-runs the step
 *      on the next launch. `IF NOT EXISTS`, or `addColumn`, which looks first.
 *   2. **A new column is nullable or has a default.** Restoring a backup
 *      inserts the columns the file knew about and nothing else, so a NOT NULL
 *      column with no default makes every older backup unrestorable.
 *   3. **Nothing here drops or rewrites a column.** Adding is reversible by
 *      ignoring it; a downgrade after a rewrite is not reversible at all, and
 *      this app is sideloaded, so downgrades happen.
 *
 * A step is `{ version, name }` plus either `sql` to execute or
 * `run(driver, helpers)` for anything that has to look at the database first.
 * The helpers are handed in rather than imported, because db.js imports this
 * file and a step reaching back for them would close the circle.
 */
export const MIGRATIONS = [
  {
    version: 2,
    name: "index the analyses timestamp",
    // The archive cache checks `MAX(updated_at)` on every statistics call to
    // decide whether the copy it holds is still good. Without an index that is
    // a scan of the widest table in the database; with one it is a lookup.
    sql: `CREATE INDEX IF NOT EXISTS ix_analyses_updated ON analyses (updated_at);`,
  },
  {
    version: 3,
    name: "mark how a game was played",
    // Two values, and a default that keeps every existing row where it was:
    // 'rated' is the ordinary case, so a column added to an archive of games
    // says nothing new about them until the backfill below runs.
    run: async (driver, { addColumn }) => {
      await addColumn(driver, "games", "game_kind", "TEXT NOT NULL DEFAULT 'rated'");
      // Backfilled from `rated`, which every imported game already carries, so
      // the split works on the archive already on the phone rather than only on
      // games synced from here on.
      //
      // This is a derivation, not a decision: re-running it - which happens if
      // the process dies before the version is stamped - recomputes the same
      // answer from the same column. Which also means it would overwrite a
      // manual reclassification, so when the app grows one it needs a column of
      // its own for the override rather than editing this one in place.
      await driver.execute("UPDATE games SET game_kind = 'training' WHERE rated = 0");
      await driver.execute("CREATE INDEX IF NOT EXISTS ix_games_kind ON games (game_kind);");
    },
  },
  {
    version: 4,
    name: "keep the coach's commentary beside the analysis",
    // One JSON object per game, keyed by ply. It belongs on `analyses` rather
    // than in a table of its own because its lifetime is the analysis's: a
    // re-analysis at a deeper level renews the moves the commentary describes,
    // and `saveAnalysis` overwrites the row, which drops it.
    //
    // Nullable with a default, per rule 2 above: a backup taken before this
    // existed restores without it, and a phone that downgrades keeps every
    // other column readable.
    run: async (driver, { addColumn }) => {
      await addColumn(driver, "analyses", "coach", "TEXT NOT NULL DEFAULT '{}'");
    },
  },
];
