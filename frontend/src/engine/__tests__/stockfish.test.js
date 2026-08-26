/**
 * Driver tests, driven by the same tape as the scoring tests.
 *
 * The tape records what python-chess reported for every position of two real
 * games, already converted to White POV. Here we run that backwards:
 * synthesise the raw UCI the engine must have emitted to produce each taped
 * value - relative to whichever side was to move - and require the driver to
 * arrive back at the recorded number.
 *
 * That covers the two conversions with no natural feedback loop. A sign error
 * on Black's evaluations looks perfectly plausible on screen; here it fails
 * on the first position with Black to move.
 */

import { describe, expect, it, vi } from "vitest";

import golden from "../__fixtures__/golden.json";
import { analysePgn } from "../analyze.js";
import { MATE_CP } from "../scoring.js";
import { createStockfish } from "../stockfish.js";

/** The UCI lines an engine would emit to report `result` for `fen`. */
function uciFor(fen, result) {
  const whiteToMove = fen.split(/\s+/)[1] === "w";
  const relative = (value) => (whiteToMove ? value : -value);
  const lines = [];

  if (result.mate === 0) {
    lines.push("info depth 0 score mate 0");
    lines.push("bestmove (none)");
    return lines;
  }

  const score =
    result.mate === null
      ? `cp ${relative(result.cp)}`
      : `mate ${whiteToMove ? result.mate : -result.mate}`;

  // A shallower line first, so the test fails if the driver keeps the earliest
  // evaluation rather than the last one.
  lines.push(`info depth 1 seldepth 2 score cp ${relative(0)} nodes 20 pv e2e4`);
  lines.push(
    `info depth ${result.depth} seldepth ${result.depth + 4} multipv 1 score ${score} ` +
      `nodes 100000 nps 900000 time 110 pv ${result.best_uci} e7e5`,
  );
  // A bound *after* the real evaluation: this is what a search stopped by
  // `movetime` mid aspiration-window leaves behind, and the score attached to
  // it is nonsense. Absurd on purpose - taking it would be unmissable.
  lines.push(`info depth ${result.depth + 1} score cp ${relative(4321)} lowerbound nodes 2 pv a2a3`);
  lines.push(`bestmove ${result.best_uci}`);
  return lines;
}

/**
 * A plugin stand-in that answers from the tape.
 *
 * It asserts the driver asked about the position it was supposed to, in the
 * order the Python run did, so a reordering or a skipped position fails here
 * rather than silently returning someone else's evaluation.
 */
function fakePlugin(calls) {
  const tape = [...calls];
  const state = { commands: [], fen: null, listeners: [], stopped: false };

  const emit = (line) => {
    for (const handler of state.listeners) handler({ line });
  };

  const plugin = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      state.stopped = true;
    }),
    info: vi.fn(async () => ({ available: true, running: true })),
    addListener: vi.fn(async (event, handler) => {
      if (event === "line") state.listeners.push(handler);
      return {
        remove: async () => {
          state.listeners = state.listeners.filter((h) => h !== handler);
        },
      };
    }),
    cmd: vi.fn(async ({ command }) => {
      state.commands.push(command);
      if (command === "uci") {
        emit("id name Stockfish 17.1");
        emit("option name Hash type spin default 16 min 1 max 33554432");
        emit("uciok");
      } else if (command === "isready") {
        emit("readyok");
      } else if (command.startsWith("position fen ")) {
        state.fen = command.slice("position fen ".length);
      } else if (command.startsWith("go")) {
        const call = tape.shift();
        expect(call, "ran out of taped calls").toBeDefined();
        expect(state.fen, "position asked about").toBe(call.fen);
        expect(command, "search limit").toContain(`depth ${call.limit_depth}`);
        for (const line of uciFor(call.fen, call.result)) emit(line);
      }
    }),
  };
  return { plugin, state, remaining: () => tape.length };
}

