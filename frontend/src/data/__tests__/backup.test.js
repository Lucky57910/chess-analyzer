/**
 * Backup round-trips, against real SQLite.
 *
 * The thing worth proving here is not that JSON.stringify works. It is that a
 * database exported and restored into an empty one is the same database - the
 * analyses in particular, since those are the part the user cannot get back
 * from Chess.com - and that restoring onto a database that already has games
 * neither duplicates them nor overwrites them.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import golden from "../__fixtures__/golden-data.json";
import {
  BACKUP_FORMAT,
  backupFilename,
  exportBackup,
  importBackup,
  validateBackup,
} from "../backup.js";
import { normalizeGame } from "../chessCom.js";
import { createRepository, migrate, nodeDriver } from "../db.js";
import { createGameStore } from "../games.js";
import { SCHEMA_VERSION } from "../schema.js";
import { SETTING_USERNAME } from "../sync.js";

const ME = "maxime";
const ROWS = golden.normalize.map(({ raw }) => normalizeGame(raw, ME)).filter(Boolean);

async function freshStore() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const driver = nodeDriver(database);
  await migrate(driver);
  const repo = createRepository(driver);
  return { repo, store: createGameStore(repo) };
}

const ANALYSIS = {
  engine_name: "Stockfish 17.1",
  engine_depth: 14,
  moves: [
    { ply: 1, color: "white", san: "e4", cp_loss: 0, judgment: null, phase: "opening" },
    { ply: 2, color: "black", san: "Qh4", cp_loss: 400, judgment: "blunder", phase: "opening" },
  ],
  accuracy_white: 88.1,
  accuracy_black: 61.4,
  acpl_white: 75,
  acpl_black: 230,
  judgment_counts: { white: { blunder: 0 }, black: { blunder: 1 } },
  phase_stats: { white: { opening: { moves: 1, acpl: 0, accuracy: 100 } } },
};

/** A database with games, one analysis and a stored username. */
async function populated() {
  const ctx = await freshStore();
  await ctx.repo.setSetting(SETTING_USERNAME, ME);
  await ctx.store.upsertMany(ROWS);
  const [first] = (await ctx.store.list({ limit: 1 })).games;
  await ctx.store.saveAnalysis(first.id, ANALYSIS);
  return { ...ctx, first };
}

describe("exportBackup", () => {
  it("carries every game, the settings and the analyses", async () => {
    const { repo, store } = await populated();
    const payload = await exportBackup(repo);

    expect(payload.app).toBe("chess-analyzer");
    expect(payload.format).toBe(BACKUP_FORMAT);
    expect(payload.games).toHaveLength(await store.count());
    expect(payload.settings[SETTING_USERNAME]).toBe(ME);
    expect(payload.games.filter((g) => g.analysis)).toHaveLength(1);
  });

  it("leaves out row ids, which mean nothing on another device", async () => {
    const { repo } = await populated();
    const payload = await exportBackup(repo);

    for (const game of payload.games) {
      expect(game).not.toHaveProperty("id");
      if (game.analysis) {
        expect(game.analysis).not.toHaveProperty("id");
        expect(game.analysis).not.toHaveProperty("game_id");
      }
    }
  });

  it("keeps the analysis JSON as objects, not encoded strings", async () => {
    const { repo } = await populated();
    const { analysis } = (await exportBackup(repo)).games.find((g) => g.analysis);

    expect(Array.isArray(analysis.moves)).toBe(true);
    expect(analysis.moves[1].judgment).toBe("blunder");
    expect(analysis.judgment_counts.black.blunder).toBe(1);
  });

  it("survives JSON, which is how it will actually travel", async () => {
    const { repo } = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(repo)));
    expect(() => validateBackup(payload)).not.toThrow();
  });

  it("names the file after the moment it was taken", () => {
    expect(backupFilename(new Date("2026-08-27T09:15:00Z"))).toBe(
      "chess-analyzer-2026-08-27T09-15-00.json",
    );
  });
});

