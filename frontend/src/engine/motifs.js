/**
 * What a move did, in words rather than in centipawns.
 *
 * A number tells you a move was bad. It does not tell you why, and "why" is
 * the part that transfers to the next game. This module answers the narrow
 * version of that question that can be answered from the position alone: which
 * pieces are now attacked, which are forked, which are pinned, whether the
 * rooks just connected.
 *
 * No engine. Everything here is geometry over chess.js, which means it works
 * on games analysed before it existed and costs nothing to compute on demand.
 * The engine's opinion - what the opponent would actually play in reply - is a
 * separate question needing the principal variation, which is not stored yet.
 *
 * The governing rule is that **a wrong annotation is worse than no annotation**.
 * It teaches something false, and the reader has no way to tell. So every
 * detector here is deliberately conservative: it reports only what it can
 * establish, and stays quiet on everything it cannot. Each one misses real
 * instances, on purpose, in exchange for never inventing one.
 *
 * Output is structured, not phrased. The French belongs to the screen; keeping
 * it out means these can be tested on facts rather than on wording.
 */

import { Chess } from "chess.js";

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

const SLIDERS = new Set(["b", "r", "q"]);
const FILES = "abcdefgh";

const other = (color) => (color === "w" ? "b" : "w");
const fileOf = (square) => square[0];
const rankOf = (square) => Number(square[1]);

/**
 * The same position with the other side to move.
 *
 * The en-passant square is cleared along with the turn: it belongs to the side
 * that was about to move, and leaving it behind offers the other side a
 * capture that is not legally there. Safe on a position with the mover to
 * play, because their opponent cannot be in check in one.
 */
export function flipTurn(fen, color) {
  const parts = fen.split(" ");
  parts[1] = color;
  parts[3] = "-";
  return parts.join(" ");
}

