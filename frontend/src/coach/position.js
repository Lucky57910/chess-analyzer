/**
 * Standing facts about a position, for the coach to talk about.
 *
 * `motifs.js` answers "what did this move just do" — a fork appeared, a piece
 * hangs, the rooks connected. That is the right question for a tactic and the
 * wrong one for everything a coach actually says between tactics: your king is
 * still on e1 at move fourteen, you have doubled pawns on the c-file, you have
 * moved that knight three times and developed nothing else.
 *
 * Those are properties of a position, not events in a move, so they live here.
 * Every one of them is computed from the FEN with chess.js: deterministic,
 * free, offline, and — the point — *given* to the model rather than left for
 * it to work out. A model asked to judge king safety from a board will guess;
 * a model told "roi en e1, non roqué, coup 14" cannot.
 *
 * Nothing here is phrasing. `digest.js` turns it into French.
 */

import { Chess } from "chess.js";

const FILES = "abcdefgh";
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const HOME_RANK = { w: "1", b: "8" };

const fileOf = (square) => square[0];
const rankOf = (square) => Number(square[1]);

/** Every occupied square, as `{square, type, color}`. */
function pieces(fen) {
  const out = [];
  for (const row of new Chess(fen).board()) {
    for (const square of row) if (square) out.push(square);
  }
  return out;
}

/**
 * Material, counted in pawns, from `color`'s point of view.
 *
 * Kings excluded — they are always one each, and including them at any value
 * only adds a constant.
 */
export function materialBalance(fen, color) {
  let balance = 0;
  for (const piece of pieces(fen)) {
    const value = VALUE[piece.type] ?? 0;
    balance += piece.color === color ? value : -value;
  }
  return balance;
}

/**
 * Where the king is, and whether anything is standing in front of it.
 *
 * Castling is read off the square rather than off the move history, so this
 * works on any position handed to it — including one reached by a game the
 * app never watched being played. A king on g1/g8 or c1/c8 that has left its
 * home square has castled for every practical purpose the coach cares about;
 * calling that "castled" when it walked there by hand is a rounding error we
 * accept, and it is the safe direction: it under-reports danger rather than
 * inventing it.
 */
export function kingSafety(fen, color) {
  const position = new Chess(fen);
  const king = pieces(fen).find((p) => p.type === "k" && p.color === color);
  if (!king) return null;

  const file = fileOf(king.square);
  const home = HOME_RANK[color];
  const onHomeRank = king.square[1] === home;
  const side = file === "g" || file === "h" ? "short" : file <= "c" ? "long" : null;
  const castled = onHomeRank && side !== null && file !== "e";

  // The three squares in front of the king, on its own file and its
  // neighbours. A pawn there is a shield; an empty file in front of a castled
  // king is the thing worth saying out loud.
  const index = FILES.indexOf(file);
  const forward = color === "w" ? 1 : -1;
  let shield = 0;
  for (const f of [index - 1, index, index + 1]) {
    if (f < 0 || f > 7) continue;
    const ahead = rankOf(king.square) + forward;
    if (ahead < 1 || ahead > 8) continue;
    const found = position.get(`${FILES[f]}${ahead}`);
    if (found?.type === "p" && found.color === color) shield += 1;
  }

  return {
    square: king.square,
    castled,
    side: castled ? side : null,
    // Still on e-file and still at home: the king never left the centre.
    central: file === "d" || file === "e",
    shield,
  };
}

/**
 * Pawn structure, per side, as the four things worth a sentence.
 *
 * Deliberately not a full evaluation. These are the weaknesses a player under
 * 1800 can act on: a pawn nobody can defend, a file with two of them, and a
 * pawn nothing can stop.
 */
export function pawnStructure(fen, color) {
  const pawns = pieces(fen).filter((p) => p.type === "p" && p.color === color);
  const enemy = pieces(fen).filter((p) => p.type === "p" && p.color !== color);
  const byFile = new Map();
  for (const pawn of pawns) {
    const file = fileOf(pawn.square);
    byFile.set(file, [...(byFile.get(file) ?? []), pawn.square]);
  }

  const doubled = [];
  const isolated = [];
  const passed = [];

  for (const [file, squares] of byFile) {
    if (squares.length > 1) doubled.push(file);
    const index = FILES.indexOf(file);
    const hasNeighbour =
      byFile.has(FILES[index - 1]) || byFile.has(FILES[index + 1]);
    if (!hasNeighbour) isolated.push(...squares);
  }

  const forward = color === "w" ? 1 : -1;
  for (const pawn of pawns) {
    const index = FILES.indexOf(fileOf(pawn.square));
    const blocked = enemy.some((other) => {
      const otherFile = FILES.indexOf(fileOf(other.square));
      if (Math.abs(otherFile - index) > 1) return false;
      const ahead = (rankOf(other.square) - rankOf(pawn.square)) * forward;
      return ahead > 0;
    });
    if (!blocked) passed.push(pawn.square);
  }

  return { count: pawns.length, doubled, isolated, passed };
}

/** Minor pieces and rooks still sitting on their starting rank. */
export function undeveloped(fen, color) {
  const home = HOME_RANK[color];
  return pieces(fen)
    .filter(
      (p) =>
        p.color === color &&
        (p.type === "n" || p.type === "b") &&
        p.square[1] === home,
    )
    .map((p) => p.square);
}

/**
 * Pieces moved more than once inside the opening, and how often.
 *
 * The single most common structural error at club level, invisible to a
 * per-position detector because it is a fact about the *sequence*: nothing
 * about the board at move ten says the knight got there in four moves.
 *
 * Tracked by destination square rather than by piece identity — chess.js gives
 * no stable piece id — so a knight that goes f3–g5–f3 reads as two moves of
 * "the piece now on f3", which is what we want to say anyway.
 *
 * @param {Array} moves Merged plies for one side, in order.
 * @param {number} untilMoveNumber Opening cutoff; the same 12 `phaseOf` uses.
 */
export function repeatedPieceMoves(moves, untilMoveNumber = 12) {
  const counts = new Map();
  for (const move of moves) {
    if (move.move_number > untilMoveNumber) break;
    const type = move.move?.piece;
    if (!type || type === "p") continue; // a pawn moving twice is a pawn chain
    const key = `${type}:${move.move.to}`;
    const seen = counts.get(key) ?? { type, square: move.move.to, times: 0 };
    // Follow the piece: a move landing where the tracked one started is the
    // same piece moving again.
    for (const [otherKey, entry] of counts) {
      if (entry.type === type && entry.square === move.move.from) {
        counts.delete(otherKey);
        seen.times = entry.times;
        break;
      }
    }
    seen.times += 1;
    counts.set(key, seen);
  }
  return [...counts.values()].filter((entry) => entry.times > 1);
}

/**
 * Everything above, for one position.
 *
 * Returned as data. It costs a handful of board walks per move, which is
 * nothing next to the engine pass that produced the analysis in the first
 * place, and it happens once per game rather than once per screen.
 */
export function positionFacts(fen, color) {
  const short = color === "white" ? "w" : "b";
  return {
    material: materialBalance(fen, short),
    king: kingSafety(fen, short),
    pawns: pawnStructure(fen, short),
    undeveloped: undeveloped(fen, short),
  };
}
