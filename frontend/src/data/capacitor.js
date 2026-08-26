/**
 * The device half of the data layer: real SQLite, real HTTP, real engine.
 *
 * Everything here is untestable off-device by construction, which is exactly
 * why it is this thin. It wires plugins together and holds no logic worth
 * checking - all of that lives in the modules it hands them to, where Node's
 * SQLite and a fake HTTP client can reach it.
 */

import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { CapacitorHttp, registerPlugin } from "@capacitor/core";

import { createStockfish } from "../engine/stockfish.js";
import { createClient } from "./chessCom.js";
import { createRepository, migrate } from "./db.js";
import { createGameStore } from "./games.js";
import { SCHEMA_VERSION } from "./schema.js";

export const DATABASE_NAME = "chess-analyzer";

/** The native Stockfish plugin, registered in MainActivity. */
export const Stockfish = registerPlugin("Stockfish");

/**
 * Adapt @capacitor-community/sqlite to the Driver contract.
 *
 * The contract was shaped after this plugin's own methods, so the adapting is
 * mostly naming. `query` and `run` already return `{values}` and `{changes}`.
 */
function capacitorDriver(connection) {
  return {
    execute: (sql) => connection.execute(sql),
    query: (sql, values = []) => connection.query(sql, values),
    run: (sql, values = []) => connection.run(sql, values, false),
  };
}

export async function openDatabase() {
  const sqlite = new SQLiteConnection(CapacitorSQLite);

  // A connection left behind by a previous run of the app - a reload during
  // development, a crash - makes createConnection fail rather than reconnect.
  const consistent = await sqlite.checkConnectionsConsistency().catch(() => ({ result: false }));
  const existing = await sqlite.isConnection(DATABASE_NAME, false).catch(() => ({ result: false }));
  const connection =
    consistent.result && existing.result
      ? await sqlite.retrieveConnection(DATABASE_NAME, false)
      : await sqlite.createConnection(DATABASE_NAME, false, "no-encryption", SCHEMA_VERSION, false);

  await connection.open();
  const driver = capacitorDriver(connection);
  await driver.execute("PRAGMA foreign_keys = ON");
  await migrate(driver);

  return { sqlite, connection, driver };
}

/**
 * Everything the app needs, wired.
 *
 * `threads` is left at one by default. The phone has more cores than that, but
 * they are shared with the UI thread rendering the progress the user is
 * watching, and a second search thread buys less than a board that stops
 * stuttering.
 */
export async function createApp({ threads = 1, hashMb = 128, settings } = {}) {
  const { sqlite, connection, driver } = await openDatabase();
  const repo = createRepository(driver);
  const store = createGameStore(repo);
  const client = createClient(CapacitorHttp);
  const engine = createStockfish(Stockfish, { threads, hashMb });

  return {
    repo,
    store,
    client,
    engine,
    settings,
    evaluate: engine.evaluate,
    async close() {
      await engine.quit().catch(() => {});
      await connection.close().catch(() => {});
      await sqlite.closeConnection(DATABASE_NAME, false).catch(() => {});
    },
  };
}
