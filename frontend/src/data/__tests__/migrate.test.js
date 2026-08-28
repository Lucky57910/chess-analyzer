/**
 * The migration runner, against real SQLite.
 *
 * This is the piece with the worst failure mode in the app. The database on
 * the phone is the only copy of analyses that took it hours to compute, there
 * is no server holding a second one, and a migration that half-applies or
 * silently skips leaves a schema nothing else in the code expects. So the
 * cases below are the awkward ones: an install from an older release, a step
 * that throws in the middle, a step that runs twice because the process died
 * before the version was stamped, and a database from a version of the app
 * that is newer than the code opening it.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { addColumn, createRepository, migrate, nodeDriver, pendingMigrations } from "../db.js";
import { MIGRATIONS, SCHEMA, SCHEMA_VERSION } from "../schema.js";

function fresh() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return { database, driver: nodeDriver(database) };
}

const version = (database) => database.prepare("PRAGMA user_version").get().user_version;

const tables = (database) =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

const indexes = (database) =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);

/** A database as a phone that installed v0.2.0 would have it. */
async function asShippedV1() {
  const { database, driver } = fresh();
  await driver.execute(SCHEMA);
  await driver.execute("PRAGMA user_version = 1");
  database
    .prepare(
      `INSERT INTO games (chess_com_game_id, pgn, user_color, result, played_at, created_at)
       VALUES ('kept-1', '1. e4 e5', 'white', 'win', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO analyses (game_id, created_at, updated_at)
       VALUES (1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    )
    .run();
  return { database, driver };
}

describe("the shipped migration list", () => {
  it("is ordered, unique, and stops at the schema version", () => {
    const versions = MIGRATIONS.map((step) => step.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    // Version 1 is the baseline script, not a step.
    expect(versions.every((v) => v > 1)).toBe(true);
    expect(Math.max(1, ...versions)).toBe(SCHEMA_VERSION);
  });

  it("gives every step something to run and a name to read", () => {
    for (const step of MIGRATIONS) {
      expect(typeof step.name, `step ${step.version}`).toBe("string");
      expect(Boolean(step.sql) || typeof step.run === "function").toBe(true);
    }
  });
});

describe("pendingMigrations", () => {
  const steps = [
    { version: 4, name: "d", sql: "" },
    { version: 2, name: "b", sql: "" },
    { version: 3, name: "c", sql: "" },
  ];

  it("returns what is missing, oldest first, whatever order it was given", () => {
    expect(pendingMigrations(1, steps).map((s) => s.version)).toEqual([2, 3, 4]);
    expect(pendingMigrations(3, steps).map((s) => s.version)).toEqual([4]);
    expect(pendingMigrations(4, steps)).toEqual([]);
  });
});

describe("migrating a new database", () => {
  it("creates the schema and lands on the current version", async () => {
    const { database, driver } = fresh();
    expect(await migrate(driver)).toBe(SCHEMA_VERSION);
    expect(version(database)).toBe(SCHEMA_VERSION);
    expect(tables(database)).toEqual(expect.arrayContaining(["settings", "games", "analyses"]));
  });

  it("runs the shipped steps rather than assuming the baseline covers them", async () => {
    const { database, driver } = fresh();
    await migrate(driver);
    // The baseline is frozen at version 1, so anything newer has to have been
    // applied as a step. If the baseline were quietly kept up to date instead,
    // this index would exist on new installs and be missing on old ones.
    expect(indexes(database)).toContain("ix_analyses_updated");
  });
});

describe("migrating a database from an older release", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await asShippedV1();
  });

  it("applies what is missing and keeps the data", async () => {
    expect(version(ctx.database)).toBe(1);
    await migrate(ctx.driver);

    expect(version(ctx.database)).toBe(SCHEMA_VERSION);
    expect(indexes(ctx.database)).toContain("ix_analyses_updated");
    expect(ctx.database.prepare("SELECT COUNT(*) AS n FROM games").get().n).toBe(1);
    expect(ctx.database.prepare("SELECT COUNT(*) AS n FROM analyses").get().n).toBe(1);
  });

  it("is a no-op the second time", async () => {
    await migrate(ctx.driver);
    const before = version(ctx.database);

    let ran = 0;
    await migrate(ctx.driver, [
      { version: 2, name: "should not run", run: async () => (ran += 1) },
    ]);
    expect(ran).toBe(0);
    expect(version(ctx.database)).toBe(before);
  });
});

describe("when a step fails", () => {
  // The version is stamped after each step rather than once at the end, so an
  // upgrade that dies in the middle resumes instead of replaying the steps
  // that already took.
  it("keeps the versions of the steps that did succeed", async () => {
    const { database, driver } = fresh();
    const steps = [
      { version: 2, name: "ok", sql: "CREATE TABLE IF NOT EXISTS first (x INTEGER);" },
      {
        version: 3,
        name: "boom",
        run: async () => {
          throw new Error("interrupted");
        },
      },
      { version: 4, name: "never", sql: "CREATE TABLE IF NOT EXISTS third (x INTEGER);" },
    ];

    await expect(migrate(driver, steps)).rejects.toThrow("interrupted");
    expect(version(database)).toBe(2);
    expect(tables(database)).toContain("first");
    expect(tables(database)).not.toContain("third");
  });

  it("carries on from where it stopped once the step is fixed", async () => {
    const { database, driver } = fresh();
    let attempts = 0;
    const flaky = {
      version: 2,
      name: "flaky",
      run: async (d) => {
        attempts += 1;
        if (attempts === 1) throw new Error("interrupted");
        await d.execute("CREATE TABLE IF NOT EXISTS late (x INTEGER);");
      },
    };

    await expect(migrate(driver, [flaky])).rejects.toThrow("interrupted");
    expect(version(database)).toBe(0);

    await migrate(driver, [flaky]);
    expect(tables(database)).toContain("late");
    expect(version(database)).toBe(SCHEMA_VERSION);
  });

  // The process can be killed between the step and the stamp, so every step
  // has to survive being run twice.
  it("is safe when a step runs again because the stamp never landed", async () => {
    const { database, driver } = fresh();
    const step = {
      version: 2,
      name: "idempotent",
      sql: "CREATE INDEX IF NOT EXISTS ix_twice ON games (result);",
    };

    await driver.execute(SCHEMA);
    await driver.execute(step.sql);
    // The stamp did not land: the version is still what it was.
    await driver.execute("PRAGMA user_version = 1");

    await migrate(driver, [step]);
    expect(indexes(database).filter((name) => name === "ix_twice").length).toBe(1);
    expect(version(database)).toBe(SCHEMA_VERSION);
  });
});

describe("a database from a newer version of the app", () => {
  // Sideloaded app, so a downgrade happens. Writing to a schema this code does
  // not understand is how the only copy of the analyses gets damaged.
  it("is refused rather than written to", async () => {
    const { database, driver } = fresh();
    await migrate(driver);
    await driver.execute(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);

    await expect(migrate(driver)).rejects.toThrow(/plus récente/);
    expect(version(database)).toBe(SCHEMA_VERSION + 5);
  });

  it("does not run a single step before refusing", async () => {
    const { driver } = fresh();
    await migrate(driver);
    await driver.execute(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    let ran = 0;
    await expect(
      migrate(driver, [{ version: SCHEMA_VERSION, name: "x", run: async () => (ran += 1) }]),
    ).rejects.toThrow();
    expect(ran).toBe(0);
  });
});

describe("addColumn", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await asShippedV1();
  });

  it("adds the column and fills the existing rows with its default", async () => {
    expect(await addColumn(ctx.driver, "games", "game_kind", "TEXT NOT NULL DEFAULT 'rated'")).toBe(
      true,
    );
    const row = ctx.database.prepare("SELECT game_kind FROM games").get();
    expect(row.game_kind).toBe("rated");
  });

  it("says no and changes nothing when the column is already there", async () => {
    await addColumn(ctx.driver, "games", "game_kind", "TEXT DEFAULT 'rated'");
    ctx.database.prepare("UPDATE games SET game_kind = 'training'").run();

    expect(await addColumn(ctx.driver, "games", "game_kind", "TEXT DEFAULT 'rated'")).toBe(false);
    // A second ALTER would have thrown; a second one that succeeded would have
    // reset the value. Neither happened.
    expect(ctx.database.prepare("SELECT game_kind FROM games").get().game_kind).toBe("training");
  });

  it("is not fooled by a column of that name on another table", async () => {
    await addColumn(ctx.driver, "analyses", "note", "TEXT");
    expect(await addColumn(ctx.driver, "games", "note", "TEXT")).toBe(true);
  });
});

describe("the repository over a migrated database", () => {
  it("reads and writes through the schema the runner produced", async () => {
    const { driver } = fresh();
    await migrate(driver);
    const repo = createRepository(driver);

    await repo.setSetting("chess_com_username", "maxime");
    expect(await repo.getSetting("chess_com_username")).toBe("maxime");
  });
});

describe("the game-kind migration", () => {
  /** A v1 database with one rated game and one unrated one already in it. */
  async function withMixedGames() {
    const { database, driver } = fresh();
    await driver.execute(SCHEMA);
    await driver.execute("PRAGMA user_version = 1");
    for (const [id, rated] of [
      ["rated-one", 1],
      ["casual-one", 0],
    ]) {
      database
        .prepare(
          `INSERT INTO games (chess_com_game_id, pgn, user_color, result, rated, played_at, created_at)
           VALUES (?, '1. e4', 'white', 'win', ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
        )
        .run(id, rated);
    }
    return { database, driver };
  }

  const kinds = (database) =>
    Object.fromEntries(
      database
        .prepare("SELECT chess_com_game_id AS id, game_kind FROM games")
        .all()
        .map((row) => [row.id, row.game_kind]),
    );

  // The column has to work on the archive already on the phone, not only on
  // games synced from here on: the whole point is to clean up existing stats.
  it("backfills the games that were already imported", async () => {
    const ctx = await withMixedGames();
    await migrate(ctx.driver);

    expect(kinds(ctx.database)).toEqual({ "rated-one": "rated", "casual-one": "training" });
  });

  it("indexes the column it just added", async () => {
    const ctx = await withMixedGames();
    await migrate(ctx.driver);
    expect(indexes(ctx.database)).toContain("ix_games_kind");
  });

  // Re-running happens whenever the process dies between the step and the
  // stamp. Undoing a decision made since would be the expensive kind of bug.
  // Re-running happens whenever the process dies between the step and the
  // stamp, so the step has to land on the same answer every time. It does
  // because it derives the kind rather than deciding it - and the flip side,
  // asserted here so nobody is surprised by it later, is that it overwrites
  // anything that changed the column since.
  it("recomputes the same answer when it runs again", async () => {
    const ctx = await withMixedGames();
    await migrate(ctx.driver);
    const first = kinds(ctx.database);

    ctx.database.prepare("UPDATE games SET game_kind = 'rated'").run();
    await ctx.driver.execute("PRAGMA user_version = 2");
    await migrate(ctx.driver);

    expect(kinds(ctx.database)).toEqual(first);
  });
});
