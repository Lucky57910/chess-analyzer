/**
 * Storage and queue behaviour, against real SQLite.
 *
 * Node ships one, so the schema in schema.js is created, the queries in
 * games.js are planned and run, and the constraints actually fire. Mocking the
 * database here would test the mock: the interesting failures in this file are
 * a unique index that does not hold, a JSON column that round-trips wrong, and
 * a queue that hands out the same game twice.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import golden from "../__fixtures__/golden-data.json";
import { normalizeGame } from "../chessCom.js";
import { createRepository, hydrate, migrate, nodeDriver } from "../db.js";
import { createGameStore, MAX_ANALYSIS_ATTEMPTS } from "../games.js";
import { createSync, SETTING_USERNAME } from "../sync.js";

const ME = "maxime";

/** The normalize fixtures that produced a row, as import input. */
const ROWS = golden.normalize.map(({ raw }) => normalizeGame(raw, ME)).filter(Boolean);

async function freshStore() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const driver = nodeDriver(database);
  await migrate(driver);
  const repo = createRepository(driver);
  return { database, repo, store: createGameStore(repo) };
}

function analysisResult(overrides = {}) {
  return {
    engine_name: "Stockfish 17.1",
    engine_depth: 14,
    deep_positions: 2,
    scanned_positions: 10,
    moves: [
      { ply: 1, color: "white", san: "e4", cp_loss: 0, judgment: null, phase: "opening", move_number: 1 },
      { ply: 2, color: "black", san: "e5", cp_loss: 60, judgment: "inaccuracy", phase: "opening", move_number: 1 },
      { ply: 3, color: "white", san: "Nf3", cp_loss: 150, judgment: "mistake", phase: "opening", move_number: 2 },
      { ply: 4, color: "black", san: "Qh4", cp_loss: 400, judgment: "blunder", phase: "middlegame", move_number: 2 },
    ],
    accuracy_white: 88.1,
    accuracy_black: 61.4,
    acpl_white: 75.0,
    acpl_black: 230.0,
    judgment_counts: { white: { inaccuracy: 0, mistake: 1, blunder: 0 } },
    phase_stats: { white: { opening: { moves: 2, acpl: 75.0, accuracy: 88.1 } } },
    ...overrides,
  };
}

describe("migrate", () => {
  it("stamps a version so a later migration has a floor", async () => {
    const { repo } = await freshStore();
    const { values } = await repo.driver.query("PRAGMA user_version");
    expect(values[0].user_version).toBe(1);
  });

  it("is safe to run twice", async () => {
    const { repo } = await freshStore();
    await expect(migrate(repo.driver)).resolves.toBe(1);
  });
});

describe("settings", () => {
  it("round-trips values and survives being set twice", async () => {
    const { repo } = await freshStore();
    expect(await repo.getSetting("nope", "fallback")).toBe("fallback");
    await repo.setSetting(SETTING_USERNAME, "maxime");
    await repo.setSetting(SETTING_USERNAME, "someone-else");
    expect(await repo.getSetting(SETTING_USERNAME)).toBe("someone-else");
  });
});

describe("importing games", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await freshStore();
  });

  it("inserts each game once, however often it is re-imported", async () => {
    const first = await ctx.store.upsertMany(ROWS);
    expect(first.inserted).toBe(ROWS.length);

    const second = await ctx.store.upsertMany(ROWS);
    expect(second.inserted).toBe(0);
    expect(await ctx.store.count()).toBe(ROWS.length);
  });

  // Chess.com fills its accuracy in after review, usually after we imported
  // the game. Skipping known games outright would mean never seeing it.
  it("fills in an accuracy that arrived after the first import", async () => {
    const withoutAccuracy = { ...ROWS[0], chess_com_accuracy: null };
    await ctx.store.upsertMany([withoutAccuracy]);

    const result = await ctx.store.upsertMany([{ ...ROWS[0], chess_com_accuracy: 87.3 }]);
    expect(result).toEqual({ inserted: 0, updated: 1 });

    const stored = await ctx.store.get(1);
    expect(stored.chess_com_accuracy).toBe(87.3);
  });

  it("does not overwrite an accuracy that is already there", async () => {
    await ctx.store.upsertMany([{ ...ROWS[0], chess_com_accuracy: 87.3 }]);
    const result = await ctx.store.upsertMany([{ ...ROWS[0], chess_com_accuracy: 12.0 }]);
    expect(result.updated).toBe(0);
    expect((await ctx.store.get(1)).chess_com_accuracy).toBe(87.3);
  });

  it("stores booleans SQLite has no type for", async () => {
    const unrated = ROWS.find((r) => r.rated === false);
    await ctx.store.upsertMany([unrated]);
    const stored = await ctx.store.get(1);
    expect(stored.rated).toBe(false);
  });
});

