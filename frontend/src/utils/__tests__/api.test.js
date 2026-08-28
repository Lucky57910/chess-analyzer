/**
 * The facade the pages call, over a real database.
 *
 * The pages were written against a FastAPI backend and were not rewritten. So
 * the thing that can break here is not logic, it is shape: GameList reads
 * `game.accuracy` and `game.blunders`, which the server flattened out of the
 * analysis before sending. If this facade returns `accuracy_white` instead,
 * every row renders with a blank accuracy and nothing throws.
 *
 * These tests assert the field names the components actually read, taken from
 * the components rather than from memory.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import golden from "../../data/__fixtures__/golden-data.json";
import { normalizeGame } from "../../data/chessCom.js";
import { createRepository, migrate, nodeDriver } from "../../data/db.js";
import { createGameStore } from "../../data/games.js";
import { createSync, SETTING_USERNAME } from "../../data/sync.js";
import { ApiError, createApi } from "../api.js";

const ME = "maxime";
const ROWS = golden.normalize.map(({ raw }) => normalizeGame(raw, ME)).filter(Boolean);

/** Exactly what GameList and StatsSummary read off their props. */
const GAME_LIST_FIELDS = [
  "id",
  "accuracy",
  "analysis_status",
  "blunders",
  "chess_com_accuracy",
  "mistakes",
  "opening",
  "opponent_rating",
  "opponent_username",
  "played_at",
  "result",
  "time_class",
  "user_color",
];

const STATS_SUMMARY_FIELDS = [
  "analysed",
  "avg_accuracy",
  "avg_acpl",
  "blunders_per_game",
  "draws",
  "games",
  "losses",
  "weakest_phase",
  "win_rate",
  "wins",
];

function analysisResult(overrides = {}) {
  return {
    engine_name: "Stockfish 17.1",
    engine_depth: 14,
    moves: [
      { ply: 1, color: "white", san: "e4", cp_loss: 0, judgment: null, phase: "opening", move_number: 1 },
      { ply: 2, color: "black", san: "e5", cp_loss: 320, judgment: "blunder", phase: "opening", move_number: 1 },
    ],
    accuracy_white: 88.1,
    accuracy_black: 61.4,
    acpl_white: 12.0,
    acpl_black: 230.0,
    judgment_counts: {
      white: { inaccuracy: 1, mistake: 2, blunder: 3 },
      black: { inaccuracy: 4, mistake: 5, blunder: 6 },
    },
    phase_stats: {
      white: { opening: { moves: 2, acpl: 12.0, accuracy: 88.1 } },
      black: { opening: { moves: 2, acpl: 230.0, accuracy: 61.4 } },
    },
    ...overrides,
  };
}

/** Counts the SQL that actually reaches the database. */
function counting(driver) {
  const queries = [];
  return {
    driver: {
      ...driver,
      query: (sql, values) => {
        queries.push(sql);
        return driver.query(sql, values);
      },
    },
    queries,
    /**
     * How many of them were the full archive load.
     *
     * Matched on the alias the join gives the analysis columns, not on the
     * join itself: the games listing joins the analyses too, and counting that
     * as an archive load would make this pass whatever the cache did.
     */
    archiveLoads: () => queries.filter((sql) => sql.includes("analysis__")).length,
    reset: () => queries.splice(0, queries.length),
  };
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const spy = counting(nodeDriver(database));
  const driver = spy.driver;
  await migrate(driver);
  const repo = createRepository(driver);
  const store = createGameStore(repo);
  await repo.setSetting(SETTING_USERNAME, ME);
  await store.upsertMany(ROWS);

  const client = {
    fetchCurrentMonth: async () => golden.normalize.map((c) => c.raw),
    fetchRecentMonths: async () => golden.normalize.map((c) => c.raw),
  };
  const sync = createSync({ repo, store, client, evaluate: async () => ({}) });
  const engine = { info: async () => ({ available: true, name: "Stockfish 17.1", path: "/x" }) };
  const api = createApi({ repo, store, sync, engine });
  return { repo, store, sync, api, engine, spy, database };
}