/** Every square holding a piece of `color`. */
function squaresOf(board, color, type) {
  const out = [];
  for (const row of board) {
    for (const square of row) {
      if (!square || square.color !== color) continue;
      if (type && square.type !== type) continue;
      out.push(square.square);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Material                                                            *
 * ------------------------------------------------------------------ */

/**
 * The material `color` can win with one capture, and the piece it takes.
 *
 * A two-ply exchange rather than a full one, and stated conservatively: a
 * capture counts only when the square cannot be recaptured at all, or when the
 * piece taken is worth more than the piece taking it. Both are true statements
 * about material whatever happens next.
 *
 * `attackers` is geometric and knows nothing about pins, so a defender that is
 * actually pinned still reads as a defender. That makes this under-report,
 * which is the direction to be wrong in.
 */
export function bestCapture(fen, color) {
  const position = new Chess(flipTurn(fen, color));
  let best = null;

  for (const move of position.moves({ verbose: true })) {
    if (!move.captured) continue;
    const victim = PIECE_VALUE[move.captured];
    const attacker = PIECE_VALUE[move.piece];

    const after = new Chess(flipTurn(fen, color));
    after.move(move.san);
    const recapture = after.attackers(move.to, other(color)).length > 0;

    const gain = recapture ? victim - attacker : victim;
    if (gain <= 0) continue;
    if (!best || gain > best.gain) {
      best = { gain, victim: move.captured, square: move.to, san: move.san, clean: !recapture };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Forks                                                               *
 * ------------------------------------------------------------------ */

/**
 * The pieces a piece on `square` forks.
 *
 * A target counts when it is worth more than the forking piece or is
 * undefended - taking a defended equal piece is a trade, not a fork - and the
 * forking piece must itself be out of reach, since a fork you can simply
 * capture is not one. Two targets or more and it is a fork.
 */
export function forkedBy(fen, square, color) {
  const position = new Chess(flipTurn(fen, color));
  const forker = position.get(square);
  if (!forker || forker.color !== color) return [];

  // A forking piece sitting on a square the defender attacks is answered by
  // taking it, unless it is a pawn, which nothing is worth trading down for.
  const capturable = position.attackers(square, other(color)).length > 0;
  if (capturable && forker.type !== "p") return [];

  const targets = [];
  for (const target of squaresOf(position.board(), other(color))) {
    if (!position.attackers(target, color).includes(square)) continue;
    const piece = position.get(target);
    const defended = position.attackers(target, other(color)).length > 0;
    if (PIECE_VALUE[piece.type] > PIECE_VALUE[forker.type] || !defended) {
      targets.push({ square: target, type: piece.type });
    }
  }
  return targets.length >= 2 ? targets : [];
}

/** Every fork `color` could set up in one move from this position. */
export function availableForks(fen, color) {
  const position = new Chess(flipTurn(fen, color));
  const found = [];
  for (const move of position.moves({ verbose: true })) {
    const next = new Chess(flipTurn(fen, color));
    next.move(move.san);
    const targets = forkedBy(next.fen(), move.to, color);
    if (targets.length) found.push({ san: move.san, square: move.to, targets });
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Pins                                                                *
 * ------------------------------------------------------------------ */

/**
 * Enemy pieces pinned against something more valuable behind them.
 *
 * Walked as a ray from each of `color`'s sliders: the first piece met must be
 * an enemy, the next one along the same line an enemy worth more. Both the
 * absolute pin against the king and the relative pin against a queen or rook
 * come out of the same walk.
 */
export function pinsBy(fen, color) {
  const position = new Chess(flipTurn(fen, color));
  const board = position.board();
  const at = (file, rank) =>
    file < 0 || file > 7 || rank < 1 || rank > 8 ? undefined : board[8 - rank][file];

  const rays = {
    b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
    q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
  };

  const pins = [];
  for (const from of squaresOf(board, color)) {
    const piece = position.get(from);
    if (!SLIDERS.has(piece.type)) continue;

    for (const [df, dr] of rays[piece.type]) {
      let file = FILES.indexOf(fileOf(from)) + df;
      let rank = rankOf(from) + dr;
      let front = null;

      while (file >= 0 && file <= 7 && rank >= 1 && rank <= 8) {
        const square = at(file, rank);
        if (square) {
          if (square.color === color) break; // our own piece blocks the ray
          if (!front) {
            front = square;
          } else {
            if (PIECE_VALUE[square.type] > PIECE_VALUE[front.type]) {
              pins.push({
                by: from,
                pinned: front.square,
                pinnedType: front.type,
                against: square.square,
                againstType: square.type,
              });
            }
            break;
          }
        }
        file += df;
        rank += dr;
      }
    }
  }
  return pins;
}

/* ------------------------------------------------------------------ *
 * Positional facts                                                    *
 * ------------------------------------------------------------------ */

/** Both rooks of `color` see each other along an empty rank or file. */
export function rooksConnected(fen, color) {
  const position = new Chess(fen);
  const rooks = squaresOf(position.board(), color, "r");
  if (rooks.length !== 2) return false;

  const [a, b] = rooks;
  const sameFile = fileOf(a) === fileOf(b);
  const sameRank = rankOf(a) === rankOf(b);
  if (!sameFile && !sameRank) return false;

  if (sameFile) {
    const [low, high] = [rankOf(a), rankOf(b)].sort((x, y) => x - y);
    for (let rank = low + 1; rank < high; rank += 1) {
      if (position.get(`${fileOf(a)}${rank}`)) return false;
    }
  } else {
    const [low, high] = [FILES.indexOf(fileOf(a)), FILES.indexOf(fileOf(b))].sort((x, y) => x - y);
    for (let file = low + 1; file < high; file += 1) {
      if (position.get(`${FILES[file]}${rankOf(a)}`)) return false;
    }
  }
  return true;
}

/** No pawn of either colour stands on this file. */
export function isOpenFile(fen, file) {
  const position = new Chess(fen);
  for (let rank = 1; rank <= 8; rank += 1) {
    if (position.get(`${file}${rank}`)?.type === "p") return false;
  }
  return true;
}

/** No enemy pawn can stop this one: its file and both neighbours are clear ahead. */
export function isPassedPawn(fen, square, color) {
  const position = new Chess(fen);
  const piece = position.get(square);
  if (piece?.type !== "p" || piece.color !== color) return false;

  const index = FILES.indexOf(fileOf(square));
  const forward = color === "w" ? 1 : -1;
  for (const file of [index - 1, index, index + 1]) {
    if (file < 0 || file > 7) continue;
    for (let rank = rankOf(square) + forward; rank >= 1 && rank <= 8; rank += forward) {
      const found = position.get(`${FILES[file]}${rank}`);
      if (found?.type === "p" && found.color !== color) return false;
    }
  }
  return true;
}

/** A mate the side to move can deliver in one. */
export function mateInOne(fen) {
  const position = new Chess(fen);
  for (const move of position.moves()) {
    const next = new Chess(fen);
    next.move(move);
    if (next.isCheckmate()) return move;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The move, described                                                 *
 * ------------------------------------------------------------------ */

/**
 * What one move achieved, and what it let the opponent have.
 *
 * Everything is stated as a difference between the position before and the
 * position after, so a piece that was already hanging is not blamed on the
 * move that failed to save it, and rooks that were already connected are not
 * credited to a move elsewhere on the board.
 *
 * @param {object} options
 * @param {string} options.before FEN before the move.
 * @param {string} options.after FEN after it.
 * @param {object} options.move The verbose chess.js move.
 * @returns {Array<{key: string, side: 'you'|'opponent', ...}>}
 */
export function motifsFor({ before, after, move }) {
  if (!before || !after || !move) return [];

  const color = move.color;
  const found = [];
  const add = (key, side, data = {}) => found.push({ key, side, ...data });

  const position = new Chess(after);

  // --- what the move did ---

  if (position.isCheckmate()) add("checkmate", "you");
  if (move.san.startsWith("O-O")) add("castled", "you", { long: move.san.startsWith("O-O-O") });
  if (move.promotion) add("promoted", "you", { to: move.promotion });

  if (!rooksConnected(before, color) && rooksConnected(after, color)) {
    add("rooksConnected", "you");
  }

  if (move.piece === "r" && isOpenFile(after, fileOf(move.to))) {
    add("rookOpenFile", "you", { file: fileOf(move.to) });
  }

  if (
    move.piece === "p" &&
    !isPassedPawn(before, move.from, color) &&
    isPassedPawn(after, move.to, color)
  ) {
    add("passedPawn", "you", { square: move.to });
  }

  const forks = forkedBy(after, move.to, color);
  if (forks.length) add("fork", "you", { square: move.to, piece: move.piece, targets: forks });

  const newPins = pinsBy(after, color).filter(
    (pin) => !pinsBy(before, color).some((old) => old.pinned === pin.pinned && old.by === pin.by),
  );
  if (newPins.length) add("pin", "you", newPins[0]);

  // --- what the move allowed ---

  // Compared against the same threat before the move: a piece that was already
  // hanging is not this move's doing.
  const wasLoose = bestCapture(before, other(color));
  const nowLoose = bestCapture(after, other(color));
  if (nowLoose && (!wasLoose || nowLoose.gain > wasLoose.gain)) {
    add("hangs", "opponent", {
      victim: nowLoose.victim,
      square: nowLoose.square,
      gain: nowLoose.gain,
      clean: nowLoose.clean,
      // The piece that just moved walking onto a square it can be taken on
      // reads very differently from a piece left behind somewhere else.
      moved: nowLoose.square === move.to,
    });
  }

  const forksBefore = availableForks(before, other(color));
  const forksAfter = availableForks(after, other(color));
  const newFork = forksAfter.find((fork) => !forksBefore.some((old) => old.san === fork.san));
  if (newFork) add("allowsFork", "opponent", newFork);

  const missed = mateInOne(before);
  if (missed && !position.isCheckmate()) add("missedMate", "you", { san: missed });

  return found;
}
