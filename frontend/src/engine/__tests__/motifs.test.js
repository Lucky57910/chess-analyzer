/**
 * Motif detection, on positions set up by hand.
 *
 * A wrong annotation is worse than no annotation: it teaches something false
 * and the reader has no way to tell. So every detector below is checked twice
 * - once on a position where the motif is really there, and once on a position
 * that looks like it but is not. A detector that only ever sees its own happy
 * case is a detector that says yes to everything, and it would read exactly
 * the same on screen.
 *
 * The FENs are written out rather than reached by playing moves, so a case
 * says what it is testing without needing the reader to replay a game.
 */

import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";

import {
  availableForks,
  bestCapture,
  flipTurn,
  forkedBy,
  isOpenFile,
  isPassedPawn,
  mateInOne,
  motifsFor,
  pinsBy,
  rooksConnected,
} from "../motifs.js";

/** Play one move on a FEN and hand back what `motifsFor` needs. */
function play(fen, san) {
  const position = new Chess(fen);
  const move = position.move(san);
  return { before: fen, after: position.fen(), move };
}

const keys = (motifs) => motifs.map((m) => m.key);

describe("flipTurn", () => {
  it("hands the move over and drops the en-passant square with it", () => {
    // The en-passant square belongs to the side that was about to move; left
    // behind, it offers the other side a capture that is not legally there.
    const fen = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3";
    expect(flipTurn(fen, "b").split(" ").slice(1, 4).join(" ")).toBe("b KQkq -");
  });
});