describe("listing", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await freshStore();
    await ctx.store.upsertMany(ROWS);
  });

  it("returns newest first", async () => {
    const { games } = await ctx.store.list({ limit: 100 });
    const times = games.map((g) => g.end_time);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("filters, and reports the total for the filter rather than the page", async () => {
    const { games, total } = await ctx.store.list({ color: "black", limit: 1 });
    expect(games.length).toBe(1);
    expect(games[0].user_color).toBe("black");
    const all = await ctx.store.list({ color: "black", limit: 100 });
    expect(total).toBe(all.games.length);
    expect(total).toBeGreaterThan(1);
  });

  it("pages without repeating or dropping a row", async () => {
    const all = await ctx.store.list({ limit: 100 });
    const firstPage = await ctx.store.list({ limit: 3, offset: 0 });
    const secondPage = await ctx.store.list({ limit: 3, offset: 3 });
    const ids = [...firstPage.games, ...secondPage.games].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(all.games.slice(0, 6).map((g) => g.id));
  });
});

describe("analysis storage", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await freshStore();
    await ctx.store.upsertMany(ROWS.slice(0, 3));
  });

  it("round-trips the JSON columns", async () => {
    await ctx.store.saveAnalysis(1, analysisResult());
    const stored = await ctx.store.getAnalysis(1);
    expect(stored.moves).toHaveLength(4);
    expect(stored.judgment_counts).toEqual({ white: { inaccuracy: 0, mistake: 1, blunder: 0 } });
    expect(stored.phase_stats.white.opening.acpl).toBe(75.0);
  });

  it("derives the error and blunder subsets", async () => {
    await ctx.store.saveAnalysis(1, analysisResult());
    const stored = await ctx.store.getAnalysis(1);
    expect(stored.errors.map((m) => m.san)).toEqual(["Nf3", "Qh4"]);
    expect(stored.blunders.map((m) => m.san)).toEqual(["Qh4"]);
    expect(stored.moves_evaluated).toBe(4);
  });

  it("replaces in place rather than accumulating rows", async () => {
    await ctx.store.saveAnalysis(1, analysisResult({ engine_depth: 10 }));
    await ctx.store.saveAnalysis(1, analysisResult({ engine_depth: 18, accuracy_white: 90.0 }));

    const rows = await ctx.repo.all("SELECT * FROM analyses WHERE game_id = 1");
    expect(rows).toHaveLength(1);
    expect(rows[0].engine_depth).toBe(18);
    expect(rows[0].accuracy_white).toBe(90.0);
  });

  it("marks the game done and clears any earlier error", async () => {
    await ctx.store.markFailed(1, "boom");
    await ctx.store.saveAnalysis(1, analysisResult());
    const game = await ctx.store.get(1);
    expect(game.analysis_status).toBe("done");
    expect(game.analysis_error).toBeNull();
  });

  it("reads accuracy from the user's side, not White's", async () => {
    const white = { user_color: "white" };
    const black = { user_color: "black" };
    const analysis = { accuracy_white: 88.1, accuracy_black: 61.4 };
    expect(ctx.store.accuracyFor(white, analysis)).toBe(88.1);
    expect(ctx.store.accuracyFor(black, analysis)).toBe(61.4);
    expect(ctx.store.accuracyFor(white, null)).toBeNull();
  });

  it("deletes the analysis with the game", async () => {
    await ctx.store.saveAnalysis(1, analysisResult());
    await ctx.repo.run("DELETE FROM games WHERE id = 1");
    expect(await ctx.store.getAnalysis(1)).toBeNull();
  });
});

