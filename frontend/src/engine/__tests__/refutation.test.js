/**
 * Reading an engine line back as a sentence.
 *
 * Two things can go wrong here and neither one throws. A line that will not
 * replay - truncated, or stored by an older version against a position that
 * has moved on - must stop quietly rather than take the screen down. And the
 * side a motif belongs to flips halfway through: a refutation is read from the
 * position the user created, so every ply of it is the opponent's, and
 * reporting their fork as the reader's own would be a confident lie.
 */

import { describe, expect, it } from "vitest";

import {
  bestLine,
  keyMoment,
  lineText,
  moverOf,
  refutation,
  replayLine,
} from "../refutation.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("replayLine", () => {
  it("plays the line out and names each move", () => {
    const steps = replayLine(START, ["e2e4", "e7e5", "g1f3"]);
    expect(steps.map((s) => s.san)).toEqual(["e4", "e5", "Nf3"]);
    expect(steps.map((s) => s.color)).toEqual(["white", "black", "white"]);
  });

  // An engine line is a claim about a search, not a promise about this
  // position, and a stored one outlives the analysis it came from.
  it("stops at the first move that will not play", () => {
    const steps = replayLine(START, ["e2e4", "e7e5", "e2e4"]);
    expect(steps.map((s) => s.san)).toEqual(["e4", "e5"]);
  });

  it("has nothing to say without a line", () => {
    expect(replayLine(START, [])).toEqual([]);
    expect(replayLine(START, null)).toEqual([]);
    expect(replayLine(null, ["e2e4"])).toEqual([]);
    expect(replayLine(START, ["nonsense", "e2e4"])).toEqual([]);
  });

  it("carries the motifs of each move in the line", () => {
    // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#
    const steps = replayLine(START, ["e2e4", "e7e5", "f1c4", "b8c6"]);
    expect(steps).toHaveLength(4);
    expect(Array.isArray(steps[0].motifs)).toBe(true);
  });
});

describe("keyMoment", () => {
  // A line does something on nearly every ply. Saying all of it is noise, so
  // the one that explains the most is the one the line is described by.
  it("picks the mate over anything else in the line", () => {
    const steps = replayLine("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1", ["a1a8"]);
    expect(keyMoment(steps).motif.key).toBe("checkmate");
  });

  it("picks the fork out of a quiet line", () => {
    // The rook has come to a1; the knight jumps in and hits it and the king
    // at once. On a8 the rook would be giving check and the knight could not
    // legally move at all - which is how this position was got wrong first.
    const steps = replayLine("7k/8/8/8/1n6/8/8/R3K3 b - - 1 1", ["b4c2"]);
    const moment = keyMoment(steps);
    expect(moment.motif.key).toBe("fork");
    expect(moment.step.san).toBe("Nc2+");
  });

  // Two telling motifs in one line, so the order actually decides something.
  // With a single one present, any order at all would pass.
  it("prefers the motif that explains the most", () => {
    const steps = [
      { san: "Qxb7", motifs: [{ key: "hangs", side: "you", victim: "q" }] },
      { san: "Ra8#", motifs: [{ key: "checkmate", side: "you" }] },
    ];
    const moment = keyMoment(steps);
    expect(moment.motif.key).toBe("checkmate");
    expect(moment.step.san).toBe("Ra8#");
  });

  it("says nothing about a line where nothing happens", () => {
    expect(keyMoment(replayLine(START, ["e2e3", "e7e6"]))).toBe(null);
    expect(keyMoment([])).toBe(null);
  });
});

describe("refutation", () => {
  // Read from the position the played move created, so the first ply is the
  // opponent's answer and every motif in it is theirs.
  it("reads the opponent's punishment off the stored line", () => {
    const afterBlunder = "7k/8/8/8/1n6/8/8/R3K3 b - - 1 1";
    const found = refutation({ reply_line: ["b4c2"] }, afterBlunder);

    expect(found.steps[0].san).toBe("Nc2+");
    expect(found.moment.motif.key).toBe("fork");
    // The mover at that ply is Black - the opponent - which is what makes the
    // motif theirs rather than the reader's.
    expect(found.steps[0].color).toBe("black");
    expect(moverOf(afterBlunder)).toBe("black");
  });

  // Every analysis stored before the driver kept variations has none of this.
  // Inventing one would be worse than saying nothing.
  it("returns nothing for a move analysed before lines were stored", () => {
    expect(refutation({ judgment: "blunder" }, START)).toBe(null);
    expect(refutation({ reply_line: [] }, START)).toBe(null);
    expect(refutation(null, START)).toBe(null);
  });
});

describe("bestLine", () => {
  it("reads what the engine wanted from the position before the move", () => {
    const before = "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1";
    const found = bestLine({ best_line: ["a1a8"] }, before);
    expect(found.steps[0].san).toBe("Ra8#");
    expect(found.steps[0].color).toBe("white");
    expect(found.moment.motif.key).toBe("checkmate");
  });

  it("returns nothing when there is no line to read", () => {
    expect(bestLine({ best_line: [] }, START)).toBe(null);
    expect(bestLine({}, START)).toBe(null);
  });
});

describe("lineText", () => {
  it("reads the line back as moves", () => {
    const steps = replayLine(START, ["e2e4", "e7e5", "g1f3"]);
    expect(lineText(steps)).toBe("e4 e5 Nf3");
    expect(lineText(steps, 2)).toBe("e4 e5");
    expect(lineText([])).toBe("");
  });
});
