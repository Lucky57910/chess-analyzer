/**
 * Playing a position out against the engine.
 *
 * The engine is injected, so the whole rally runs here against a recorded one:
 * no phone, no Stockfish, and the awkward cases - a move that ends the game, a
 * side whose evaluation runs the other way, an illegal drag - are reachable on
 * demand rather than by luck.
 *
 * The judgment half matters most. It reuses the model the analysis uses, so
 * getting the sign wrong for Black would produce a screen full of plausible
 * verdicts that are all backwards, which is exactly the failure this app was
 * warned about from the start.
 */

import { Chess } from "chess.js";
import { describe, expect, it, vi } from "vitest";

import {
  applyMove,
  engineMove,
  judgeMove,
  legalDests,
  outcomeOf,
  respondTo,
  turnOf,
} from "../sparring.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** An engine that answers from a table, and complains about anything else. */
function recorded(table) {
  return vi.fn(async (fen) => {
    if (!(fen in table)) throw new Error(`no recorded evaluation for ${fen}`);
    return table[fen];
  });
}

describe("legalDests", () => {
  it("offers exactly the legal moves, and nothing else", () => {
    const dests = legalDests(START);
    expect(dests.get("e2")).toEqual(["e3", "e4"]);
    expect(dests.get("g1").sort()).toEqual(["f3", "h3"]);
    expect(dests.has("e1")).toBe(false);
  });

  // Built from chess.js rather than from the geometry, so a pinned piece is
  // simply not offered. Dragging it would otherwise be accepted by the board
  // and rejected afterwards.
  it("does not offer a pinned piece a move off its line", () => {
    // Knight c3 is pinned to the king on e1 by the bishop on a5.
    const dests = legalDests("4k3/8/8/b7/8/2N5/8/4K3 w - - 0 1");
    expect(dests.get("c3")).toBe(undefined);
  });

  it("offers only the moves out of check", () => {
    const dests = legalDests("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1");
    for (const [from] of dests) expect(from).toBe("e1");
  });
});

describe("turnOf", () => {
  it("says whose move it is, the way the board asks", () => {
    expect(turnOf(START)).toBe("white");
    expect(turnOf("4k3/8/8/8/8/8/8/4K3 b - - 0 1")).toBe("black");
  });
});

describe("judgeMove", () => {
  // Everything stored by this app is White's point of view. A drop of 200 is a
  // blunder for White and a gift for Black, and reading it the same way for
  // both sides is the mistake that renders perfectly plausible nonsense.
  it("reads the loss from the mover's side of the board", () => {
    const drop = { before: { cp: 0 }, after: { cp: -350 } };
    expect(judgeMove({ ...drop, color: "white" })).toMatchObject({
      cp_loss: 350,
      judgment: "blunder",
    });
    expect(judgeMove({ ...drop, color: "black" })).toMatchObject({
      cp_loss: 0,
      judgment: null,
    });
  });

  it("uses the same thresholds as the analysis", () => {
    const loss = (cp) => judgeMove({ before: { cp: 0 }, after: { cp: -cp }, color: "white" });
    expect(loss(49).judgment).toBe(null);
    expect(loss(50).judgment).toBe("inaccuracy");
    expect(loss(100).judgment).toBe("mistake");
    expect(loss(300).judgment).toBe("blunder");
  });

  // Playing the move the engine named cannot lose anything. Any difference
  // there is two searches disagreeing, not a mistake, and charging the player
  // for it would mark the best move on the board as an inaccuracy.
  it("charges nothing for playing the engine's own move", () => {
    const judged = judgeMove({
      before: { cp: 0 },
      after: { cp: -80 },
      color: "white",
      wasBest: true,
    });
    expect(judged).toMatchObject({ cp_loss: 0, judgment: null, is_best: true });
  });

  it("says nothing rather than zero when an evaluation is missing", () => {
    expect(judgeMove({ before: null, after: { cp: 0 }, color: "white" })).toBe(null);
    expect(judgeMove({ before: { cp: 0 }, after: {}, color: "white" })).toBe(null);
  });
});