describe("the queue", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await freshStore();
    await ctx.store.upsertMany(ROWS.slice(0, 4));
  });

  it("hands out the newest pending game", async () => {
    const first = await ctx.store.nextPending();
    const { games } = await ctx.store.list({ limit: 100 });
    expect(first.id).toBe(games[0].id);
  });

  it("retires a game after too many attempts instead of looping on it", async () => {
    const game = await ctx.store.nextPending();
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i += 1) await ctx.store.markRunning(game.id);
    const next = await ctx.store.nextPending();
    expect(next?.id).not.toBe(game.id);
  });

  it("gives an engine failure its attempt back", async () => {
    const game = await ctx.store.nextPending();
    await ctx.store.markRunning(game.id);
    await ctx.store.markUnattempted(game.id, "Stockfish binary missing");

    const stored = await ctx.store.get(game.id);
    expect(stored.analysis_attempts).toBe(0);
    expect(stored.analysis_status).toBe("pending");
    expect((await ctx.store.nextPending()).id).toBe(game.id);
  });

  // Fresh games must beat re-deepening old ones, or importing a month of games
  // while a re-analysis is running would never show any of them.
  it("prefers a pending game over a stale one", async () => {
    await ctx.store.saveAnalysis(1, analysisResult({ engine_depth: 8 }));
    const next = await ctx.store.nextPending();
    expect(next).not.toBeNull();
    expect(next.id).not.toBe(1);
  });

  it("only offers a stale game once nothing is pending", async () => {
    const { games } = await ctx.store.list({ limit: 100 });
    for (const game of games) await ctx.store.saveAnalysis(game.id, analysisResult({ engine_depth: 8 }));

    expect(await ctx.store.nextPending()).toBeNull();
    expect((await ctx.store.nextStale(14)).id).toBeDefined();
    expect(await ctx.store.nextStale(8)).toBeNull();
  });

  it("counts what is left to do", async () => {
    await ctx.store.saveAnalysis(1, analysisResult({ engine_depth: 8 }));
    await ctx.store.markFailed(2, "boom");
    const status = await ctx.store.queueStatus(14);
    expect(status).toEqual({ pending: 2, running: 0, done: 1, error: 1, stale: 1 });
  });
});

describe("hydrate", () => {
  it("survives a JSON column it cannot parse", () => {
    const row = hydrate({ moves: "{not json", judgment_counts: "also not", rated: 1 });
    expect(row.moves).toEqual([]);
    expect(row.judgment_counts).toEqual({});
    expect(row.rated).toBe(true);
  });
});

describe("sync", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await freshStore();
    await ctx.repo.setSetting(SETTING_USERNAME, ME);
  });

  const fakeClient = (entries) => ({
    fetchCurrentMonth: async () => entries,
    fetchRecentMonths: async () => entries,
  });

  it("imports, counting what it refused", async () => {
    const entries = golden.normalize.map((c) => c.raw);
    const sync = createSync({
      repo: ctx.repo,
      store: ctx.store,
      client: fakeClient(entries),
      evaluate: async () => {
        throw new Error("not used");
      },
    });

    const result = await sync.importGames({ months: 3 });
    expect(result.inserted).toBe(ROWS.length);
    expect(result.skipped).toBe(entries.length - ROWS.length);
    expect(result.skipped).toBeGreaterThan(0);
    expect(await ctx.repo.getSetting("last_synced_at")).toBeTruthy();
  });

  it("does nothing at all without a username", async () => {
    await ctx.repo.run("DELETE FROM settings");
    const sync = createSync({
      repo: ctx.repo,
      store: ctx.store,
      client: fakeClient([]),
      evaluate: async () => ({}),
    });
    expect(await sync.importGames({ months: 3 })).toEqual({
      inserted: 0,
      updated: 0,
      skipped: 0,
    });
  });
});