describe("games", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await fixture();
  });

  it("returns every field GameList reads", async () => {
    const [game] = await ctx.api.games({ limit: 1 });
    for (const field of GAME_LIST_FIELDS) {
      expect(game, `missing ${field}`).toHaveProperty(field);
    }
  });

  it("flattens the analysis onto the user's side", async () => {
    const [first] = await ctx.api.games({ limit: 1 });
    await ctx.store.saveAnalysis(first.id, analysisResult());

    const [game] = await ctx.api.games({ limit: 1 });
    const white = game.user_color === "white";
    expect(game.accuracy).toBe(white ? 88.1 : 61.4);
    expect(game.acpl).toBe(white ? 12.0 : 230.0);
    expect(game.blunders).toBe(white ? 3 : 6);
    expect(game.mistakes).toBe(white ? 2 : 5);
    expect(game.inaccuracies).toBe(white ? 1 : 4);
  });

  it("does not leak the per-colour columns the pages never read", async () => {
    const [first] = await ctx.api.games({ limit: 1 });
    await ctx.store.saveAnalysis(first.id, analysisResult());
    const [game] = await ctx.api.games({ limit: 1 });
    expect(game).not.toHaveProperty("accuracy_white");
    expect(game).not.toHaveProperty("judgment_counts");
  });

  it("leaves accuracy null on a game with no analysis", async () => {
    const [game] = await ctx.api.games({ limit: 1 });
    expect(game.accuracy).toBeNull();
    expect(game.blunders).toBeNull();
    expect(game.analysis_status).toBe("pending");
  });

  it("passes filters through", async () => {
    const blacks = await ctx.api.games({ limit: 100, color: "black" });
    expect(blacks.length).toBeGreaterThan(0);
    expect(blacks.every((g) => g.user_color === "black")).toBe(true);

    const draws = await ctx.api.games({ limit: 100, result: "draw" });
    expect(draws.every((g) => g.result === "draw")).toBe(true);
  });

  it("includes the PGN on a single game but not in the list", async () => {
    const [listed] = await ctx.api.games({ limit: 1 });
    const detail = await ctx.api.game(listed.id);
    expect(detail.pgn).toBeTruthy();
    expect(detail.accuracy).toBeDefined();
  });

  it("raises a 404 the pages can recognise", async () => {
    await expect(ctx.api.game(9999)).rejects.toBeInstanceOf(ApiError);
    await expect(ctx.api.game(9999)).rejects.toMatchObject({ status: 404 });
  });

  it("explains which state a missing analysis is in", async () => {
    const [game] = await ctx.api.games({ limit: 1 });
    await expect(ctx.api.analysis(game.id)).rejects.toThrow(/pending/);
  });
});

