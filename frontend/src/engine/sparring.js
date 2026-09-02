/**
 * Playing a position out against the engine, rather than replaying what
 * happened.
 *
 * The analysis screen answers "what should you have played". This answers the
 * question that follows it and that a move list cannot: what happens if you
 * do. You take the position at any point of the game, play on, and the engine
 * answers - with the same verdict on each of your moves as the analysis gives,
 * because it is the same model. A move judged a blunder here would have been
 * judged a blunder there.
 *
 * Everything in this file is pure. The engine is passed in, which is what lets
 * the whole loop be exercised against a recorded one instead of a phone.
 */

import { Chess } from "chess.js";

import { clip, judgmentFor } from "./scoring.js";

/** Shallow and quick: this is a rally, not an analysis. */
export const SPARRING_LIMIT = { depth: 12, time: 0.6 };

/**
 * Legal destinations per square, in the shape Chessground wants.
 *
 * Built from chess.js rather than from the board, so pins, checks and castling
 * rights are all already accounted for: the board offers exactly the moves the
 * rules allow.
 */
export function legalDests(fen) {
  const position = new Chess(fen);
  const dests = new Map();
  for (const move of position.moves({ verbose: true })) {
    if (!dests.has(move.from)) dests.set(move.from, []);
    dests.get(move.from).push(move.to);
  }
  return dests;
}

/** Whose turn it is, spelled the way the board wants it. */
export function turnOf(fen) {
  return new Chess(fen).turn() === "w" ? "white" : "black";
}

/**
 * What a move cost its player.
 *
 * Both evaluations are White's point of view, as everything stored by this app
 * is, so the sign flips for Black and forgetting that is the mistake that
 * produces plausible numbers on every screen. Playing the move the engine
 * named cannot lose anything by definition; any difference there is the two
 * searches disagreeing, not a mistake.
 */
export function judgeMove({ before, after, color, wasBest }) {
  if (before?.cp === undefined || after?.cp === undefined) return null;
  const sign = color === "white" ? 1 : -1;
  const loss = wasBest ? 0 : Math.max(0, (clip(before.cp) - clip(after.cp)) * sign);
  return { cp_loss: loss, judgment: judgmentFor(loss), is_best: Boolean(wasBest) };
}

/** The game is over; say why, in the terms the screen shows. */
export function outcomeOf(fen) {
  const position = new Chess(fen);
  if (position.isCheckmate()) return { over: true, reason: "checkmate", winner: position.turn() === "w" ? "black" : "white" };
  if (position.isStalemate()) return { over: true, reason: "stalemate" };
  if (position.isInsufficientMaterial()) return { over: true, reason: "material" };
  if (position.isThreefoldRepetition()) return { over: true, reason: "repetition" };
  if (position.isDrawByFiftyMoves()) return { over: true, reason: "fiftyMoves" };
  if (position.isDraw()) return { over: true, reason: "draw" };
  return { over: false };
}

/**
 * Apply a move to a position.
 *
 * Promotion is taken rather than asked for: Chessground reports a drag as two
 * squares and has no opinion about what the pawn becomes, and a dialog in the
 * middle of a rally costs more than the one game in a hundred that wants a
 * knight. Returns null on an illegal move rather than throwing, because the
 * board can be dragged faster than the engine answers.
 */
export function applyMove(fen, from, to, promotion = "q") {
  const position = new Chess(fen);
  try {
    const move = position.move({ from, to, promotion });
    return move ? { fen: position.fen(), move } : null;
  } catch {
    return null;
  }
}

/**
 * One turn of the rally: judge what was played, then answer it.
 *
 * The two evaluations bracketing the user's move are what judges it, and the
 * second one is also what names the reply - so the engine is asked twice per
 * exchange rather than three times, which on a phone is the difference between
 * a board that answers and one that stalls.
 *
 * @param {object} options
 * @param {(fen: string, limit: object) => Promise<object>} options.evaluate
 * @param {string} options.before FEN the user moved from.
 * @param {string} options.after FEN after their move.
 * @param {string} options.color The user's colour.
 * @param {string} [options.bestBefore] The engine move in `before`, if already known.
 */
export async function respondTo({ evaluate, before, after, color, bestBefore, limit }) {
  const search = { ...SPARRING_LIMIT, ...(limit ?? {}) };

  const evalBefore = bestBefore
    ? bestBefore
    : await evaluate(before, search);

  const played = new Chess(before).moves({ verbose: true }).find((m) => {
    const next = new Chess(before);
    next.move(m.san);
    return next.fen() === after;
  });

  const evalAfter = await evaluate(after, search);
  const verdict = judgeMove({
    before: evalBefore,
    after: evalAfter,
    color,
    wasBest: Boolean(played && evalBefore?.best_uci === played.lan),
  });

  const ended = outcomeOf(after);
  if (ended.over) {
    return { verdict, best_move_uci: evalBefore?.best_uci ?? null, evaluation: evalAfter, reply: null, outcome: ended };
  }

  // The evaluation of the position the user just created already names the
  // move to answer with; there is nothing more to ask.
  const replyUci = evalAfter?.best_uci ?? null;
  const applied = replyUci
    ? applyMove(after, replyUci.slice(0, 2), replyUci.slice(2, 4), replyUci.slice(4) || "q")
    : null;

  return {
    verdict,
    best_move_uci: evalBefore?.best_uci ?? null,
    evaluation: evalAfter,
    reply: applied ? { ...applied.move, fen: applied.fen, uci: replyUci } : null,
    outcome: applied ? outcomeOf(applied.fen) : ended,
  };
}

/**
 * The engine plays, without a move of the user's to judge first.
 *
 * `respondTo` covers the rally: you move, it answers. This covers the opening
 * of one - taking over a position where it is not your turn, which is the
 * ordinary case on the analysis screen, because the board there shows the
 * position *after* the move being looked at. Without this the board sat on
 * "position à l'adversaire" with nothing able to move it: the engine was only
 * ever asked in response to a move the user could not make.
 */
export async function engineMove({ evaluate, fen, limit }) {
  const search = { ...SPARRING_LIMIT, ...(limit ?? {}) };

  const ended = outcomeOf(fen);
  if (ended.over) return { evaluation: null, reply: null, outcome: ended };

  const evaluation = await evaluate(fen, search);
  const uci = evaluation?.best_uci ?? null;
  const applied = uci
    ? applyMove(fen, uci.slice(0, 2), uci.slice(2, 4), uci.slice(4) || "q")
    : null;

  return {
    evaluation,
    reply: applied ? { ...applied.move, fen: applied.fen, uci } : null,
    outcome: applied ? outcomeOf(applied.fen) : ended,
  };
}
