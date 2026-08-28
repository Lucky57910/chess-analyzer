/**
 * Database access, behind a driver so the queries can be tested for real.
 *
 * `@capacitor-community/sqlite` only exists on the device, which would leave
 * every query in this app unexercised until someone installs an APK. The three
 * methods below are the whole surface it needs, shaped the way that plugin
 * already shapes them, so the device adapter is a pass-through and the test
 * adapter is Node's own SQLite. The SQL that runs in the tests is the SQL that
 * runs on the phone.
 *
 * @typedef {object} Driver
 * @property {(sql: string) => Promise<unknown>} execute Run a statement batch.
 * @property {(sql: string, values?: unknown[]) => Promise<{values: object[]}>} query
 * @property {(sql: string, values?: unknown[]) => Promise<{changes: {changes: number, lastId: number}}>} run
 */

import { JSON_COLUMNS, MIGRATIONS, SCHEMA, SCHEMA_VERSION } from "./schema.js";

/** Parse the JSON-bearing columns of a row, leaving everything else alone. */
export function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const column of JSON_COLUMNS) {
    if (typeof out[column] === "string") {
      try {
        out[column] = JSON.parse(out[column]);
      } catch {
        // A row we cannot parse is a row we cannot trust; an empty value keeps
        // the screen rendering instead of taking the whole list down.
        out[column] = column === "judgment_counts" || column === "phase_stats" ? {} : [];
      }
    }
  }
  // SQLite has no boolean type.
  if ("rated" in out) out.rated = Boolean(out.rated);
  return out;
}

async function userVersion(driver) {
  const { values } = await driver.query("PRAGMA user_version");
  return values?.[0]?.user_version ?? 0;
}

/**
 * Add a column if the table does not already have it.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and a migration step has to be
 * safe to re-run: the version is stamped after the step, so a process killed
 * in between runs it again. Looking first is the whole trick.
 */
export async function addColumn(driver, table, column, definition) {
  const { values } = await driver.query(`PRAGMA table_info(${table})`);
  if ((values ?? []).some((row) => row.name === column)) return false;
  await driver.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** The steps still to apply, in order, given the version on disk. */
export function pendingMigrations(current, steps = MIGRATIONS) {
  return steps.filter((step) => step.version > current).sort((a, b) => a.version - b.version);
}

/**
 * Bring the database up to `SCHEMA_VERSION`.
 *
 * The baseline is created first and is version 1 throughout, so a new database
 * and one installed a year ago meet at the same place and walk the same steps
 * from there. Each step is applied and then stamped, separately and in that
 * order: if the app is killed between the two the step runs again on the next
 * launch, which is why every step has to be idempotent. Stamping first would
 * skip a step that never actually ran.
 *
 * A database from a newer version of the app is refused rather than written
 * to. This app is sideloaded, so a downgrade is a thing that happens, and the
 * local database is the only copy of analyses that cost hours of phone.
 */
export async function migrate(driver, steps = MIGRATIONS) {
  await driver.execute(SCHEMA);

  const current = await userVersion(driver);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Cette base de données vient d’une version plus récente de l’application ` +
        `(schéma ${current}, cette version en gère ${SCHEMA_VERSION}). ` +
        `Réinstallez la version la plus récente : ouvrir la base avec cette version-ci ` +
        `l’abîmerait.`,
    );
  }

  for (const step of pendingMigrations(current, steps)) {
    if (step.run) await step.run(driver);
    else await driver.execute(step.sql);
    await driver.execute(`PRAGMA user_version = ${step.version}`);
  }

  // A database that was already current still gets stamped, which is what
  // carries a version-1 install with no steps to run up to today.
  const reached = await userVersion(driver);
  if (reached < SCHEMA_VERSION) {
    await driver.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return SCHEMA_VERSION;
}

export function createRepository(driver) {
  const all = async (sql, values = []) => {
    const result = await driver.query(sql, values);
    return (result.values ?? []).map(hydrate);
  };
  const one = async (sql, values = []) => (await all(sql, values))[0] ?? null;

  return {
    driver,
    all,
    one,
    run: (sql, values = []) => driver.run(sql, values),

    async getSetting(key, fallback = null) {
      const row = await one("SELECT value FROM settings WHERE key = ?", [key]);
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return fallback;
      }
    },

    async setSetting(key, value) {
      await driver.run(
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, JSON.stringify(value)],
      );
    },
  };
}

/**
 * Node's built-in SQLite, for tests.
 *
 * Kept in the source tree rather than the test folder because it is the
 * reference implementation of the Driver contract: when the device adapter
 * misbehaves, this is what it is compared against.
 */
export function nodeDriver(database) {
  return {
    async execute(sql) {
      database.exec(sql);
    },
    async query(sql, values = []) {
      const rows = database.prepare(sql).all(...values);
      return { values: rows.map((row) => ({ ...row })) };
    },
    async run(sql, values = []) {
      const result = database.prepare(sql).run(...values);
      return {
        changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) },
      };
    },
  };
}