describe("stats", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await fixture();
    const games = await ctx.api.games({ limit: 100 });
    for (const game of games.slice(0, 5)) {
      await ctx.store.saveAnalysis(game.id, analysisResult());
    }
  });

  it("returns every field StatsSummary reads", async () => {
    const stats = await ctx.api.stats();
    for (const field of STATS_SUMMARY_FIELDS) {
      expect(stats, `missing ${field}`).toHaveProperty(field);
    }
    expect(stats.analysed).toBe(5);
  });

  // Measured from the newest game rather than from now, so opening the app
  // after a month away still shows a window with games in it instead of an
  // empty dashboard.
  it("windows by days against the newest game, not today", async () => {
    const newest = ROWS[0].end_time;
    const old = {
      ...ROWS[0],
      chess_com_game_id: "way-older",
      end_time: newest - 40 * 86_400,
      played_at: new Date((newest - 40 * 86_400) * 1000).toISOString(),
    };
    await ctx.store.upsertMany([old]);

    // "all", because this is about the window, not about the rated split.
    const all = await ctx.api.stats(undefined, "all");
    const window = await ctx.api.stats(7, "all");
    expect(all.games).toBe(ROWS.length + 1);
    expect(window.games).toBe(ROWS.length);
  });

  it("pages the archive and says how big the whole set is", async () => {
    const first = await ctx.api.gamesPage({ limit: 2, offset: 0 });
    expect(first.games.length).toBe(2);
    expect(first.total).toBe(ROWS.length);

    const wider = await ctx.api.gamesPage({ limit: 4, offset: 0 });
    expect(wider.games.slice(0, 2).map((g) => g.id)).toEqual(first.games.map((g) => g.id));

    // The total is the size of the filtered set, not of the page.
    const losses = await ctx.api.gamesPage({ limit: 1, result: "loss" });
    expect(losses.total).toBe(ROWS.filter((r) => r.result === "loss").length);
    expect(losses.total).toBeGreaterThan(losses.games.length);
  });

  it("searches the opponent and the opening from one box", async () => {
    const [any] = await ctx.api.games({ limit: 1 });

    const byOpponent = await ctx.api.gamesPage({
      limit: 100,
      search: any.opponent_username.slice(1, 4),
    });
    expect(byOpponent.games.length).toBeGreaterThan(0);
    for (const game of byOpponent.games) {
      const haystack = `${game.opponent_username} ${game.opening ?? ""}`.toLowerCase();
      expect(haystack).toContain(any.opponent_username.slice(1, 4).toLowerCase());
    }

    expect((await ctx.api.gamesPage({ limit: 100, search: "zzzz-nobody" })).total).toBe(0);
  });

  // `%` and `_` are LIKE wildcards, and the search box is user input. Unescaped,
  // a single underscore matches every game and the empty state never appears.
  it("treats LIKE wildcards as characters, not as patterns", async () => {
    expect((await ctx.api.gamesPage({ limit: 100, search: "%" })).total).toBe(0);
    expect((await ctx.api.gamesPage({ limit: 100, search: "_" })).total).toBe(0);
  });

  // Everything here is derived from the stored analysis rather than from the
  // game row, so an empty result over a real database means a field was read
  // under the wrong name - which looks exactly like "nothing to report".
  it("derives the second layer from what is actually stored", async () => {
    const insights = await ctx.api.insights();

    expect(insights.by_rating_gap.reduce((n, r) => n + r.games, 0)).toBeGreaterThan(0);
    expect(insights.by_piece.length).toBeGreaterThan(0);
    expect(insights.by_piece.reduce((n, r) => n + r.moves, 0)).toBeGreaterThan(0);
    expect(insights.comparison.current.games).toBeGreaterThan(0);
    expect(insights.session_tilt.length).toBeGreaterThan(0);
    expect(insights.conversion).toHaveProperty("conversion_rate");

    // The fixture PGNs carry no clock tags, so this must be absent rather than
    // a row of zeroes claiming every move was instant.
    expect(insights.clock).toBe(null);
  });

  // The smoothed view feeds both time charts from one array, so it has to
  // carry the field names each of them reads. A missing key there draws an
  // empty chart rather than throwing.
  it("carries both halves of the smoothed series under one set of names", async () => {
    const smoothed = await ctx.api.smoothedTrends(3, 60);
    const plain = await ctx.api.trends("day", 60);
    const judgments = await ctx.api.judgmentTrends("day", 60);

    expect(smoothed.length).toBeGreaterThan(0);
    for (const field of [...Object.keys(plain[0]), ...Object.keys(judgments[0])]) {
      // `moves` is the only field the smoothed series has no use for.
      if (field === "moves") continue;
      expect(smoothed[0], `missing ${field}`).toHaveProperty(field);
    }

    // A point per calendar day, gaps included, so the axis is continuous.
    expect(smoothed.length).toBeGreaterThanOrEqual(plain.length);
  });

  it("serves trends and mistakes in the shapes the charts expect", async () => {
    const trends = await ctx.api.trends("week", 5);
    expect(Array.isArray(trends)).toBe(true);
    for (const point of trends) {
      expect(point).toHaveProperty("period");
      expect(point).toHaveProperty("win_rate");
    }
    const mistakes = await ctx.api.mistakes();
    expect(mistakes).toHaveProperty("worst_moves");
    expect(mistakes).toHaveProperty("by_move_number");
  });

  // The judgment series is normalised by the user's own move count, which is
  // read off the stored analysis. If that read comes back empty over a real
  // database, every rate silently becomes null and the chart draws nothing.
  it("counts moves off the stored analysis for the judgment series", async () => {
    const points = await ctx.api.judgmentTrends("week", 20);
    expect(points.length).toBeGreaterThan(0);

    const analysed = points.filter((p) => p.analysed > 0);
    expect(analysed.length).toBeGreaterThan(0);
    for (const point of analysed) {
      expect(point.moves).toBeGreaterThan(0);
      expect(point.blunders_per_100).not.toBe(null);
      expect(point.blunders_per_game).not.toBe(null);
    }
  });
});

