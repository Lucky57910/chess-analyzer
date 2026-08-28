/**
 * What the pages talk to. Same surface as the HTTP client it replaces.
 *
 * The screens used to call a FastAPI backend; they now call SQLite on the
 * phone. Keeping the method names and the payload shapes identical is what
 * makes that a change to one file instead of six - `api.games()` still returns
 * a flat list with the user's accuracy already on each row, because that is
 * what GameList reads.
 *
 * Gone with the server: `login`, `register`, `me`, tokens, and the wake-up
 * retry loop. There is nothing to wake and nobody to authenticate against.
 *
 * `createApi` takes its dependencies so the whole facade can be exercised over
 * a real database in tests; `api` is the lazily-wired singleton the app uses.
 */

import { DEFAULT_SETTINGS } from "../engine/analyze.js";
import { SETTING_LAST_SYNCED, SETTING_USERNAME } from "../data/sync.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Flatten the user's side of an analysis onto a game row, as the server did. */
function flatten(row) {
  const white = row.user_color === "white";
  const counts = (row.judgment_counts ?? {})[row.user_color] ?? {};
  // The per-colour columns are peeled off rather than passed through: leaving
  // both spellings on the row invites a component reading White's accuracy for
  // a game the user played as Black, which looks entirely plausible on screen.
  const { accuracy_white, accuracy_black, acpl_white, acpl_black, ...rest } = row;
  delete rest.judgment_counts;

  return {
    ...rest,
    accuracy: (white ? accuracy_white : accuracy_black) ?? null,
    acpl: (white ? acpl_white : acpl_black) ?? null,
    inaccuracies: counts.inaccuracy ?? null,
    mistakes: counts.mistake ?? null,
    blunders: counts.blunder ?? null,
  };
}

