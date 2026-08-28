/**
 * Export and restore the whole database as one JSON file.
 *
 * There is no server any more, which also means there is no backup any more.
 * The games can always be re-imported from Chess.com, but the analyses cannot:
 * they are hours of this phone's CPU, and a reinstall or a lost handset throws
 * all of it away. That is what this file is for.
 *
 * The format deliberately does not carry row ids. They are local autoincrement
 * values with no meaning outside the database that issued them; games are
 * matched on `chess_com_game_id`, which is the only identifier that means the
 * same thing on two devices.
 */

import { gameKind } from "./chessCom.js";
import { JSON_COLUMNS, SCHEMA_VERSION } from "./schema.js";

export const BACKUP_FORMAT = 1;
export const BACKUP_APP = "chess-analyzer";

/**
 * Game columns that travel, in the order they are written.
 *
 * Listed rather than read from the row so a future schema change has to be a
 * deliberate decision about the file format instead of silently altering it.
 */
const GAME_COLUMNS = [
  "chess_com_game_id",
  "url",
  "pgn",
  "user_color",
  "user_rating",
  "opponent_username",
  "opponent_rating",
  "result",
  "termination",
  "time_class",
  "time_control",
  "rated",
  "game_kind",
  "eco",
  "opening",
  "played_at",
  "end_time",
  "chess_com_accuracy",
  "analysis_status",
  "analysis_error",
  "analysis_attempts",
  "created_at",
];

const ANALYSIS_COLUMNS = [
  "engine_depth",
  "engine_name",
  "moves_evaluated",
  "moves",
  "errors",
  "blunders",
  "accuracy_white",
  "accuracy_black",
  "acpl_white",
  "acpl_black",
  "judgment_counts",
  "phase_stats",
  "created_at",
  "updated_at",
];

const pick = (row, columns) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));

const now = () => new Date().toISOString();

/**
 * Stand-ins for the NOT NULL columns.
 *
 * Our own exports always carry these, but a hand-edited or truncated file would
 * otherwise be rejected by SQLite halfway through the restore, leaving the
 * database half-filled. A default is cheaper than a partial import.
 */
const NOT_NULL = {
  opponent_username: "",
  end_time: 0,
  analysis_status: "pending",
  analysis_attempts: 0,
  moves_evaluated: 0,
  engine_depth: 0,
  created_at: now,
  updated_at: now,
};

function fill(entry, column) {
  const value = entry[column];
  if (value !== null && value !== undefined) return value;
  const fallback = NOT_NULL[column];
  return typeof fallback === "function" ? fallback() : (fallback ?? null);
}

/** A filename that sorts chronologically and says what it is. */
export function backupFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replaceAll(":", "-");
  return `chess-analyzer-${stamp}.json`;
}

export async function exportBackup(repo) {
  const settingRows = await repo.all("SELECT key, value FROM settings");
  const games = await repo.all("SELECT * FROM games ORDER BY end_time");
  const analyses = await repo.all("SELECT * FROM analyses");

  // One pass over the analyses rather than a query per game: an archive of a
  // few thousand games would otherwise mean a few thousand round trips through
  // the bridge, on the phone, while the user waits.
  const byGame = new Map(analyses.map((row) => [row.game_id, row]));

  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    settings: Object.fromEntries(
      settingRows.map((row) => {
        try {
          return [row.key, JSON.parse(row.value)];
        } catch {
          return [row.key, row.value];
        }
      }),
    ),
    games: games.map((game) => {
      const analysis = byGame.get(game.id);
      return {
        ...pick(game, GAME_COLUMNS),
        rated: Boolean(game.rated),
        analysis: analysis ? pick(analysis, ANALYSIS_COLUMNS) : null,
      };
    }),
  };
}

/** Reject a file that is not one of ours before it touches the database. */
export function validateBackup(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Fichier illisible : ce n’est pas une sauvegarde JSON.");
  }
  if (payload.app !== BACKUP_APP) {
    throw new Error("Ce fichier ne vient pas de Chess Analyzer.");
  }
  if (!Number.isInteger(payload.format) || payload.format > BACKUP_FORMAT) {
    throw new Error(
      `Sauvegarde au format ${payload.format} : trop récente pour cette version de l’application.`,
    );
  }
  // The column lists here are explicit, so a file from a newer schema restores
  // by quietly dropping whatever it knew that this version does not. Quietly
  // losing part of a backup is worse than refusing it.
  if (Number.isInteger(payload.schema_version) && payload.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `Sauvegarde issue d’un schéma ${payload.schema_version}, plus récent que celui de ` +
        `cette version (${SCHEMA_VERSION}). Mettez l’application à jour avant de la restaurer.`,
    );
  }
  if (!Array.isArray(payload.games)) {
    throw new Error("Sauvegarde incomplète : aucune liste de parties.");
  }
  return payload;
}

/**
 * Merge a backup into the current database.
 *
 * Additive on purpose. Restoring never deletes and never overwrites a game the
 * phone already has, because the common case is not a bare reinstall - it is a
 * user restoring an old file onto a database that has moved on since, and the
 * version on the phone is the newer one. The exception is an analysis: a game
 * that has none gains the one from the file, since an old analysis beats no
 * analysis and re-running it costs an evening.
 */
export async function importBackup(repo, payload) {
  validateBackup(payload);

  let games = 0;
  let analyses = 0;
  let skipped = 0;

  for (const [key, value] of Object.entries(payload.settings ?? {})) {
    await repo.setSetting(key, value);
  }

  for (const entry of payload.games) {
    if (!entry?.chess_com_game_id) {
      skipped += 1;
      continue;
    }

    let existing = await repo.one("SELECT id FROM games WHERE chess_com_game_id = ?", [
      entry.chess_com_game_id,
    ]);

    if (existing) {
      skipped += 1;
    } else {
      const values = GAME_COLUMNS.map((column) => {
        if (column === "rated") return entry.rated ? 1 : 0;
        // A backup written before the column existed still carries `rated`,
        // which is what the rule reads, so an old file restores classified
        // rather than landing wholesale in the rated pile.
        if (column === "game_kind") return entry.game_kind ?? gameKind(entry);
        return fill(entry, column);
      });
      const { changes } = await repo.run(
        `INSERT INTO games (${GAME_COLUMNS.join(", ")})
         VALUES (${GAME_COLUMNS.map(() => "?").join(", ")})`,
        values,
      );
      existing = { id: changes.lastId };
      games += 1;
    }

    if (!entry.analysis) continue;
    const hasAnalysis = await repo.one("SELECT id FROM analyses WHERE game_id = ?", [existing.id]);
    if (hasAnalysis) continue;

    const values = ANALYSIS_COLUMNS.map((column) =>
      JSON_COLUMNS.includes(column)
        ? JSON.stringify(
            entry.analysis[column] ?? (["moves", "errors", "blunders"].includes(column) ? [] : {}),
          )
        : fill(entry.analysis, column),
    );
    await repo.run(
      `INSERT INTO analyses (game_id, ${ANALYSIS_COLUMNS.join(", ")})
       VALUES (?, ${ANALYSIS_COLUMNS.map(() => "?").join(", ")})`,
      [existing.id, ...values],
    );
    // The game row travelled with whatever status it had, but a game holding an
    // analysis is done by definition - and a restored game stuck on 'pending'
    // would be re-analysed from scratch.
    await repo.run(
      "UPDATE games SET analysis_status = 'done', analysis_error = NULL WHERE id = ?",
      [existing.id],
    );
    analyses += 1;
  }

  return { games, analyses, skipped };
}