describe("loading the archive", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await fixture();
    const games = await ctx.api.games({ limit: 100 });
    for (const game of games.slice(0, 5)) {
      await ctx.store.saveAnalysis(game.id, analysisResult());
    }
    ctx.spy.reset();
  });

  // The statistics screen asks for four of these in a row. Each one used to be
  // a full listing plus a query per game.
  it("reads the archive once for a screenful of statistics", async () => {
    await ctx.api.stats();
    await ctx.api.mistakes();
    await ctx.api.insights();
    await ctx.api.trends("week", 12);

    expect(ctx.spy.archiveLoads()).toBe(1);
  });

  it("still returns the same numbers from the cached copy", async () => {
    const first = await ctx.api.stats();
    const second = await ctx.api.stats();
    expect(second).toEqual(first);
    expect(ctx.spy.archiveLoads()).toBe(1);
  });

  // The cache is checked against the database rather than trusted, because the
  // analysis queue writes from outside this object. A held copy that survived
  // an analysis would show the user a screen that never updates.
  it("reloads once an analysis lands", async () => {
    const before = await ctx.api.stats();
    expect(ctx.spy.archiveLoads()).toBe(1);

    const pending = (await ctx.api.games({ limit: 100 })).find(
      (game) => game.analysis_status !== "done",
    );
    await ctx.store.saveAnalysis(pending.id, analysisResult());

    const after = await ctx.api.stats();
    expect(ctx.spy.archiveLoads()).toBe(2);
    expect(after.analysed).toBe(before.analysed + 1);
  });

  it("reloads once a sync brings a game in", async () => {
    await ctx.api.stats(undefined, "all");
    await ctx.store.upsertMany([
      { ...ROWS[0], chess_com_game_id: "arrived-later", end_time: ROWS[0].end_time + 1 },
    ]);

    const after = await ctx.api.stats(undefined, "all");
    expect(ctx.spy.archiveLoads()).toBe(2);
    expect(after.games).toBe(ROWS.length + 1);
  });

  // Restoring a backup writes rows straight through the repository without
  // going through the store at all, which is why the cache is validated
  // against the database and not against a counter the store keeps.
  it("reloads after a restore that never touched the store", async () => {
    const before = await ctx.api.stats();
    await ctx.repo.run("DELETE FROM games WHERE id IN (SELECT id FROM games LIMIT 3)");

    const after = await ctx.api.stats();
    expect(ctx.spy.archiveLoads()).toBe(2);
    expect(after.games).toBe(before.games - 3);
  });
});

describe("sync and settings", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await fixture();
  });

  it("reports the queue and the total", async () => {
    const status = await ctx.api.syncStatus();
    expect(status.total).toBe(ROWS.length);
    expect(status.pending).toBe(ROWS.length);
    expect(status.done).toBe(0);
  });

  it("reports nothing new on a second import of the same archive", async () => {
    const result = await ctx.api.sync(1);
    expect(result.imported).toBe(0);
    expect(result.pending_analysis).toBe(ROWS.length);
  });

  it("stores the Chess.com username, trimmed", async () => {
    const saved = await ctx.api.updateSettings({ chess_com_username: "  Someone  " });
    expect(saved.chess_com_username).toBe("Someone");
    expect((await ctx.api.settings()).chess_com_username).toBe("Someone");
  });

  it("puts a game back in the queue on refresh", async () => {
    const [game] = await ctx.api.games({ limit: 1 });
    await ctx.store.saveAnalysis(game.id, analysisResult());
    expect((await ctx.store.get(game.id)).analysis_status).toBe("done");

    await ctx.api.refresh(game.id);
    expect((await ctx.store.get(game.id)).analysis_status).toBe("pending");
  });
});

describe("health", () => {
  it("reports the engine when it is there", async () => {
    const ctx = await fixture();
    const health = await ctx.api.health();
    expect(health.engine.available).toBe(true);
    expect(health.engine.name).toBe("Stockfish 17.1");
  });

  // The Settings screen shows this string. If the plugin throws instead of
  // answering, the screen must say why rather than crash on a missing field.
  it("survives a plugin that throws", async () => {
    const ctx = await fixture();
    const api = createApi({
      ...ctx,
      engine: {
        info: vi.fn(async () => {
          throw new Error("Stockfish binary missing or not executable at /x");
        }),
      },
    });
    const health = await api.health();
    expect(health.engine.available).toBe(false);
    expect(health.engine.error).toMatch(/binary missing/);
  });

  it("reports an unavailable engine without inventing a name", async () => {
    const ctx = await fixture();
    const api = createApi({
      ...ctx,
      engine: { info: async () => ({ available: false, path: "/nope" }) },
    });
    const health = await api.health();
    expect(health.engine.available).toBe(false);
    expect(health.engine.error).toMatch(/\/nope/);
  });
});