describe("importBackup", () => {
  it("restores an archive into an empty database", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));

    const target = await freshStore();
    const result = await importBackup(target.repo, payload);

    expect(result.games).toBe(ROWS.length);
    expect(result.analyses).toBe(1);
    expect(await target.store.count()).toBe(ROWS.length);
    expect(await target.repo.getSetting(SETTING_USERNAME)).toBe(ME);
  });

  it("brings the analysis back intact, which is the whole point", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));

    // A game carrying an analysis is done, whatever the file says it was.
    payload.games.find((g) => g.analysis).analysis_status = "pending";

    const target = await freshStore();
    await importBackup(target.repo, payload);

    const before = await source.store.getAnalysis(source.first.id);
    const [game] = (await target.store.list({ limit: 100 })).games.filter(
      (g) => g.chess_com_game_id === source.first.chess_com_game_id,
    );
    const after = await target.store.getAnalysis(game.id);

    expect(after.moves).toEqual(before.moves);
    expect(after.judgment_counts).toEqual(before.judgment_counts);
    expect(after.accuracy_white).toBe(before.accuracy_white);
    expect(after.engine_depth).toBe(before.engine_depth);
    expect(game.analysis_status).toBe("done");
  });

  it("is idempotent: restoring the same file twice adds nothing", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));

    const target = await freshStore();
    await importBackup(target.repo, payload);
    const second = await importBackup(target.repo, payload);

    expect(second.games).toBe(0);
    expect(second.analyses).toBe(0);
    expect(second.skipped).toBe(ROWS.length);
    expect(await target.store.count()).toBe(ROWS.length);
  });

  it("does not overwrite a game the phone already has", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));
    // The file is stale: on the phone this game has since been re-analysed.
    payload.games[0].pgn = "[Event \"tampered\"]";

    const target = await populated();
    await importBackup(target.repo, payload);

    const kept = await target.repo.one("SELECT pgn FROM games WHERE chess_com_game_id = ?", [
      payload.games[0].chess_com_game_id,
    ]);
    expect(kept.pgn).not.toBe("[Event \"tampered\"]");
  });

  it("fills in an analysis the phone is missing", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));

    // Same games, none analysed.
    const target = await freshStore();
    await target.store.upsertMany(ROWS);
    const result = await importBackup(target.repo, payload);

    expect(result.games).toBe(0);
    expect(result.analyses).toBe(1);
    // The local row was 'pending'; gaining an analysis has to take it out of
    // the queue, or the evening of CPU we just restored gets spent again.
    const [game] = (await target.store.list({ limit: 100 })).games.filter(
      (g) => g.chess_com_game_id === source.first.chess_com_game_id,
    );
    expect(game.analysis_status).toBe("done");
  });

  it("leaves an analysis the phone already has alone", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));
    payload.games.find((g) => g.analysis).analysis.accuracy_white = 1.1;

    const target = await populated();
    await importBackup(target.repo, payload);

    const analysis = await target.store.getAnalysis(target.first.id);
    expect(analysis.accuracy_white).toBe(ANALYSIS.accuracy_white);
  });

  it("restores a truncated row rather than failing on a NOT NULL column", async () => {
    const target = await freshStore();
    const result = await importBackup(target.repo, {
      app: "chess-analyzer",
      format: 1,
      games: [{ chess_com_game_id: "x1", pgn: "1. e4", user_color: "white", result: "win", played_at: "2026-01-01T00:00:00Z" }],
    });

    expect(result.games).toBe(1);
    const row = await target.repo.one("SELECT * FROM games WHERE chess_com_game_id = 'x1'");
    expect(row.analysis_status).toBe("pending");
    expect(row.analysis_attempts).toBe(0);
    expect(row.created_at).toBeTruthy();
  });

  it("skips an entry with no game id instead of inserting a ghost", async () => {
    const target = await freshStore();
    const result = await importBackup(target.repo, {
      app: "chess-analyzer",
      format: 1,
      games: [{ pgn: "1. e4" }],
    });

    expect(result).toMatchObject({ games: 0, skipped: 1 });
    expect(await target.repo.one("SELECT COUNT(*) AS n FROM games")).toEqual({ n: 0 });
  });
});