describe("bestCapture", () => {
  it("finds a piece that can simply be taken", () => {
    // Black knight on d4, attacked by the queen on d1 and defended by nothing.
    const best = bestCapture("4k3/8/8/8/3n4/8/8/3QK3 b - - 0 1", "w");
    expect(best.victim).toBe("n");
    expect(best.gain).toBe(3);
    expect(best.clean).toBe(true);
  });

  it("says nothing about a defended piece of equal value", () => {
    // Knight b3 really can take on d4 - the point of the case is the trade, so
    // a position where the capture is not even reachable would pass whatever
    // the threshold said.
    // The defending pawn stands on e5, out of the knight's reach: on c5 it was
    // itself capturable, and the free pawn was what the function reported.
    const fen = "4k3/8/8/4p3/3n4/1N6/8/4K3 b - - 0 1";
    expect(new Chess(flipTurn(fen, "w")).moves({ verbose: true }).some((m) => m.to === "d4")).toBe(
      true,
    );
    // Three for three, with the e5 pawn recapturing: nothing won, nothing said.
    expect(bestCapture(fen, "w")).toBe(null);
  });

  it("still reports taking a defended piece worth more than the taker", () => {
    // Rook takes queen; the pawn recaptures. Nine for five is worth saying.
    const best = bestCapture("4k3/8/8/2p5/3q4/8/8/3RK3 b - - 0 1", "w");
    expect(best.victim).toBe("q");
    expect(best.gain).toBe(9 - 5);
    expect(best.clean).toBe(false);
  });

  it("has nothing to say when there is nothing to take", () => {
    expect(bestCapture("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "w")).toBe(null);
  });
});

describe("forkedBy", () => {
  it("finds a knight hitting two undefended pieces", () => {
    // Nc7+ from a knight on c7 hits the king on a8 and the rook on e8.
    const targets = forkedBy("r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1", "c7", "w");
    expect(targets.map((t) => t.type).sort()).toEqual(["k", "r"]);
  });

  // A fork answered by simply taking the forker is not a fork.
  it("says nothing when the forking piece can be captured", () => {
    // Same geometry, but a black bishop on d8 covers c7.
    expect(forkedBy("r2bk3/2N5/8/8/8/8/8/4K3 b - - 0 1", "c7", "w")).toEqual([]);
  });

  it("does not count a defended piece of equal value as a target", () => {
    // The knight hits two defended knights: taking either is a trade.
    const fen = "4k3/8/1n1n4/8/2N5/8/1r3r2/4K3 b - - 0 1";
    expect(forkedBy(fen, "c4", "w")).toEqual([]);
  });

  it("needs two targets, not one", () => {
    expect(forkedBy("4k3/8/8/8/8/8/8/r1N1K3 b - - 0 1", "c1", "w").length).toBe(0);
  });
});

describe("availableForks", () => {
  it("finds a fork that is one move away", () => {
    // The knight on e5 can reach c6, hitting the king on b8 and rook on a7.
    const forks = availableForks("1k6/r7/8/4N3/8/8/8/4K3 w - - 0 1", "w");
    expect(forks.some((f) => f.san.includes("c6"))).toBe(true);
  });

  it("finds none in a position with nothing to fork", () => {
    expect(availableForks("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "w")).toEqual([]);
  });
});

describe("pinsBy", () => {
  it("finds a knight pinned against its king", () => {
    // Bishop b5, knight c6, king d7: the knight cannot move.
    const pins = pinsBy("8/3k4/2n5/1B6/8/8/8/4K3 b - - 0 1", "w");
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ pinned: "c6", pinnedType: "n", againstType: "k" });
  });

  it("finds a relative pin against a queen", () => {
    // Rook d1, knight d5, queen d8: the knight shields nine points.
    const pins = pinsBy("3q4/8/8/3n4/8/8/8/3RK2k b - - 0 1", "w");
    expect(pins[0]).toMatchObject({ pinned: "d5", againstType: "q" });
  });

  // The order along the ray is the whole of it: the same three pieces the
  // other way round are a defended piece, not a pin.
  it("is not fooled by the more valuable piece standing in front", () => {
    const pins = pinsBy("3n4/8/8/3q4/8/8/8/3RK2k b - - 0 1", "w");
    expect(pins).toEqual([]);
  });

  it("stops at a piece of its own colour", () => {
    // A white pawn on d3 blocks the rook's view of everything beyond it.
    expect(pinsBy("3q4/8/8/3n4/8/3P4/8/3RK2k b - - 0 1", "w")).toEqual([]);
  });
});

describe("rooksConnected", () => {
  it("sees two rooks on an empty back rank", () => {
    expect(rooksConnected("4k3/8/8/8/8/8/8/R2R3K w - - 0 1", "w")).toBe(true);
  });

  it("does not, with something in between", () => {
    expect(rooksConnected("4k3/8/8/8/8/8/8/R1BR3K w - - 0 1", "w")).toBe(false);
  });

  // The same question down a file rather than along a rank. Two rooks are as
  // often stacked on one file as they are side by side on the back rank, and
  // the two cases are separate code.
  it("sees two rooks on an empty file, and not through a pawn", () => {
    expect(rooksConnected("R3k3/8/8/8/8/8/8/R3K3 w - - 0 1", "w")).toBe(true);
    expect(rooksConnected("R3k3/8/8/8/P7/8/8/R3K3 w - - 0 1", "w")).toBe(false);
  });

  it("does not, when they are on different lines", () => {
    expect(rooksConnected("4k3/8/8/8/8/8/R7/3R3K w - - 0 1", "w")).toBe(false);
  });

  it("needs two of them", () => {
    expect(rooksConnected("4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "w")).toBe(false);
  });
});

describe("isOpenFile and isPassedPawn", () => {
  it("calls a file open only when no pawn of either colour stands on it", () => {
    expect(isOpenFile("4k3/8/8/8/8/8/8/3RK3 w - - 0 1", "d")).toBe(true);
    expect(isOpenFile("4k3/3p4/8/8/8/8/8/3RK3 w - - 0 1", "d")).toBe(false);
    expect(isOpenFile("4k3/8/8/8/8/8/3P4/3RK3 w - - 0 1", "d")).toBe(false);
  });

  it("calls a pawn passed only when nothing on three files can stop it", () => {
    expect(isPassedPawn("4k3/8/8/3P4/8/8/8/4K3 w - - 0 1", "d5", "w")).toBe(true);
    // An enemy pawn straight ahead.
    expect(isPassedPawn("4k3/3p4/8/3P4/8/8/8/4K3 w - - 0 1", "d5", "w")).toBe(false);
    // And one on the neighbouring file, which is the case worth catching.
    expect(isPassedPawn("4k3/2p5/8/3P4/8/8/8/4K3 w - - 0 1", "d5", "w")).toBe(false);
    // One already behind it cannot stop it.
    expect(isPassedPawn("4k3/8/8/3P4/2p5/8/8/4K3 w - - 0 1", "d5", "w")).toBe(true);
  });
});

describe("mateInOne", () => {
  it("finds the mate", () => {
    expect(mateInOne("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1")).toBe("Ra8#");
  });

  it("does not call a check a mate", () => {
    expect(mateInOne("6k1/5pp1/7p/8/8/8/8/R3K3 w - - 0 1")).toBe(null);
  });
});

describe("motifsFor", () => {
  it("names castling and connecting the rooks", () => {
    const fen = "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1";
    const motifs = motifsFor(play(fen, "O-O"));
    expect(keys(motifs)).toContain("castled");
    expect(keys(motifs)).toContain("rooksConnected");
  });

  // The rooks were already connected before this move, on the other side of
  // the board. Crediting it to a bishop move would be nonsense the reader has
  // no way to check.
  it("does not credit a move for rooks that were already connected", () => {
    const fen = "4k3/8/8/8/4b3/8/8/R2RK3 w - - 0 1";
    expect(keys(motifsFor(play(fen, "Kf2")))).not.toContain("rooksConnected");
  });

  it("names the fork the move just created", () => {
    const motifs = motifsFor(play("1k6/r7/8/4N3/8/8/8/4K3 w - - 0 1", "Nc6+"));
    const fork = motifs.find((m) => m.key === "fork");
    expect(fork.targets.map((t) => t.type).sort()).toEqual(["k", "r"]);
  });

  it("says when the move puts a piece where it can simply be taken", () => {
    // The queen steps onto d5, attacked by the rook on d8 and defended by
    // nothing at all.
    const motifs = motifsFor(play("3rk3/8/8/8/8/8/8/3QK3 w - - 0 1", "Qd5"));
    const hangs = motifs.find((m) => m.key === "hangs");
    expect(hangs).toMatchObject({ victim: "q", moved: true, clean: true });
  });

  // A piece left hanging by an earlier move is not this move's fault, and
  // blaming every move after it would bury the one that actually did it.
  // The knight on a4 is hanging to the rook before the move and after it; the
  // king walking to e2 changes nothing about that.
  it("does not blame a move for a piece that was already hanging", () => {
    const fen = "r3k3/8/8/8/N7/8/8/4K3 w - - 0 1";
    expect(bestCapture(fen, "b").gain).toBe(3);
    expect(keys(motifsFor(play(fen, "Ke2")))).not.toContain("hangs");
  });

  // But a move that adds a second loose piece on top of the first is this
  // move's doing, and the comparison has to notice the difference rather than
  // only the presence.
  it("does blame a move that leaves more hanging than before", () => {
    const fen = "r3k2b/8/8/8/N7/8/8/3QK3 w - - 0 1";
    const motifs = motifsFor(play(fen, "Qd4"));
    const hangs = motifs.find((m) => m.key === "hangs");
    expect(hangs).toMatchObject({ victim: "q", gain: 9 });
  });

  // Before the rook comes to a1 the knight on b4 can only check from c2.
  // After it, the same square hits the king and the rook at once.
  it("says when the move hands the opponent a fork", () => {
    const fen = "R6k/8/8/8/1n6/8/8/4K3 w - - 0 1";
    expect(availableForks(fen, "b")).toEqual([]);

    const motifs = motifsFor(play(fen, "Ra1"));
    const allowed = motifs.find((m) => m.key === "allowsFork");
    expect(allowed.san).toBe("Nc2+");
    expect(allowed.targets.map((t) => t.type).sort()).toEqual(["k", "r"]);
  });

  it("says when a mate in one was there and was not played", () => {
    const motifs = motifsFor(play("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1", "Ra7"));
    expect(motifs.find((m) => m.key === "missedMate")).toMatchObject({ san: "Ra8#" });
  });

  it("does not complain about a missed mate on the move that mates", () => {
    const motifs = motifsFor(play("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1", "Ra8#"));
    expect(keys(motifs)).toContain("checkmate");
    expect(keys(motifs)).not.toContain("missedMate");
  });

  it("has nothing to say about a quiet move, rather than inventing something", () => {
    const motifs = motifsFor(play("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "Kd2"));
    expect(motifs).toEqual([]);
  });

  it("survives being handed nothing", () => {
    expect(motifsFor({})).toEqual([]);
    expect(motifsFor({ before: "x", after: null, move: null })).toEqual([]);
  });
});
