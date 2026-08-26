/**
 * Import and analysis queue, from backend/app/services/analysis.py.
 *
 * The server ran two APScheduler jobs inside the API process: one polling
 * Chess.com every 90 seconds, one draining the analysis queue every 5. Neither
 * survives here, and not for want of a scheduler - Android will not let an app
 * hold the CPU in the background without a foreground service, and a phone that
 * quietly analyses chess games while in a pocket is a phone with a dead battery.
 *
 * So the queue runs while the app is open, with progress on screen. That is a
 * real behaviour change from the server version and worth stating plainly: the
 * catch-up happens when you look at the app, not before you do.
 */

import { analysePgn, DEFAULT_SETTINGS } from "../engine/analyze.js";
import { normalizeGame } from "./chessCom.js";

export const SETTING_USERNAME = "chess_com_username";
export const SETTING_LAST_SYNCED = "last_synced_at";
export const SETTING_ENGINE = "engine";

/**
 * @param {object} deps
 * @param {object} deps.repo Repository from createRepository.
 * @param {object} deps.store Game store from createGameStore.
 * @param {object} deps.client Chess.com client from createClient.
 * @param {(fen: string, limit: object) => Promise<object>} deps.evaluate
 * @param {object} [deps.settings] Engine settings; defaults to DEFAULT_SETTINGS.
 */
export function createSync({ repo, store, client, evaluate, settings = DEFAULT_SETTINGS }) {
  const depth = settings.engine_depth ?? DEFAULT_SETTINGS.engine_depth;

  return {
    /**
     * Import games. `months` of null polls only the current month.
     *
     * Nothing here decides what is new - `upsertMany` does, off the unique
     * index, because two overlapping archives legitimately contain the same
     * game and the cheap path re-reads the current month every time.
     */
    async importGames({ months = null } = {}) {
      const username = await repo.getSetting(SETTING_USERNAME);
      if (!username) return { inserted: 0, updated: 0, skipped: 0 };

      const raw =
        months === null
          ? await client.fetchCurrentMonth(username)
          : await client.fetchRecentMonths(username, months);

      const rows = [];
      let skipped = 0;
      for (const entry of raw) {
        const row = normalizeGame(entry, username);
        if (row === null) skipped += 1; // variants and games this player is not in
        else rows.push(row);
      }

      const result = await store.upsertMany(rows);
      await repo.setSetting(SETTING_LAST_SYNCED, new Date().toISOString());
      return { ...result, skipped };
    },

    /**
     * Analyse one queued game, else deepen one analysed at a shallower depth.
     *
     * Nothing is ever deleted or re-queued to reach a new depth: the old result
     * stays live and is replaced in place when its turn comes.
     *
     * @returns {Promise<{done: boolean, gameId?: number, refresh?: boolean}>}
     */
    async analyseNext({ onProgress } = {}) {
      let game = await store.nextPending();
      let refresh = false;
      if (!game) {
        game = await store.nextStale(depth);
        refresh = true;
      }
      if (!game) return { done: false };

      if (!refresh) await store.markRunning(game.id);

      try {
        const result = await analysePgn(game.pgn, {
          evaluate,
          settings,
          depth,
          onProgress,
        });
        await store.saveAnalysis(game.id, result);
        return { done: true, gameId: game.id, refresh };
      } catch (error) {
        if (refresh) {
          // The previous analysis is still on screen and still correct. A
          // failed deepening is not a reason to take it away.
          throw error;
        }
        if (isEngineUnavailable(error)) {
          // Not the game's fault. Charging it an attempt would retire three
          // innocent games every time the engine fails to start.
          await store.markUnattempted(game.id, String(error.message ?? error));
          throw error;
        }
        await store.markFailed(game.id, `${error.name}: ${error.message}`);
        return { done: true, gameId: game.id, refresh, failed: true };
      }
    },

    /**
     * Drain the queue until it is empty or the caller stops it.
     *
     * `signal` is how a screen being left behind stops the work - without it a
     * navigation would leave a search running against a database nobody is
     * looking at.
     */
    async runQueue({ signal, onGame, onProgress, max = Infinity } = {}) {
      let processed = 0;
      while (processed < max) {
        if (signal?.aborted) break;
        const outcome = await this.analyseNext({ onProgress });
        if (!outcome.done) break;
        processed += 1;
        onGame?.(outcome, processed);
      }
      return processed;
    },

    status: () => store.queueStatus(depth),
  };
}

/**
 * The engine failing to start is different from a game failing to analyse.
 *
 * The plugin rejects with a message naming the binary when exec fails, which is
 * the case where retrying the same game forever is right and burning its
 * attempts is wrong.
 */
export function isEngineUnavailable(error) {
  const message = String(error?.message ?? error);
  return (
    message.includes("Stockfish binary missing") ||
    message.includes("Could not start Stockfish") ||
    message.includes("Engine is not running")
  );
}
