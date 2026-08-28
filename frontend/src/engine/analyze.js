/**
 * Two-pass game analysis, ported from `analyse_pgn` in
 * backend/app/services/engine.py.
 *
 * The engine itself is injected. This module never talks to Stockfish, it only
 * decides which positions are worth asking about and what the answers mean.
 * That keeps the whole judgment pipeline testable by replaying a recording of
 * real engine calls (see __fixtures__/golden.json), and it is also the seam
 * the native Android plugin plugs into.
 */

import { Chess } from "chess.js";

import { aggregate, clip, judgmentFor, moveAccuracy, roundTo, winPercentWhite } from "./scoring.js";

/** Mirrors the Python settings this module reads. */
export const DEFAULT_SETTINGS = {
  engine_depth: 18,
  engine_scan_depth: 10,
  engine_deep_threshold_cp: 150,
  engine_deep_window: 1,
  engine_max_time: 3.0,
  max_plies: 200,
};

/** Opening until move 12, endgame once the heavy material is gone. */
export function phaseOf(fen) {
  const board = new Chess(fen);
  let pieces = 0;
  for (const row of board.board()) {
    for (const square of row) {
      if (square && "nbrq".includes(square.type)) pieces += 1;
    }
  }
  if (pieces <= 6) return "endgame";
  if (board.moveNumber() <= 12) return "opening";
  return "middlegame";
}

/**
 * Positions the shallow pass says are worth a real search.
 *
 * Wherever the evaluation moves by more than the threshold, that pair and its
 * neighbours are queued for the deep pass. Targets come out as contiguous runs
 * on purpose: accuracy compares consecutive positions, so both ends of a
 * comparison must have been searched to the same depth or the difference in
 * search alone shows up as a mistake. Only the edge of a run straddles two
 * depths, and an edge sits in a stretch quiet enough not to have been flagged.
 */
export function deepTargets(positions, settings = DEFAULT_SETTINGS) {
  const window = settings.engine_deep_window;
  const flagged = new Set();
  for (let i = 1; i < positions.length; i += 1) {
    const drift = Math.abs(clip(positions[i].cp) - clip(positions[i - 1].cp));
    if (drift >= settings.engine_deep_threshold_cp) {
      for (let j = Math.max(0, i - window); j < Math.min(positions.length, i + window + 1); j += 1) {
        flagged.add(j);
      }
    }
  }
  return [...flagged].sort((a, b) => a - b);
}

/**
 * Evaluate every position of the game, then derive per-move stats.
 *
 * Two passes. A cheap one sweeps every position, then the expensive one
 * revisits only the positions where the cheap one saw the evaluation move.
 * Quiet positions are quiet at any depth, so paying full price for them buys
 * nothing.
 *
 * Position i is evaluated once per pass: its eval is the "before" of move i and
 * the "after" of move i-1, so the sweep costs N+1 engine calls.
 *
 * @param {string} pgn
 * @param {object} options
 * @param {(fen: string, limit: object) => Promise<object>} options.evaluate
 *   Returns `{ cp, mate, best_uci, depth }` for one position. `cp` is White POV
 *   with mates already folded to +-MATE_CP.
 * @param {string} [options.engineName]
 * @param {number} [options.depth]
 * @param {object} [options.settings]
 * @param {(done: number, total: number) => void} [options.onProgress]
 */
