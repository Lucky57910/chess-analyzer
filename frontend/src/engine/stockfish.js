/**
 * UCI driver: turns the native plugin's line stream into the `evaluate`
 * function `analysePgn` expects.
 *
 * This is where the protocol lives. The Java side only moves bytes; every
 * decision about what a line means is here, in JS, where the tests can reach
 * it - including the two conversions that are easy to get silently wrong:
 *
 *   * UCI scores are relative to the side to move. The rest of the app is
 *     White-POV throughout, matching what the Python backend stored, so a
 *     score seen with Black to move is negated here and nowhere else.
 *   * A mate is folded into a centipawn score the same way python-chess did it
 *     with `mate_score=10000`: mate in n becomes +-(10000 - n), so a faster
 *     mate outranks a slower one and the clip in scoring.js still applies.
 */

import { MATE_CP } from "./scoring.js";

const DEFAULT_TIMEOUT_MS = 60_000;

/** `score cp 43` / `score mate -2`, relative to the side to move. */
function parseScore(tokens, whiteToMove) {
  const at = tokens.indexOf("score");
  if (at === -1) return null;

  const kind = tokens[at + 1];
  const value = Number(tokens[at + 2]);
  if (!Number.isFinite(value)) return null;

  if (kind === "cp") {
    return { cp: whiteToMove ? value : -value, mate: null };
  }
  if (kind !== "mate") return null;

  if (value === 0) {
    // `mate 0` is the engine saying the side to move has already been mated,
    // so the score belongs to the other side. There is no distance to report.
    return { cp: whiteToMove ? -MATE_CP : MATE_CP, mate: 0 };
  }
  const mate = whiteToMove ? value : -value;
  return { cp: Math.sign(mate) * (MATE_CP - Math.abs(mate)), mate };
}

function parseInfo(line, whiteToMove) {
  // Aspiration-window searches emit provisional scores flagged as bounds. They
  // are not evaluations of the position and taking one as final would report a
  // swing the engine never actually claimed.
  if (line.includes("lowerbound") || line.includes("upperbound")) return null;

  const tokens = line.split(/\s+/);
  const score = parseScore(tokens, whiteToMove);
  if (!score) return null;

  const depthAt = tokens.indexOf("depth");
  const pvAt = tokens.indexOf("pv");

  return {
    cp: score.cp,
    mate: score.mate,
    // python-chess reported the principal variation's first move, not the
    // `bestmove` line, and the two can disagree on the final iteration.
    best_uci: pvAt !== -1 && tokens[pvAt + 1] ? tokens[pvAt + 1] : null,
    depth: depthAt !== -1 ? Number(tokens[depthAt + 1]) : null,
  };
}

/**
 * Serialise access to one engine process.
 *
 * Stockfish has a single search state, so two overlapping `go` commands would
 * interleave into nonsense. Calls queue instead.
 */
function createQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * @param {object} plugin Capacitor plugin: `start`, `cmd`, `stop`, `info`,
 *   `addListener(event, handler)`.
 * @param {object} [options]
 * @param {number} [options.threads]
 * @param {number} [options.hashMb]
 * @param {number} [options.timeoutMs]
 */
export function createStockfish(plugin, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const enqueue = createQueue();

  let listener = null;
  let onLine = null;
  let started = false;
  let lastToken = null;

  const handle = (line) => onLine?.(line);

  /** Send `command`, then resolve on the first line `done` accepts. */
  const exchange = (command, done) =>
    new Promise((resolve, reject) => {
      const lines = [];
      const timer = setTimeout(() => {
        onLine = null;
        reject(new Error(`Engine timed out after ${timeoutMs}ms waiting on \`${command}\``));
      }, timeoutMs);

      onLine = (line) => {
        lines.push(line);
        const result = done(line, lines);
        if (result === undefined) return;
        clearTimeout(timer);
        onLine = null;
        resolve(result);
      };

      plugin.cmd({ command }).catch((error) => {
        clearTimeout(timer);
        onLine = null;
        reject(error);
      });
    });

  async function start() {
    if (started) return;
    await plugin.start();
    listener = await plugin.addListener("line", (event) => handle(event.line));

    await exchange("uci", (line) => (line === "uciok" ? true : undefined));

    const threads = options.threads ?? 1;
    const hashMb = options.hashMb ?? 64;
    await plugin.cmd({ command: `setoption name Threads value ${threads}` });
    await plugin.cmd({ command: `setoption name Hash value ${hashMb}` });
    await exchange("isready", (line) => (line === "readyok" ? true : undefined));
    started = true;
  }

  /**
   * One engine call, in the shape scoring.js and analyze.js consume.
   *
   * `token` identifies the game: `ucinewgame` goes out whenever it changes, so
   * the transposition table is shared across the positions of one game - which
   * is what makes the shallow sweep cheap - and cleared between games, which
   * keeps a re-analysis of the same game reproducible.
   */
  const evaluate = (fen, limit = {}) =>
    enqueue(async () => {
      await start();

      if (limit.token !== undefined && limit.token !== lastToken) {
        lastToken = limit.token;
        await plugin.cmd({ command: "ucinewgame" });
        await exchange("isready", (line) => (line === "readyok" ? true : undefined));
      }

      const whiteToMove = fen.split(/\s+/)[1] === "w";
      await plugin.cmd({ command: `position fen ${fen}` });

      let best = null;
      const go = [
        "go",
        limit.depth ? `depth ${limit.depth}` : null,
        limit.time ? `movetime ${Math.round(limit.time * 1000)}` : null,
      ]
        .filter(Boolean)
        .join(" ");

      await exchange(go, (line) => {
        if (line.startsWith("info")) {
          const info = parseInfo(line, whiteToMove);
          if (info) best = info;
          return undefined;
        }
        return line.startsWith("bestmove") ? true : undefined;
      });

      if (!best) {
        throw new Error(`Engine returned no evaluation for ${fen}`);
      }
      return best;
    });

  async function quit() {
    if (listener) await listener.remove();
    listener = null;
    onLine = null;
    started = false;
    lastToken = null;
    await plugin.stop();
  }

  return { start, evaluate, quit, info: () => plugin.info() };
}

export const __testing = { parseInfo, parseScore };
