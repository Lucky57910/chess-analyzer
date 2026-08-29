/**
 * The facts the coach is given about a position, rather than left to guess.
 *
 * Every one of these is a claim the model would otherwise have to derive from
 * a board it cannot read reliably, so each is asserted against a position
 * chosen for it — not against a fixture that happens to contain one.
 *
 * They are also asserted in the negative where that is the interesting half: a
 * detector that says "isolated pawn" about every pawn passes a positive test
 * and is worse than nothing, because the coach will repeat it.
 */

import { describe, expect, it } from "vitest";

import {
  kingSafety,
  materialBalance,
  pawnStructure,
  positionFacts,
  repeatedPieceMoves,
  undeveloped,
} from "../position.js";
import { START_FEN, positionsFromPgn } from "../../utils/chess.js";

/** The FEN after playing `pgn` out. */
const after = (pgn) => {
  const plies = positionsFromPgn(pgn);
  return plies.length ? plies[plies.length - 1].fen_after : START_FEN;
};

describe("material", () => {
  it("is level at the start and signed from the player's side", () => {
    expect(materialBalance(START_FEN, "w")).toBe(0);
    expect(materialBalance(START_FEN, "b")).toBe(0);
  });

  it("counts a won piece for the side that won it", () => {
    // 1. e4 d5 2. exd5: White is a pawn up.
    const fen = after("1. e4 d5 2. exd5 *");
    expect(materialBalance(fen, "w")).toBe(1);
    expect(materialBalance(fen, "b")).toBe(-1);
  });
});

describe("king safety", () => {
  it("calls the starting king central and uncastled", () => {
    const king = kingSafety(START_FEN, "w");
    expect(king.square).toBe("e1");
    expect(king.castled).toBe(false);
    expect(king.central).toBe(true);
    // Three pawns on d2/e2/f2 in front of it.
    expect(king.shield).toBe(3);
  });

  it("sees a short castle, and which side it was", () => {
    const king = kingSafety(after("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O *"), "w");
    expect(king.square).toBe("g1");
    expect(king.castled).toBe(true);
    expect(king.side).toBe("short");
    expect(king.central).toBe(false);
    expect(king.shield).toBe(3);
  });

  it("sees a long castle", () => {
    const king = kingSafety(after("1. d4 d5 2. Bf4 Bf5 3. Nc3 Nc6 4. Qd2 Qd7 5. O-O-O *"), "w");
    expect(king.square).toBe("c1");
    expect(king.side).toBe("long");
    expect(king.castled).toBe(true);
  });

  it("counts a missing shield pawn, which is the whole point of counting it", () => {
    // Castled short, then pushed the g-pawn: two pawns left in front.
    const king = kingSafety(after("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O d6 5. g3 *"), "w");
    expect(king.castled).toBe(true);
    expect(king.shield).toBe(2);
  });
});

describe("pawn structure", () => {
  it("finds nothing to report in the starting position", () => {
    const structure = pawnStructure(START_FEN, "w");
    expect(structure.count).toBe(8);
    expect(structure.doubled).toEqual([]);
    // Eight pawns side by side: not one of them is isolated, and a detector
    // that says otherwise would have the coach open every game with a warning.
    expect(structure.isolated).toEqual([]);
    expect(structure.passed).toEqual([]);
  });

  it("names the file a pawn was doubled on", () => {
    // 1. e4 d5 2. exd5 keeps White's d-pawn and adds one on d5.
    const structure = pawnStructure(after("1. e4 d5 2. exd5 *"), "w");
    expect(structure.doubled).toEqual(["d"]);
  });

  it("sees a passed pawn, and does not see one that is still blocked", () => {
    // A single white pawn on d5 with nothing on c/d/e ahead of it.
    const passed = pawnStructure("4k3/8/8/3P4/8/8/8/4K3 w - - 0 1", "w");
    expect(passed.passed).toEqual(["d5"]);

    // The same pawn with a black pawn on e6 covering its path.
    const held = pawnStructure("4k3/8/4p3/3P4/8/8/8/4K3 w - - 0 1", "w");
    expect(held.passed).toEqual([]);
  });

  it("sees an isolated pawn only when both neighbouring files are empty", () => {
    const alone = pawnStructure("4k3/8/8/8/8/8/P3P3/4K3 w - - 0 1", "w");
    expect(alone.isolated.sort()).toEqual(["a2", "e2"]);

    const supported = pawnStructure("4k3/8/8/8/8/8/PP6/4K3 w - - 0 1", "w");
    expect(supported.isolated).toEqual([]);
  });
});

describe("development", () => {
  it("lists the minor pieces still at home, and nothing else", () => {
    expect(undeveloped(START_FEN, "w").sort()).toEqual(["b1", "c1", "f1", "g1"]);
    // Rooks and the queen are not counted: they belong at home this early.
    expect(undeveloped(START_FEN, "w")).not.toContain("a1");
    expect(undeveloped(START_FEN, "w")).not.toContain("d1");
  });

  it("shrinks as pieces come out", () => {
    const fen = after("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *");
    expect(undeveloped(fen, "w").sort()).toEqual(["b1", "c1"]);
  });
});

describe("pieces moved twice in the opening", () => {
  const white = (pgn) =>
    positionsFromPgn(pgn).filter((move) => move.color === "white");

  it("says nothing when every piece moved once", () => {
    expect(repeatedPieceMoves(white("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 *"))).toEqual([]);
  });

  it("follows a piece that moved and moved back", () => {
    // Ng1-f3-g5-f3: one knight, three moves.
    const found = repeatedPieceMoves(white("1. e4 e5 2. Nf3 Nc6 3. Ng5 h6 4. Nf3 d6 *"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "n", square: "f3", times: 3 });
  });

  it("ignores pawns, which are a chain rather than a wasted tempo", () => {
    const found = repeatedPieceMoves(white("1. e4 d5 2. e5 c5 3. e6 fxe6 *"));
    expect(found).toEqual([]);
  });

  it("stops at the end of the opening", () => {
    // The bishop shuffles at moves 8-10, inside the opening. The knight that
    // goes b1-d2 (11), d2-f1 (14), f1-d2 (15) mostly moves past the cutoff.
    const pgn =
      "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. c3 Nf6 6. b4 Bb6 7. a4 a6 " +
      "8. Bg5 h6 9. Bh4 g5 10. Bg3 Nh5 11. Nbd2 Nxg3 12. hxg3 Qf6 13. Qb3 Qg6 " +
      "14. Nf1 Be6 15. N1d2 O-O-O *";
    const moves = white(pgn);

    const opening = repeatedPieceMoves(moves, 12);
    expect(opening.map((entry) => entry.type)).toEqual(["b"]);
    expect(opening[0].times).toBe(3);
    // The knight's two later moves are outside the window and are not counted.
    expect(opening.some((entry) => entry.type === "n")).toBe(false);

    // Cut the window shorter and even the bishop falls outside it.
    expect(repeatedPieceMoves(moves, 7)).toEqual([]);
  });
});

describe("the bundle handed to the digest", () => {
  it("speaks the app's colour names rather than chess.js's", () => {
    const facts = positionFacts(START_FEN, "white");
    expect(facts.material).toBe(0);
    expect(facts.king.square).toBe("e1");
    expect(positionFacts(START_FEN, "black").king.square).toBe("e8");
  });
});