describe("backup", () => {
  it("hands back an archive the page can serialise", async () => {
    const ctx = await fixture();
    const [first] = await ctx.api.games({ limit: 1 });
    await ctx.store.saveAnalysis(first.id, analysisResult());

    const payload = await ctx.api.exportBackup();
    expect(payload.app).toBe("chess-analyzer");
    expect(payload.games).toHaveLength(ROWS.length);
    expect(JSON.parse(JSON.stringify(payload)).games.filter((g) => g.analysis)).toHaveLength(1);
  });

  it("restores into a database that has never seen those games", async () => {
    const source = await fixture();
    const [first] = await source.api.games({ limit: 1 });
    await source.store.saveAnalysis(first.id, analysisResult());
    const payload = JSON.parse(JSON.stringify(await source.api.exportBackup()));

    const target = await fixture();
    await target.repo.run("DELETE FROM games");
    const result = await target.api.importBackup(payload);

    expect(result.games).toBe(ROWS.length);
    expect(result.analyses).toBe(1);
    expect((await target.api.games({ limit: 100 })).length).toBe(ROWS.length);
  });

  it("refuses a file that is not one of ours", async () => {
    const ctx = await fixture();
    await expect(ctx.api.importBackup({ app: "other" })).rejects.toThrow(/Chess Analyzer/);
  });
});

describe("splitting rated play from training", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await fixture();
    // Half the archive becomes training, and only the rated half is analysed,
    // so a leak in either direction changes a number rather than nothing.
    const games = await ctx.api.games({ limit: 100 });
    const half = Math.floor(games.length / 2);
    for (const game of games.slice(0, half)) {
      await ctx.repo.run("UPDATE games SET game_kind = 'training' WHERE id = ?", [game.id]);
    }
    for (const game of games.slice(half)) {
      await ctx.store.saveAnalysis(game.id, analysisResult());
    }
    ctx.spy.reset();
  });

  const kinds = async () =>
    (await ctx.repo.all("SELECT game_kind, COUNT(*) AS n FROM games GROUP BY game_kind")).reduce(
      (out, row) => ({ ...out, [row.game_kind]: row.n }),
      {},
    );

  it("counts only rated games by default", async () => {
    const counts = await kinds();
    const stats = await ctx.api.stats();
    expect(stats.games).toBe(counts.rated);
    expect(stats.games).toBeLessThan(ROWS.length);
  });

  it("counts the training games when asked for them, and everything for 'all'", async () => {
    const counts = await kinds();
    expect((await ctx.api.stats(undefined, "training")).games).toBe(counts.training);
    expect((await ctx.api.stats(undefined, "all")).games).toBe(ROWS.length);
  });

  // Splitting must not undo the cached archive: filtering happens on the copy
  // already in memory, so switching the tab is free rather than another load.
  it("narrows the copy it already holds rather than reloading", async () => {
    await ctx.api.stats(undefined, "rated");
    await ctx.api.stats(undefined, "training");
    await ctx.api.stats(undefined, "all");
    await ctx.api.insights({ kind: "training" });
    expect(ctx.spy.archiveLoads()).toBe(1);
  });

  it("carries the split into every statistic, not just the summary", async () => {
    for (const method of ["trends", "judgmentTrends"]) {
      const rated = await ctx.api[method]("month", 24, "rated");
      const all = await ctx.api[method]("month", 24, "all");
      const total = (points) => points.reduce((n, p) => n + p.games, 0);
      expect(total(all)).toBe(ROWS.length);
      expect(total(rated)).toBeLessThan(total(all));
    }

    const smoothed = await ctx.api.smoothedTrends(3, 400, "all");
    expect(smoothed.reduce((n, p) => n + p.games, 0)).toBe(ROWS.length);
  });

  it("lists one kind at a time on the games screen", async () => {
    const counts = await kinds();
    const training = await ctx.api.gamesPage({ limit: 100, kind: "training" });
    expect(training.total).toBe(counts.training);
    expect(training.games.every((game) => game.game_kind === "training")).toBe(true);

    // The field reaches the row the list renders, which is what draws the badge.
    const all = await ctx.api.gamesPage({ limit: 100 });
    expect(all.games.some((game) => game.game_kind === "training")).toBe(true);
  });
});