describe("score conversion", () => {
  const cases = [
    { fen: "w", line: "info depth 12 score cp 43 pv e2e4", cp: 43, mate: null },
    { fen: "b", line: "info depth 12 score cp 43 pv e7e5", cp: -43, mate: null },
    { fen: "w", line: "info depth 12 score cp -150 pv e2e4", cp: -150, mate: null },
    { fen: "b", line: "info depth 12 score cp -150 pv e7e5", cp: 150, mate: null },
    { fen: "w", line: "info depth 12 score mate 3 pv e2e4", cp: MATE_CP - 3, mate: 3 },
    { fen: "b", line: "info depth 12 score mate 3 pv e7e5", cp: -(MATE_CP - 3), mate: -3 },
    { fen: "w", line: "info depth 12 score mate -2 pv e2e4", cp: -(MATE_CP - 2), mate: -2 },
    { fen: "b", line: "info depth 12 score mate -2 pv e7e5", cp: MATE_CP - 2, mate: 2 },
    { fen: "w", line: "info depth 0 score mate 0", cp: -MATE_CP, mate: 0 },
    { fen: "b", line: "info depth 0 score mate 0", cp: MATE_CP, mate: 0 },
  ];

  for (const { fen, line, cp, mate } of cases) {
    it(`${line} with ${fen === "w" ? "White" : "Black"} to move`, async () => {
      const board = `8/8/8/8/8/8/8/8 ${fen} - - 0 1`;
      const { plugin } = fakePlugin([]);
      plugin.cmd = vi.fn(async ({ command }) => {
        if (command === "uci") plugin.__emit("uciok");
        else if (command === "isready") plugin.__emit("readyok");
        else if (command.startsWith("go")) {
          plugin.__emit(line);
          plugin.__emit("bestmove e2e4");
        }
      });
      let handler;
      plugin.addListener = async (_event, cb) => {
        handler = cb;
        return { remove: async () => {} };
      };
      plugin.__emit = (text) => handler({ line: text });

      const engine = createStockfish(plugin);
      const result = await engine.evaluate(board, { depth: 12 });
      expect(result.cp).toBe(cp);
      expect(result.mate).toBe(mate);
    });
  }

  it("ignores bounded scores", async () => {
    let handler;
    const plugin = {
      start: async () => {},
      stop: async () => {},
      info: async () => ({}),
      addListener: async (_event, cb) => {
        handler = cb;
        return { remove: async () => {} };
      },
      cmd: async ({ command }) => {
        const emit = (line) => handler({ line });
        if (command === "uci") emit("uciok");
        else if (command === "isready") emit("readyok");
        else if (command.startsWith("go")) {
          emit("info depth 10 score cp 25 pv d2d4");
          // Stopped mid-window: the last thing said is a bound, not a verdict.
          emit("info depth 11 score cp 900 upperbound pv e2e4");
          emit("bestmove d2d4");
        }
      },
    };
    const engine = createStockfish(plugin);
    const result = await engine.evaluate("8/8/8/8/8/8/8/8 w - - 0 1", { depth: 10 });
    expect(result.cp).toBe(25);
    expect(result.best_uci).toBe("d2d4");
  });
});

describe("driver replaying the taped games", () => {
  for (const [name, game] of Object.entries(golden.games)) {
    it(`${name} reproduces every taped evaluation`, async () => {
      const { plugin, remaining } = fakePlugin(game.calls);
      const engine = createStockfish(plugin);

      for (const call of game.calls) {
        const result = await engine.evaluate(call.fen, {
          depth: call.limit_depth,
          time: call.limit_time,
          token: "game",
        });
        expect(result.cp, `${call.fen} cp`).toBe(call.result.cp);
        expect(result.mate, `${call.fen} mate`).toBe(call.result.mate);
        expect(result.best_uci, `${call.fen} best`).toBe(call.result.best_uci);
        expect(result.depth, `${call.fen} depth`).toBe(call.result.depth);
      }
      expect(remaining()).toBe(0);
    });

    it(`${name} drives analysePgn to the Python result`, async () => {
      const { plugin, state, remaining } = fakePlugin(game.calls);
      const engine = createStockfish(plugin);

      const result = await analysePgn(game.pgn, {
        evaluate: engine.evaluate,
        engineName: game.expected.engine_name,
        settings: game.settings,
      });

      expect(result).toEqual(game.expected);
      expect(remaining(), "taped calls left unconsumed").toBe(0);

      // One `ucinewgame` for the whole game, not one per position: the shared
      // transposition table is what makes the shallow sweep affordable.
      const resets = state.commands.filter((c) => c === "ucinewgame");
      expect(resets.length).toBe(1);
    });
  }
});

describe("session handling", () => {
  it("configures threads and hash before searching", async () => {
    const { plugin, state } = fakePlugin(golden.games.scholars_mate.calls);
    const engine = createStockfish(plugin, { threads: 2, hashMb: 256 });
    const first = golden.games.scholars_mate.calls[0];
    await engine.evaluate(first.fen, { depth: first.limit_depth });

    expect(state.commands).toContain("setoption name Threads value 2");
    expect(state.commands).toContain("setoption name Hash value 256");
    expect(state.commands.indexOf("setoption name Hash value 256")).toBeLessThan(
      state.commands.findIndex((c) => c.startsWith("go")),
    );
  });

  it("starts the engine once across many evaluations", async () => {
    const game = golden.games.scholars_mate;
    const { plugin } = fakePlugin(game.calls);
    const engine = createStockfish(plugin);
    for (const call of game.calls) {
      await engine.evaluate(call.fen, { depth: call.limit_depth, time: call.limit_time });
    }
    expect(plugin.start).toHaveBeenCalledTimes(1);
  });

  it("times out instead of hanging when the engine goes silent", async () => {
    const plugin = {
      start: async () => {},
      stop: async () => {},
      info: async () => ({}),
      addListener: async () => ({ remove: async () => {} }),
      cmd: async () => {},
    };
    const engine = createStockfish(plugin, { timeoutMs: 20 });
    await expect(engine.evaluate("8/8/8/8/8/8/8/8 w - - 0 1", { depth: 1 })).rejects.toThrow(
      /timed out/,
    );
  });
});
