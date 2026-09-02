/**
 * Game and analysis storage, from backend/app/routes/games.py and the
 * persistence half of app/services/analysis.py.
 *
 * Every `WHERE user_id = ?` from the server version is gone: the database is
 * the user's, so scoping it to them again would be theatre.
 */

import { gameKind } from "./chessCom.js";
import { hydrate } from "./db.js";
import { JSON_COLUMNS } from "./schema.js";

export const MAX_ANALYSIS_ATTEMPTS = 3;

/**
 * Analysis columns, aliased when joined onto a game.
 *
 * `id` and `created_at` exist on both tables, so the join cannot be selected
 * flat. The prefix keeps them apart and is stripped straight back off; it also
 * hides the JSON columns from the repository's own parser, which matches on
 * bare column names, so they are parsed here instead.
 */
const ANALYSIS_COLUMNS = [
  "id",
  "game_id",
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

const ANALYSIS_PREFIX = "analysis__";

/** Split one joined row back into a game with its analysis nested. */
function splitAnalysis(row) {
  const game = {};
  const analysis = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith(ANALYSIS_PREFIX)) analysis[key.slice(ANALYSIS_PREFIX.length)] = value;
    else game[key] = value;
  }
  // A LEFT JOIN with no match fills every analysis column with null, which is
  // not the same as an analysis whose fields happen to be empty.
  game.analysis = analysis.id === null || analysis.id === undefined ? null : hydrate(analysis);
  return game;
}

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
  "chess_com_accuracy",
  "played_at",
  "end_time",
];

const now = () => new Date().toISOString();

/**
 * The commentary a re-analysis is allowed to keep.
 *
 * A comment describes one move and one verdict on it. Re-running the engine
 * deeper changes some of those verdicts and leaves most of them alone, so the
 * question is per ply, not per game: keep the note where the judgment and the
 * move the engine preferred both came back the same, drop it where either
 * moved. What is dropped is asked for again on the next run of the coach; what
 * is kept never had to be bought twice.
 *
 * The comparison is deliberately narrow. A centipawn figure shifts by a point
 * or two between depths on almost every move and means nothing to a sentence
 * that says "tu sors ta dame trop tôt"; the judgment and the refutation are
 * what a comment is actually written about.
 */