export async function analysePgn(pgn, options) {
  const { evaluate, engineName = "stockfish", onProgress } = options;
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };
  const depth = options.depth ?? settings.engine_depth;

  const game = new Chess();
  try {
    game.loadPgn(pgn);
  } catch (cause) {
    throw new Error("Unreadable PGN", { cause });
  }

  const history = game.history({ verbose: true }).slice(0, settings.max_plies);
  if (!history.length) throw new Error("PGN contains no moves");

  const scanLimit = { depth: Math.min(settings.engine_scan_depth, depth), time: null };
  const deepLimit = { depth, time: settings.engine_max_time };

  // One FEN per position, starting position included: N moves, N + 1 positions.
  // chess.js and python-chess agree on the en-passant convention (the square
  // appears only when a legal capture can use it), so these strings match the
  // ones the backend fed Stockfish. The fixture test asserts every FEN, which
  // is what would catch a chess.js release changing its mind about that.
  const fens = [history[0].before, ...history.map((m) => m.after)];
  const meta = fens.map((fen) => ({
    phase: phaseOf(fen),
    fullmove: Number(fen.split(" ")[5]),
  }));

  // Identifies the game so the driver can send `ucinewgame` between games: the
  // transposition table is shared across the positions of one game, which is
  // what makes the sweep cheap, and cleared between them, which keeps a
  // re-analysis reproducible.
  const token = Symbol("game");
  const total = fens.length;
  let done = 0;
  const tick = () => {
    done += 1;
    onProgress?.(done, total);
  };

  const positions = [];
  for (const fen of fens) {
    positions.push(await evaluate(fen, { ...scanLimit, token }));
    tick();
  }

  const targets = deepTargets(positions, settings);
  for (const index of targets) {
    positions[index] = await evaluate(fens[index], { ...deepLimit, token });
    onProgress?.(done, total + targets.length);
  }

  // Only the deepened positions are expected to reach `depth`; the rest are
  // meant to sit at the scan depth.
  const truncated = targets
    .map((i) => positions[i].depth)
    .filter((reached) => (reached ?? depth) < depth);
  if (truncated.length && truncated.length > targets.length / 2) {
    console.warn(
      `deep pass hit the time cap on ${truncated.length}/${targets.length} positions ` +
        `(reached depth ${Math.min(...truncated)}, wanted ${depth}); ` +
        "raise engine_max_time or lower engine_depth",
    );
  }

  // Second pass: replay the game, pairing consecutive evals.
  const replay = new Chess(fens[0]);
  const moves = history.map((historic, i) => {
    const moverWhite = replay.turn() === "w";
    const before = positions[i];
    const after = positions[i + 1];

    const sign = moverWhite ? 1 : -1;
    const isBest = before.best_uci === historic.lan;
    // Playing the engine top move cannot lose value; any delta here is search
    // noise from evaluating the two positions at different plies.
    const cpLoss = isBest ? 0 : Math.max(0, (clip(before.cp) - clip(after.cp)) * sign);

    let winBefore = winPercentWhite(before.cp);
    let winAfter = winPercentWhite(after.cp);
    if (!moverWhite) {
      winBefore = 100 - winBefore;
      winAfter = 100 - winAfter;
    }
    if (isBest) winAfter = Math.max(winAfter, winBefore);

    const move = replay.move(historic.san);

    return {
      ply: i + 1,
      move_number: meta[i].fullmove,
      color: moverWhite ? "white" : "black",
      san: move.san,
      uci: move.lan,
      // No FEN here: the client replays the PGN it already holds.
      eval_cp: after.cp, // White POV, drives the graph
      eval_mate: after.mate,
      eval_cp_before: before.cp,
      eval_mate_before: before.mate,
      best_move_san: bestSan(fens[i], before.best_uci),
      best_move_uci: before.best_uci,
      is_best: isBest,
      cp_loss: cpLoss,
      accuracy: roundTo(moveAccuracy(winBefore, winAfter), 1),
      judgment: judgmentFor(cpLoss),
      phase: meta[i].phase,
      // The two lines that explain a bad move: what the engine wanted instead,
      // and how the opponent punishes what was played. Attached only to moves
      // that were actually judged - everywhere else nothing reads them, and
      // they would be stored on every ply of every game for nothing.
      //
      // Conditional rather than nulled, so a run whose evaluations carry no
      // variation - the recorded Python calls, which never had one - produces
      // exactly the object it always did.
      ...(judgmentFor(cpLoss) && before.pv?.length > 1 ? { best_line: before.pv } : {}),
      ...(judgmentFor(cpLoss) && after.pv?.length ? { reply_line: after.pv } : {}),
    };
  });

  return {
    engine_name: engineName,
    // The requested depth, not the reached one: staleness is measured against
    // it, and a time cap that always bites would otherwise queue the same game
    // forever.
    engine_depth: depth,
    deep_positions: targets.length,
    scanned_positions: positions.length,
    moves,
    ...aggregate(moves),
  };
}

/** SAN for a UCI move in a position, so the driver only has to speak UCI. */
function bestSan(fen, uci) {
  if (!uci) return null;
  const board = new Chess(fen);
  const move = board
    .moves({ verbose: true })
    .find((candidate) => candidate.lan === uci);
  return move ? move.san : null;
}
