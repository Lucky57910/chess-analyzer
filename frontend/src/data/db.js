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

import { JSON_COLUMNS, SCHEMA, SCHEMA_VERSION } from "./schema.js";

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

export async function migrate(driver) {
  await driver.execute(SCHEMA);
  const { values } = await driver.query("PRAGMA user_version");
  const current = values?.[0]?.user_version ?? 0;
  if (current < SCHEMA_VERSION) {
    // No migration steps yet - the schema above is version 1 and is created
    // whole. This records the version so the first real migration has a floor
    // to work from rather than having to guess what shipped.
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