describe("applyMove", () => {
  it("plays a legal move and hands back the new position", () => {
    const applied = applyMove(START, "e2", "e4");
    expect(applied.move.san).toBe("e4");
    expect(applied.fen).toContain(" b ");
  });

  // The board can be dragged faster than the engine answers, so an illegal
  // move is a thing that happens rather than a bug to crash on.
  it("returns nothing on an illegal move instead of throwing", () => {
    expect(applyMove(START, "e2", "e5")).toBe(null);
    expect(applyMove(START, "zz", "e4")).toBe(null);
  });

  it("promotes to a queen without asking", () => {
    const applied = applyMove("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7", "a8");
    expect(applied.move.promotion).toBe("q");
  });
});

describe("outcomeOf", () => {
  it("names the end of the game and who won", () => {
    expect(outcomeOf("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")).toMatchObject({ over: false });
    expect(outcomeOf("R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1")).toMatchObject({
      over: true,
      reason: "checkmate",
      winner: "white",
    });
  });

  it("tells a stalemate from a mate", () => {
    expect(outcomeOf("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).toMatchObject({
      over: true,
      reason: "stalemate",
    });
  });

  it("sees a draw by bare kings", () => {
    expect(outcomeOf("4k3/8/8/8/8/8/8/4K3 w - - 0 1")).toMatchObject({ reason: "material" });
  });
});