export function keptCommentary(previous, moves) {
  const notes = previous?.coach;
  if (!notes || !Object.keys(notes).length) return {};

  const before = new Map((previous.moves ?? []).map((move) => [move.ply, move]));
  const kept = {};
  for (const move of moves) {
    const note = notes[move.ply];
    const old = before.get(move.ply);
    if (!note || !old) continue;
    if ((old.judgment ?? null) !== (move.judgment ?? null)) continue;
    if ((old.best_move_san ?? null) !== (move.best_move_san ?? null)) continue;
    kept[move.ply] = note;
  }
  return kept;
}

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

        const values = GAME_COLUMNS.map((column) => {
          if (column === "rated") return row.rated ? 1 : 0;
          // Filed here rather than by the normaliser, whose output is pinned to
          // a recording of the Python backend. The rule reads `rated`, which
          // the normalised row carries, so it makes no difference where it runs.
          if (column === "game_kind") return row.game_kind ?? gameKind(row);
          return row[column] ?? null;
        });
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
    async list({ limit = 50, offset = 0, result, timeClass, color, status, kind, search } = {}) {
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
      if (kind) {
        clauses.push("game_kind = ?");
        values.push(kind);
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

    /**
     * Every game with its analysis attached, newest first, in one query.
     *
     * The statistics layer needs the whole archive, and used to get it by
     * listing the games and then asking for each analysis in turn. On a phone
     * that is one round trip across the Capacitor bridge per game - three
     * hundred games, three hundred crossings, each with its own serialisation -
     * to answer a question that is one join.
     */
    async listWithAnalyses() {
      const selected = ANALYSIS_COLUMNS.map(
        (column) => `a.${column} AS ${ANALYSIS_PREFIX}${column}`,
      ).join(", ");
      const rows = await repo.all(
        `SELECT g.*, ${selected}
           FROM games g LEFT JOIN analyses a ON a.game_id = g.id
          ORDER BY g.end_time DESC`,
      );
      return rows.map(splitAnalysis);
    },

    /**
     * A short string that changes whenever the archive does.
     *
     * Four aggregates over indexed columns, so it costs one small query and
     * lets a caller skip reloading megabytes it already holds. It is derived
     * from the database rather than from a counter the writers bump, because
     * not every writer goes through this store: restoring a backup writes rows
     * straight through the repository, and a counter would not see it.
     */
    async fingerprint() {
      const row = await repo.one(
        `SELECT (SELECT COUNT(*) FROM games) AS games,
                (SELECT IFNULL(MAX(end_time), 0) FROM games) AS newest,
                (SELECT COUNT(*) FROM games WHERE analysis_status = 'done') AS done,
                (SELECT COUNT(*) FROM analyses) AS analyses,
                (SELECT IFNULL(MAX(updated_at), '') FROM analyses) AS updated`,
      );
      return `${row.games}:${row.newest}:${row.done}:${row.analyses}:${row.updated}`;
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

    /**
     * Take back the games left mid-analysis, so the queue can finish them.
     *
     * `running` means "a runner is on it", and there is exactly one runner,
     * which only exists while the app is in the foreground. So a row still
     * marked running when nothing is draining the queue was interrupted - the
     * app was closed, the phone killed it, the screen was left - and nothing
     * would ever pick it up again: `nextPending` looks for `pending`. That is
     * how ten games sat "en analyse" from one week to the next.
     *
     * The attempt already charged stays charged. It is the only guard against
     * a game that reliably kills the app being retried until the end of time,
     * and a game that has spent them all is retired here with a reason, rather
     * than being handed back to a queue that will not touch it and displayed
     * as though something were still working on it.
     *
     * @returns {Promise<{requeued: number, retired: number}>}
     */
    async reclaimRunning() {
      const stuck = await repo.all(
        "SELECT id, analysis_attempts FROM games WHERE analysis_status = 'running'",
      );
      if (!stuck.length) return { requeued: 0, retired: 0 };

      const retired = stuck.filter((g) => g.analysis_attempts >= MAX_ANALYSIS_ATTEMPTS);
      const requeued = stuck.filter((g) => g.analysis_attempts < MAX_ANALYSIS_ATTEMPTS);

      if (requeued.length) {
        await repo.run(
          `UPDATE games SET analysis_status = 'pending'
            WHERE analysis_status = 'running' AND analysis_attempts < ?`,
          [MAX_ANALYSIS_ATTEMPTS],
        );
      }
      if (retired.length) {
        await repo.run(
          `UPDATE games SET analysis_status = 'error', analysis_error = ?
            WHERE analysis_status = 'running' AND analysis_attempts >= ?`,
          [
            "Analyse interrompue trop de fois. Relancez-la depuis la partie.",
            MAX_ANALYSIS_ATTEMPTS,
          ],
        );
      }
      return { requeued: requeued.length, retired: retired.length };
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

      const previous = await repo.one(
        "SELECT moves, coach FROM analyses WHERE game_id = ?",
        [gameId],
      );

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
        // Kept move by move, not wholesale. The commentary was written about
        // a particular set of judgments, and at a deeper search a move called
        // a blunder can come back merely inaccurate - a coach still calling it
        // a blunder is worse than a coach saying nothing. But that is true of
        // the handful of moves whose verdict actually moved, and clearing all
        // of them meant the queue quietly deleting a whole game's commentary
        // every time it re-deepened one, which is the reason it looked as
        // though nothing was ever stored.
        coach: keptCommentary(previous, moves),
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

    /**
     * Store the coach's commentary for one game.
     *
     * Merged rather than replaced, so a run that only covered part of a game -
     * a quota that ran out halfway, one chunk the model refused - adds what it
     * managed without dropping what a previous run produced.
     *
     * Keyed by ply, as a JSON object. `saveAnalysis` overwrites the row and
     * carries across only the notes whose move came back with the same verdict
     * — see `keptCommentary`.
     */
    async saveCoach(gameId, notes) {
      const row = await repo.one("SELECT coach FROM analyses WHERE game_id = ?", [gameId]);
      if (!row) throw new Error(`Aucune analyse pour la partie ${gameId}`);
      const merged = { ...(row.coach ?? {}), ...notes };
      await repo.run("UPDATE analyses SET coach = ?, updated_at = ? WHERE game_id = ?", [
        JSON.stringify(merged),
        now(),
        gameId,
      ]);
      return merged;
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