export function createApi({ repo, store, sync, engine, settings = DEFAULT_SETTINGS }) {
  /**
   * The whole archive, loaded once and kept until the database moves.
   *
   * Every statistic here is a pass over every game, and the statistics screen
   * asks for four of them in a row. It used to mean four full loads, each one
   * a listing plus a query per game. It is now one join, and the three that
   * follow it reuse the result.
   *
   * The cache is validated against the database rather than trusted: one small
   * aggregate query per call, compared with the one the held copy was built
   * from. That costs a round trip where a plain memo would cost none, and it
   * buys the thing a memo cannot give - correctness when something else wrote.
   * The analysis queue, a sync and a restored backup all change the archive
   * from outside this object.
   *
   * One slot, holding the newest load: the archive carries every PGN and every
   * move list, so keeping older copies around would be the expensive mistake.
   */
  let archive = null;

  const loadAllGames = async () => {
    const key = await store.fingerprint();
    if (archive?.key === key) return archive.games;
    const games = await store.listWithAnalyses();
    archive = { key, games };
    return games;
  };

  /**
   * The archive, narrowed to one kind of game.
   *
   * `rated` by default, everywhere: the point of the split is that a game the
   * player could take moves back in does not belong in the average that stands
   * for their strength. Filtering here rather than in SQL keeps it to one
   * cached load - a query per kind would undo that.
   */
  const archiveFor = async (kind = "rated") => {
    const games = await loadAllGames();
    if (kind === "all") return games;
    // No fallback for a missing kind: the column is NOT NULL with a default,
    // and the migration backfilled every row that predates it, so a game
    // without one cannot reach here. A `?? "rated"` would read as though it
    // could, and would quietly file anything unexpected as rated play.
    return games.filter((game) => game.game_kind === kind);
  };

  return {
    async settings() {
      return {
        chess_com_username: await repo.getSetting(SETTING_USERNAME, ""),
        last_synced_at: await repo.getSetting(SETTING_LAST_SYNCED, null),
        engine_depth: settings.engine_depth,
      };
    },

    async updateSettings(patch) {
      if ("chess_com_username" in patch) {
        await repo.setSetting(SETTING_USERNAME, patch.chess_com_username.trim());
      }
      return this.settings();
    },

    /**
     * One page of games, with the size of the whole filtered set beside it.
     *
     * The list screen needs both: without the total it cannot say "25 of 342"
     * and cannot know whether there is another page to offer. `store.list` has
     * always returned it - the flat-array facade was throwing it away.
     */
    async gamesPage(params = {}) {
      const { games, total } = await store.list({
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
        result: params.result,
        timeClass: params.time_class,
        color: params.color,
        status: params.status,
        kind: params.kind,
        search: params.search,
      });
      return { games: games.map(flatten), total };
    },

    /** The same page, as the flat array the screens were written against. */
    async games(params = {}) {
      return (await this.gamesPage(params)).games;
    },

    async game(id) {
      const row = await store.get(id);
      if (!row) throw new ApiError(404, "Partie introuvable");
      const analysis = await store.getAnalysis(id);
      return flatten({
        ...row,
        accuracy_white: analysis?.accuracy_white,
        accuracy_black: analysis?.accuracy_black,
        acpl_white: analysis?.acpl_white,
        acpl_black: analysis?.acpl_black,
        judgment_counts: analysis?.judgment_counts,
      });
    },

    async analysis(id) {
      const row = await store.getAnalysis(id);
      if (!row) {
        const game = await store.get(id);
        throw new ApiError(404, `Pas encore d'analyse (état : ${game?.analysis_status ?? "?"})`);
      }
      return row;
    },

    /** Put a game back at the front of the queue. */
    async refresh(id) {
      await store.requeue(id);
      return { status: "pending" };
    },

    /**
     * The whole database, as a plain object.
     *
     * There is nothing behind this app any more, so this is the only copy of an
     * archive that took the phone hours to compute.
     */
    async exportBackup() {
      const { exportBackup } = await import("../data/backup.js");
      return exportBackup(repo);
    },

    async importBackup(payload) {
      const { importBackup } = await import("../data/backup.js");
      return importBackup(repo, payload);
    },

    async sync(months = 1) {
      const result = await sync.importGames({ months });
      const status = await sync.status();
      return {
        imported: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        pending_analysis: status.pending,
      };
    },

    async syncStatus() {
      const status = await sync.status();
      return { ...status, total: await store.count() };
    },

    stats: async (days, kind) => {
      const { computeStats } = await import("../data/stats.js");
      return computeStats(withinDays(await archiveFor(kind), days));
    },

    trends: async (period = "week", limit = 12, kind) => {
      const { computeTrends } = await import("../data/stats.js");
      return computeTrends(await archiveFor(kind), { period, limit });
    },

    judgmentTrends: async (period = "week", limit = 12, kind) => {
      const { computeJudgmentTrends } = await import("../data/stats.js");
      return computeJudgmentTrends(await archiveFor(kind), { period, limit });
    },

    /**
     * The second layer of statistics, in one pass over the archive.
     *
     * Deliberately one method rather than eight. Every method here re-reads
     * every game and every analysis, so a call per panel would be eight passes
     * over the database to draw one screen.
     */
    insights: async (options = {}) => {
      const { computeInsights } = await import("../data/insights.js");
      return computeInsights(await archiveFor(options.kind), options);
    },

    /**
     * The daily series, smoothed against the days around each point.
     *
     * One method rather than two: the smoothed score and the smoothed judgment
     * counts share a calendar axis and a single pass builds both, where
     * `trends` and `judgmentTrends` are two passes over the archive.
     */
    smoothedTrends: async (radius = 3, limit = 60, kind) => {
      const { computeSmoothedTrends } = await import("../data/stats.js");
      return computeSmoothedTrends(await archiveFor(kind), { radius, limit });
    },

    mistakes: async (kind) => {
      const { computeMistakes } = await import("../data/stats.js");
      return computeMistakes(await archiveFor(kind));
    },

    /**
     * One position, evaluated now.
     *
     * The analysis queue drives the engine through `sync`; this is the other
     * caller, for playing a position out by hand. Both end up in the driver's
     * own queue, so they cannot interleave - but they do wait for each other,
     * which is why the screen that uses this stops the queue first.
     */
    async evaluate(fen, limit) {
      return engine.evaluate(fen, limit);
    },

    /** Engine status, from the plugin rather than a server. */
    async health() {
      try {
        const info = await engine.info();
        return {
          engine: info.available
            ? { available: true, name: info.name ?? "Stockfish", path: info.path }
            : { available: false, error: info.error ?? `Binaire absent (${info.path})` },
          engine_depth: settings.engine_depth,
          cpu_abi: info.cpuAbi,
        };
      } catch (error) {
        return {
          engine: { available: false, error: String(error.message ?? error) },
          engine_depth: settings.engine_depth,
        };
      }
    },
  };
}

/** The stats screen offers a window; the server did this filtering in SQL. */
function withinDays(games, days) {
  if (!days) return games;
  const newest = games.reduce((max, g) => Math.max(max, g.end_time ?? 0), 0);
  const cutoff = newest - days * 86_400;
  return games.filter((g) => (g.end_time ?? 0) >= cutoff);
}

let pending = null;

/**
 * The app's single wired instance.
 *
 * Created once, on first use, because opening the database and starting a
 * chess engine are not things to do twice. Everything native lives behind this
 * import so the module graph above it stays testable.
 */
export function getApi() {
  if (!pending) {
    pending = (async () => {
      const [{ createApp }, { createSync }] = await Promise.all([
        import("../data/capacitor.js"),
        import("../data/sync.js"),
      ]);
      const app = await createApp({ settings: DEFAULT_SETTINGS });
      const sync = createSync({
        repo: app.repo,
        store: app.store,
        client: app.client,
        evaluate: app.evaluate,
        settings: DEFAULT_SETTINGS,
      });
      return { api: createApi({ ...app, sync, settings: DEFAULT_SETTINGS }), app, sync };
    })();
  }
  return pending;
}

/**
 * Proxy so pages can keep `import { api }` and call methods directly.
 *
 * Every call resolves the singleton first, which means no page has to know
 * that its data source needs opening.
 */
export const api = new Proxy(
  {},
  {
    get(_target, method) {
      return async (...args) => {
        const { api: real } = await getApi();
        return real[method](...args);
      };
    },
  },
);