describe("validateBackup", () => {
  const cases = [
    ["a plain string", "nope"],
    ["null", null],
    ["an array", []],
    ["another app's export", { app: "something-else", format: 1, games: [] }],
    ["a newer format", { app: "chess-analyzer", format: BACKUP_FORMAT + 1, games: [] }],
    ["a missing game list", { app: "chess-analyzer", format: 1 }],
  ];

  for (const [label, payload] of cases) {
    it(`refuses ${label}`, () => {
      expect(() => validateBackup(payload)).toThrow();
    });
  }

  it("accepts an older format, which is what forward compatibility means", () => {
    expect(() => validateBackup({ app: "chess-analyzer", format: 1, games: [] })).not.toThrow();
  });

  it("touches nothing when the file is rejected", async () => {
    const { repo, store } = await populated();
    await expect(importBackup(repo, { app: "elsewhere" })).rejects.toThrow();
    expect(await store.count()).toBe(ROWS.length);
  });
});

describe("restoring across a schema change", () => {
  // A backup written by an older release names the columns that existed then.
  // Restoring it into a newer schema has to work, which is what makes "a new
  // column is nullable or has a default" a rule for migrations rather than a
  // preference: a NOT NULL column with no default would make every backup this
  // user has ever taken unrestorable, and the analyses in them are the only
  // copy there is.
  it("takes an export written before the current schema existed", async () => {
    const { repo, store } = await populated();
    const older = await exportBackup(repo);
    older.schema_version = 1;

    const target = await freshStore();
    const result = await importBackup(target.repo, older);

    expect(result.games).toBe(ROWS.length);
    expect(result.analyses).toBe(1);
    expect(await target.store.count()).toBe(ROWS.length);
  });

  // The column lists in this file are explicit, so a file from a newer schema
  // would restore by quietly dropping what it knew and this version does not.
  // Losing part of a backup in silence is worse than refusing it.
  it("refuses an export from a newer schema instead of dropping what it cannot read", async () => {
    const { repo } = await populated();
    const newer = await exportBackup(repo);
    newer.schema_version = SCHEMA_VERSION + 1;

    expect(() => validateBackup(newer)).toThrow(/plus récent/);

    const target = await freshStore();
    await expect(importBackup(target.repo, newer)).rejects.toThrow();
    expect(await target.store.count()).toBe(0);
  });

  it("still accepts a file that never said which schema it came from", async () => {
    const { repo } = await populated();
    const anonymous = await exportBackup(repo);
    delete anonymous.schema_version;

    const target = await freshStore();
    expect((await importBackup(target.repo, anonymous)).games).toBe(ROWS.length);
  });
});

/**
 * The coach's commentary is the second thing in the file the phone cannot
 * recompute. Stockfish's numbers cost an evening of CPU; these cost a daily
 * API quota and a network the device may not have. Losing them in a restore
 * would mean paying for them twice.
 */
describe("the coach's commentary in a backup", () => {
  const NOTES = {
    1: "Tu ouvres au centre, c’est le plan le plus simple.",
    2: "La dame sort trop tôt et sera chassée avec gain de temps.",
  };

  async function withCommentary() {
    const ctx = await populated();
    await ctx.store.saveCoach(ctx.first.id, NOTES);
    return ctx;
  }

  it("travels with the analysis it describes", async () => {
    const source = await withCommentary();
    const payload = await exportBackup(source.repo);
    expect(payload.games.find((g) => g.analysis).analysis.coach).toEqual(NOTES);
  });

  it("comes back keyed by ply after a round trip", async () => {
    const source = await withCommentary();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));

    const target = await freshStore();
    await importBackup(target.repo, payload);

    const [game] = (await target.store.list({ limit: 100 })).games.filter(
      (g) => g.chess_com_game_id === source.first.chess_com_game_id,
    );
    expect((await target.store.getAnalysis(game.id)).coach).toEqual(NOTES);
  });

  // Every backup taken before the coach existed is missing the column. A
  // restore has to produce an empty object there, not a null the screens would
  // index into.
  it("restores a file written before the coach existed", async () => {
    const source = await populated();
    const payload = JSON.parse(JSON.stringify(await exportBackup(source.repo)));
    for (const entry of payload.games) {
      if (entry.analysis) delete entry.analysis.coach;
    }

    const target = await freshStore();
    await importBackup(target.repo, payload);

    const [game] = (await target.store.list({ limit: 100 })).games.filter(
      (g) => g.chess_com_game_id === source.first.chess_com_game_id,
    );
    expect((await target.store.getAnalysis(game.id)).coach).toEqual({});
  });
});
