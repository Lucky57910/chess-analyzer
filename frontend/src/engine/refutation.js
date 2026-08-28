/**
 * Why a move was bad, in the engine's own words.
 *
 * `motifs.js` reads a position: which pieces are attacked, forked, pinned.
 * That answers "what did this move do" but not "and then what", which is the
 * half that makes a blunder make sense - the piece is not lost on the move
 * that hangs it, it is lost two plies later.
 *
 * The missing piece was the principal variation. The driver kept only its
 * first move and threw the rest away; it now keeps four plies, stored on
 * judged moves. Replaying them and running the position detectors along the
 * way turns a number into a sentence: the opponent plays this, and then this,
 * and that is a fork.
 *
 * A game analysed before any of this has no variation stored. Nothing here
 * invents one - it returns nothing, and the screen falls back to what the
 * position alone can say.
 */

import { Chess } from "chess.js";

import { motifsFor } from "./motifs.js";
import { applyMove } from "./sparring.js";

/**
 * Motifs worth interrupting the reader for, most telling first.
 *
 * A line contains something on nearly every ply; saying all of it is noise.
 * These are ordered by how much they explain, and the first one found is the
 * one the line gets described by.
 */
const TELLING = ["checkmate", "fork", "pin", "hangs", "promoted", "passedPawn"];

/**
 * Play a variation out, collecting what each move does.
 *
 * Stops at the first move that will not play. An engine line is a claim about
 * a search, not a promise about this position: it can be truncated, and a
 * stored one can outlive the analysis it came from. Stopping quietly is the
 * only reasonable answer - the alternative is a screen that will not open.
 */
export function replayLine(fen, line) {
  if (!fen || !Array.isArray(line) || !line.length) return [];

  const steps = [];
  let current = fen;

  for (const uci of line) {
    if (typeof uci !== "string" || uci.length < 4) break;
    const applied = applyMove(current, uci.slice(0, 2), uci.slice(2, 4), uci.slice(4) || "q");
    if (!applied) break;

    steps.push({
      uci,
      san: applied.move.san,
      color: applied.move.color === "w" ? "white" : "black",
      before: current,
      after: applied.fen,
      motifs: motifsFor({ before: current, after: applied.fen, move: applied.move }),
    });
    current = applied.fen;
  }
  return steps;
}

/** The first thing in a played-out line worth naming, with the move that did it. */
export function keyMoment(steps) {
  for (const key of TELLING) {
    const step = steps.find((s) => s.motifs.some((m) => m.key === key && m.side === "you"));
    if (step) return { step, motif: step.motifs.find((m) => m.key === key && m.side === "you") };
  }
  return null;
}

/**
 * What the opponent does about the move that was played.
 *
 * The line is read from the position the move created, so its first ply is the
 * reply and the side to move throughout is the opponent's. A motif credited to
 * "you" inside this replay therefore belongs to them - the perspective is the
 * mover's at each ply, not the reviewer's, and confusing the two would report
 * the opponent's fork as the reader's own.
 */
export function refutation(move, fenAfter) {
  const steps = replayLine(fenAfter, move?.reply_line);
  if (!steps.length) return null;
  return { steps, moment: keyMoment(steps) };
}

/**
 * What the move the engine wanted would have led to.
 *
 * Read from the position before the move, so its first ply is the move that
 * should have been played and the side to move is the reader's own.
 */
export function bestLine(move, fenBefore) {
  if (!move?.best_line?.length) return null;
  const steps = replayLine(fenBefore, move.best_line);
  if (!steps.length) return null;
  return { steps, moment: keyMoment(steps) };
}

/** The line as a readable sequence of moves: `Cf7+ Rg8 Cxd8`. */
export function lineText(steps, limit = 4) {
  return steps
    .slice(0, limit)
    .map((step) => step.san)
    .join(" ");
}

/** Whose move opens a line read from this position. */
export function moverOf(fen) {
  return new Chess(fen).turn() === "w" ? "white" : "black";
}