describe("respondTo", () => {
  const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const afterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

  it("judges the move played and answers it", async () => {
    const evaluate = recorded({
      [START]: { cp: 20, best_uci: "e2e4" },
      [afterE4]: { cp: 30, best_uci: "e7e5" },
    });

    const result = await respondTo({
      evaluate,
      before: START,
      after: afterE4,
      color: "white",
    });

    expect(result.verdict).toMatchObject({ is_best: true, cp_loss: 0 });
    expect(result.reply.san).toBe("e5");
    expect(result.reply.fen).toBe(afterE5);
    expect(result.outcome.over).toBe(false);
  });

  // Two calls per exchange, not three: the evaluation of the position the user
  // just created is both the verdict on their move and the reply to it. On a
  // phone that is the difference between a board that answers and one that
  // stalls.
  it("asks the engine twice per exchange", async () => {
    const evaluate = recorded({
      [START]: { cp: 20, best_uci: "e2e4" },
      [afterE4]: { cp: 30, best_uci: "e7e5" },
    });
    await respondTo({ evaluate, before: START, after: afterE4, color: "white" });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("asks it once when the evaluation before the move is already known", async () => {
    const evaluate = recorded({ [afterE4]: { cp: 30, best_uci: "e7e5" } });
    await respondTo({
      evaluate,
      before: START,
      after: afterE4,
      color: "white",
      bestBefore: { cp: 20, best_uci: "e2e4" },
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("judges a move that was not the engine's choice", async () => {
    const afterA3 = "rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1";
    const evaluate = recorded({
      [START]: { cp: 20, best_uci: "e2e4" },
      [afterA3]: { cp: -120, best_uci: "e7e5" },
    });

    const result = await respondTo({ evaluate, before: START, after: afterA3, color: "white" });
    expect(result.verdict).toMatchObject({ cp_loss: 140, judgment: "mistake", is_best: false });
  });

  // A mate ends the rally: there is no reply to make, and asking the engine
  // for one on a finished position is how a board locks up.
  it("stops rather than answering a position that is already over", async () => {
    const before = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
    const mated = "R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 1";
    const evaluate = recorded({
      [before]: { cp: 500, best_uci: "a1a8" },
      [mated]: { cp: 10000, best_uci: null },
    });

    const result = await respondTo({ evaluate, before, after: mated, color: "white" });
    expect(result.reply).toBe(null);
    expect(result.outcome).toMatchObject({ over: true, reason: "checkmate", winner: "white" });
  });

  // A mate leaves no legal reply, so it would come back empty whether the end
  // of the game was noticed or not. A draw by bare kings is the case that
  // tells them apart: the game is over and there are still five legal moves,
  // so an engine asked for one would happily play on past the end.
  it("stops on a drawn position that still has moves in it", async () => {
    const before = "4k3/8/8/8/8/8/8/3rK3 w - - 0 1";
    const bare = "4k3/8/8/8/8/8/8/3K4 b - - 0 1";
    expect(new Chess(bare).moves().length).toBe(5);

    const evaluate = recorded({
      [before]: { cp: 0, best_uci: "e1d1" },
      [bare]: { cp: 0, best_uci: "e8d8" },
    });

    const result = await respondTo({ evaluate, before, after: bare, color: "white" });
    expect(result.outcome).toMatchObject({ over: true, reason: "material" });
    expect(result.reply).toBe(null);
  });

  it("plays on as Black, with the sign the other way round", async () => {
    const afterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const afterNf3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
    const evaluate = recorded({
      [afterE4]: { cp: 30, best_uci: "b8c6" },
      [afterE5]: { cp: 130, best_uci: "g1f3" },
      [afterNf3]: { cp: 130, best_uci: "b8c6" },
    });

    const result = await respondTo({
      evaluate,
      before: afterE4,
      after: afterE5,
      color: "black",
    });

    // White's advantage grew by 100, which is Black's loss, not Black's gain.
    expect(result.verdict).toMatchObject({ cp_loss: 100, judgment: "mistake" });
    expect(result.reply.san).toBe("Nf3");
  });

  it("survives an engine that names no move", async () => {
    const evaluate = recorded({
      [START]: { cp: 20, best_uci: null },
      [afterE4]: { cp: 30, best_uci: null },
    });
    const result = await respondTo({ evaluate, before: START, after: afterE4, color: "white" });
    expect(result.reply).toBe(null);
    expect(result.verdict).not.toBe(null);
  });
});

describe("engineMove", () => {
  const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const afterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

  // The case the screen actually starts from: "Jouer d'ici" is pressed while
  // looking at a move that has just been played, so the position handed over
  // belongs to the other side. Nothing else in this module asks the engine
  // without a move of the user's to judge first.
  it("plays the position handed to it", async () => {
    const evaluate = recorded({ [afterE4]: { cp: 30, best_uci: "e7e5" } });
    const result = await engineMove({ evaluate, fen: afterE4 });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.reply.san).toBe("e5");
    expect(result.reply.fen).toBe(afterE5);
    expect(result.outcome.over).toBe(false);
  });

  it("does not ask the engine about a finished game", async () => {
    const evaluate = recorded({});
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const result = await engineMove({ evaluate, fen: mated });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ over: true, reason: "checkmate" });
    expect(result.reply).toBe(null);
  });

  it("survives an engine that names no move", async () => {
    const evaluate = recorded({ [afterE4]: { cp: 30, best_uci: null } });
    const result = await engineMove({ evaluate, fen: afterE4 });

    expect(result.reply).toBe(null);
    expect(result.outcome.over).toBe(false);
  });

  it("reports the mate it walks into", async () => {
    // Black to move, mate in one on h4.
    const before = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
    const evaluate = recorded({ [before]: { cp: -9998, mate: -1, best_uci: "d8h4" } });
    const result = await engineMove({ evaluate, fen: before });

    expect(result.reply.san).toBe("Qh4#");
    expect(result.outcome).toMatchObject({ over: true, reason: "checkmate", winner: "black" });
  });
});

describe("a whole rally", () => {
  // The point of injecting the engine: a few exchanges end to end, with the
  // positions actually reached rather than asserted about in isolation.
  it("plays several exchanges without losing the thread", async () => {
    const evaluate = vi.fn(async (fen) => {
      const position = new Chess(fen);
      const moves = position.moves({ verbose: true });
      return { cp: 0, best_uci: moves.length ? moves[0].lan : null };
    });

    let fen = START;
    for (let i = 0; i < 4; i += 1) {
      const mine = legalDests(fen).entries().next().value;
      const applied = applyMove(fen, mine[0], mine[1][0]);
      const result = await respondTo({
        evaluate,
        before: fen,
        after: applied.fen,
        color: turnOf(fen),
      });
      expect(result.verdict).not.toBe(null);
      fen = result.reply ? result.reply.fen : applied.fen;
      if (result.outcome.over) break;
    }
    expect(new Chess(fen).history().length).toBe(0); // a fresh position, not a replay
    expect(fen).not.toBe(START);
  });
});
