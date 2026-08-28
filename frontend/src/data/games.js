/**
 * Game and analysis storage, from backend/app/routes/games.py and the
 * persistence half of app/services/analysis.py.
 *
 * Every `WHERE user_id = ?` from the server version is gone: the database is
 * the user's, so scoping it to them again would be theatre.
 */

import { JSON_COLUMNS } from "./schema.js";

export const MAX_ANALYSIS_ATTEMPTS = 3;

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
  "eco",
  "opening",
  "chess_com_accuracy",
  "played_at",
  "end_time",
];

const now = () => new Date().toISOString();

export function createGameStore(repo) {
  return {
    /**
     * Insert games that are new, and fill in accuracy on ones that are not.
     *
     * Chess.com only publishes its own accuracy once the game has been reviewed
     * on their side, which usually happens after we first imported it. Skipping
     * a known game outright would mean never picking that up.
     *
     * @returns {Promise<{inserted: number, updated: number}>}
     */
    async upsertMany(rows) {
      let inserted = 0;
      let updated = 0;

      for (const row of rows) {
        const existing = await repo.one(
          "SELECT id, chess_com_accuracy FROM games WHERE chess_com_game_id = ?",
          [row.chess_com_game_id],
        );

        if (existing) {
          if (existing.chess_com_accuracy === null && row.chess_com_accuracy !== null) {
            await repo.run("UPDATE games SET chess_com_accuracy = ? WHERE id = ?", [
              row.chess_com_accuracy,
              existing.id,
            ]);
            updated += 1;
          }
          continue;
        }

        const values = GAME_COLUMNS.map((column) =>
          column === "rated" ? (row.rated ? 1 : 0) : (row[column] ?? null),
        );
        await repo.run(
          `INSERT INTO games (${GAME_COLUMNS.join(", ")}, created_at) ` +
            `VALUES (${GAME_COLUMNS.map(() => "?").join(", ")}, ?)`,
          [...values, now()],
        );
        inserted += 1;
      }
      return { inserted, updated };
    },

    async count(where = "", values = []) {
      const row = await repo.one(`SELECT COUNT(*) AS n FROM games ${where}`, values);
      return row?.n ?? 0;
    },

    /** Newest first, with the filters the games list offers. */
    async list({ limit = 50, offset = 0, result, timeClass, color, status, search } = {}) {
      const clauses = [];
      const values = [];
      const term = search?.trim();
      if (term) {
        // `%` and `_` are wildcards to LIKE, and an opponent's name is user
        // input: without the escape, searching for "_" matches every game.
        const like = `%${term.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;
        clauses.push(
          "(opponent_username LIKE ? ESCAPE '\\' OR IFNULL(opening, '') LIKE ? ESCAPE '\\')",
        );
        values.push(like, like);
      }
      if (result) {
        clauses.push("result = ?");
        values.push(result);
      }
      if (timeClass) {
        clauses.push("time_class = ?");
        values.push(timeClass);
      }
      if (color) {
        clauses.push("user_color = ?");
        values.push(color);
      }
      if (status) {
        clauses.push("analysis_status = ?");
        values.push(status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      // The judgment counts come along so the list can show "2 blunders"
      // without a query per row. That is the whole reason the server flattened
      // them onto the game payload too.
      const rows = await repo.all(
        `SELECT g.*, a.accuracy_white, a.accuracy_black, a.acpl_white, a.acpl_black,
                a.judgment_counts, a.engine_depth
           FROM games g LEFT JOIN analyses a ON a.game_id = g.id
          ${where}
          ORDER BY g.end_time DESC
          LIMIT ? OFFSET ?`,
        [...values, limit, offset],
      );
      return { games: rows, total: await this.count(where, values) };
    },

    async get(id) {
      return repo.one("SELECT * FROM games WHERE id = ?", [id]);
    },

    async getAnalysis(gameId) {
      return repo.one("SELECT * FROM analyses WHERE game_id = ?", [gameId]);
    },

    /**
     * The user-facing accuracy is theirs, not White's.
     *
     * Reading the wrong side is the kind of bug that shows a plausible number
     * on every screen and is only noticeable as "my accuracy looks oddly
     * stable".
     */
    accuracyFor(game, analysis) {
      if (!analysis) return null;
      return game.user_color === "white" ? analysis.accuracy_white : analysis.accuracy_black;
    },

    /** Games waiting for a first analysis, newest first. */
    async nextPending() {
      return repo.one(
        `SELECT * FROM games
          WHERE analysis_status = 'pending' AND analysis_attempts < ?
          ORDER BY end_time DESC LIMIT 1`,
        [MAX_ANALYSIS_ATTEMPTS],
      );
    },

    /**
     * A game analysed at a shallower depth than we use now.
     *
     * Only reached once nothing is pending, so a freshly imported game always
     * wins the CPU over re-deepening an old one.
     */
    async nextStale(depth) {
      return repo.one(
        `SELECT g.* FROM games g JOIN analyses a ON a.game_id = g.id
          WHERE g.analysis_status = 'done' AND a.engine_depth < ?
          ORDER BY g.end_time DESC LIMIT 1`,
        [depth],
      );
    },

    async markRunning(id) {
      await repo.run(
        "UPDATE games SET analysis_status = 'running', analysis_attempts = analysis_attempts + 1 WHERE id = ?",
        [id],
      );
    },

    /**
     * Hand a game back to the queue without burning an attempt.
     *
     * Used when the engine itself is unavailable: that is not the game's fault,
     * and charging it an attempt would retire three innocent games every time
     * the engine fails to start.
     */
    async markUnattempted(id, error) {
      await repo.run(
        `UPDATE games SET analysis_status = 'pending',
                          analysis_attempts = MAX(0, analysis_attempts - 1),
                          analysis_error = ?
          WHERE id = ?`,
        [error, id],
      );
    },

    async markFailed(id, error) {
      await repo.run(
        "UPDATE games SET analysis_status = 'error', analysis_error = ? WHERE id = ?",
        [error, id],
      );
    },

    /**
     * Persist one analysis, replacing any previous one for that game.
     *
     * The old row stays live until the new one overwrites it, so re-analysing
     * the archive at a deeper setting never blanks a screen mid-pass.
     */
    async saveAnalysis(gameId, result) {
      const moves = result.moves ?? [];
      const errors = moves.filter((m) => m.judgment === "mistake" || m.judgment === "blunder");
      const blunders = moves.filter((m) => m.judgment === "blunder");

      const payload = {
        engine_depth: result.engine_depth,
        engine_name: result.engine_name,
        moves_evaluated: moves.length,
        moves,
        errors,
        blunders,
        accuracy_white: result.accuracy_white,
        accuracy_black: result.accuracy_black,
        acpl_white: result.acpl_white,
        acpl_black: result.acpl_black,
        judgment_counts: result.judgment_counts,
        phase_stats: result.phase_stats,
      };

      const columns = Object.keys(payload);
      const values = columns.map((column) =>
        JSON_COLUMNS.includes(column) ? JSON.stringify(payload[column]) : (payload[column] ?? null),
      );
      const timestamp = now();

      await repo.run(
        `INSERT INTO analyses (game_id, ${columns.join(", ")}, created_at, updated_at)
         VALUES (?, ${columns.map(() => "?").join(", ")}, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET
           ${columns.map((c) => `${c} = excluded.${c}`).join(", ")},
           updated_at = excluded.updated_at`,
        [gameId, ...values, timestamp, timestamp],
      );

      await repo.run(
        "UPDATE games SET analysis_status = 'done', analysis_error = NULL WHERE id = ?",
        [gameId],
      );
    },

    /** Put a game back in the queue for a fresh analysis. */
    async requeue(id) {
      await repo.run(
        `UPDATE games SET analysis_status = 'pending', analysis_attempts = 0,
                          analysis_error = NULL
          WHERE id = ?`,
        [id],
      );
    },

    async queueStatus(depth) {
      const rows = await repo.all(
        "SELECT analysis_status AS status, COUNT(*) AS n FROM games GROUP BY analysis_status",
      );
      const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const stale = await repo.one(
        `SELECT COUNT(*) AS n FROM games g JOIN analyses a ON a.game_id = g.id
          WHERE g.analysis_status = 'done' AND a.engine_depth < ?`,
        [depth],
      );
      return {
        pending: counts.pending ?? 0,
        running: counts.running ?? 0,
        done: counts.done ?? 0,
        error: counts.error ?? 0,
        stale: stale?.n ?? 0,
      };
    },
  };
}
