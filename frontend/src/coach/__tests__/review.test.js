/**
 * The archive review, held to the same rule as the per-move commentary: the
 * model may only repeat numbers somebody else computed.
 *
 * These tests are about what is *withheld*. A review is the place where a
 * language model is most tempted to turn eleven games into a character trait,
 * and where a reader is least able to check it - so the interesting assertions
 * here are the facts that never leave the phone and the findings that are
 * thrown away on arrival.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_DETAIL_CHARS,
  MAX_FINDINGS,
  MIN_GAMES,
  MIN_HALF_GAMES,
  archiveFacts,
  buildReview,
  evolutionFacts,
  reviewReadiness,
  splitByRecency,
  tacticalThemes,
  trendText,
  validateReview,
} from "../review.js";

const STATS = {
  games: 60,
  analysed: 58,
  wins: 30,
  draws: 4,
  losses: 26,
  win_rate: 53.3,
  avg_accuracy: 74.2,
  avg_acpl: 38,
  blunders_per_game: 1.2,
  mistakes_per_game: 2.1,
  inaccuracies_per_game: 3.4,
  phase_acpl: { opening: 22, middlegame: 51, endgame: 33 },
  by_color: [{ name: "white", games: 30, win_rate: 60, avg_accuracy: 75 }],
  by_time_class: [{ name: "blitz", games: 58, win_rate: 53.3, avg_accuracy: 74.2 }],
};

const INSIGHTS = {
  by_piece: [
    { piece: "Q", name: "Dame", moves: 812, avg_cp_loss: 61, blunders: 24 },
    // Below the floor: four king moves say nothing about a king.
    { piece: "K", name: "Roi", moves: 4, avg_cp_loss: 190, blunders: 2 },
  ],
  opening_exit: [
    { name: "French Defense", games: 12, moves: 140, acpl: 48, win_rate: 33 },
    // Two games is not a repertoire problem, it is two games.
    { name: "Bird's Opening", games: 2, moves: 24, acpl: 210, win_rate: 0 },
  ],
  by_rating_gap: [{ key: "much_stronger", name: "Bien plus fort", games: 9, win_rate: 22 }],
  conversion: {
    winning_positions: 20,
    converted: 12,
    conversion_rate: 60,
    losing_positions: 3,
    saved: 1,
    save_rate: 33,
  },
  session_tilt: [{ rank: 4, name: "4ᵉ et au-delà", games: 11, win_rate: 30, blunders_per_game: 2.1 }],
  clock: {
    median_seconds: 4.2,
    buckets: [
      { key: "instant", name: "moins de 5 s", moves: 900, blunders: 40, avg_cp_loss: 55 },
      { key: "slow", name: "plus de 30 s", moves: 10, blunders: 0, avg_cp_loss: 12 },
    ],
  },
  opponent_strength: { win_loss_gap: 45 },
};

const keysOf = (facts) => facts.map((f) => f.key);

describe("what the archive is allowed to say", () => {
  it("withholds every number whose denominator cannot carry it", () => {
    const keys = keysOf(archiveFacts({ stats: STATS, insights: INSIGHTS, themes: null }));

    expect(keys).toContain("piece.Q");
    expect(keys).toContain("ouverture.1");
    // Four king moves, two games of an opening, ten slow moves: all sent to
    // nobody. A fact that never arrives cannot be over-read.
    expect(keys).not.toContain("piece.K");
    expect(keys).not.toContain("ouverture.2");
    expect(keys).not.toContain("horloge.slow");
    expect(keys).toContain("horloge.instant");
  });

  it("says nothing at all below a sample worth asking about", () => {
    expect(reviewReadiness({ analysed: MIN_GAMES - 1 }).ready).toBe(false);
    expect(reviewReadiness({ analysed: MIN_GAMES }).ready).toBe(true);
  });

  it("carries the keys the answer will be checked against", () => {
    const digest = buildReview({ stats: STATS, insights: INSIGHTS, themes: null, kind: "rated" });
    expect(digest.keys).toEqual(keysOf(digest.facts));
    expect(digest.text).toMatch(/piece\.Q \| coups de dame/);
    // The player's games are never in it - only numbers computed from them.
    expect(digest.text).not.toMatch(/1\. e4/);
  });
});

/**
 * A player whose opening used to leak and does not any more.
 *
 * Built as accuracy alone, which is enough: `computeStats` reads the analysis
 * summary off each game, and what these tests are about is whether the two
 * halves are compared at all.
 */
function played(n, { from, accuracy, acpl, opening = "French Defense", losses = [] }) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${from + i}`,
    user_color: "white",
    result: "win",
    opening,
    end_time: from + i * 86_400,
    played_at: new Date((from + i * 86_400) * 1000).toISOString(),
    analysis: {
      accuracy_white: accuracy,
      accuracy_black: 70,
      acpl_white: acpl,
      acpl_black: 60,
      judgment_counts: { white: {}, black: {} },
      moves: losses.map((cp_loss, ply) => ({
        ply: ply + 1,
        move_number: ply + 1,
        color: "white",
        san: "e4",
        cp_loss,
        judgment: null,
        phase: "opening",
      })),
    },
  }));
}

describe("telling a weakness from one that has been fixed", () => {
  const OLD = played(10, { from: 1_600_000_000, accuracy: 62, acpl: 70, losses: [90, 80, 70] });
  const NEW = played(10, { from: 1_700_000_000, accuracy: 82, acpl: 25, losses: [12, 10, 14] });

  it("says which way a number moved rather than leaving the model to guess", () => {
    // Lower is better for centipawns and worse for accuracy. A model reading
    // "70 puis 25" unaided congratulates you on a collapse half the time.
    expect(trendText("cp", 70, 25)).toMatch(/en progrès/);
    expect(trendText("cp", 25, 70)).toMatch(/en recul/);
    expect(trendText("précision", 70, 80, { higherIsBetter: true })).toMatch(/en progrès/);
    // Within a tenth: two samples of the same thing, not a trend.
    expect(trendText("cp", 100, 95)).toMatch(/stable/);
  });

  it("compares the two halves of the archive", () => {
    const facts = evolutionFacts(splitByRecency([...OLD, ...NEW]));
    const text = facts.map((f) => f.text).join(" | ");

    expect(keysOf(facts)).toContain("evolution.precision");
    expect(text).toMatch(/précision moyenne : 62 % sur la première moitié, 82 % sur la seconde \(en progrès\)/);
    // The opening that was leaking and is not any more, with both counts, so
    // "corrigé" can be said instead of held against the player for ever.
    expect(text).toMatch(/French Defense.*en progrès.*10 parties puis 10/);
  });

  it("says nothing about a trend it cannot support", () => {
    // One half too small to be a half. Two averages over four games each is
    // not a before and an after.
    expect(splitByRecency(played(2 * MIN_HALF_GAMES - 1, { from: 1, accuracy: 70, acpl: 40 }))).toBe(
      null,
    );
    expect(evolutionFacts(null)).toEqual([]);
  });

  it("puts them in the digest, where the flat averages cannot say it", () => {
    const digest = buildReview({
      games: [...OLD, ...NEW],
      stats: STATS,
      insights: INSIGHTS,
      themes: null,
    });
    expect(digest.keys).toContain("evolution.acpl");
    // And the whole-window facts are still there: "ton milieu de partie reste
    // le point faible, ton ouverture s’est corrigée" needs both.
    expect(digest.keys).toContain("phase.middlegame");
  });
});

describe("keeping only the findings that cite something", () => {
  const keys = ["piece.Q", "phase.middlegame"];

  it("drops a finding whose evidence was never sent", () => {
    const findings = validateReview(
      {
        findings: [
          { title: "Dame trop tôt", detail: "61 cp par coup.", evidence: ["piece.Q"] },
          // The failure this whole module exists to catch: a plausible
          // sentence about a number nobody computed.
          { title: "Tes finales de tours", detail: "Tu les perds.", evidence: ["finale.tours"] },
        ],
      },
      keys,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Dame trop tôt");
  });

  it("strips the invented half of a mixed citation rather than the finding", () => {
    const [finding] = validateReview(
      {
        findings: [
          {
            title: "Milieu de partie",
            detail: "51 cp par coup.",
            evidence: ["phase.middlegame", "phase.inventée"],
          },
        ],
      },
      keys,
    );
    expect(finding.evidence).toEqual(["phase.middlegame"]);
  });

  it("drops what is too long rather than cutting it mid-sentence", () => {
    const findings = validateReview(
      {
        findings: [
          { title: "Trop long", detail: "x".repeat(MAX_DETAIL_CHARS + 1), evidence: keys },
        ],
      },
      keys,
    );
    expect(findings).toHaveLength(0);
  });

  it("stops at the cap", () => {
    const one = { title: "t", detail: "d", evidence: ["piece.Q"] };
    const findings = validateReview({ findings: Array(MAX_FINDINGS + 3).fill(one) }, keys);
    expect(findings).toHaveLength(MAX_FINDINGS);
  });
});

describe("counting what actually punishes this player", () => {
  /*
   * A game where the fianchettoed bishop on b7 takes the e4 pawn from three
   * squares away, because the knight defending it moved off. That is the whole
   * point of this pass: "le fou frappe de loin" is a fact somebody counted,
   * not a sentence a model liked the sound of.
   */
  const GAME = {
    id: 1,
    user_color: "white",
    end_time: 1_700_000_000,
    pgn: "1. e4 b6 2. Nf3 Bb7 3. Nc3 e6 4. Ne2 *",
    analysis: {
      moves: [{ ply: 7, move_number: 4, color: "white", judgment: "blunder", cp_loss: 120 }],
    },
  };

  it("names the piece that takes, and how far it came", () => {
    const themes = tacticalThemes([GAME]);
    expect(themes.judged).toBe(1);
    expect(themes.allowed.hangs).toBe(1);

    const bishop = themes.by_attacker.find((entry) => entry.piece === "b");
    expect(bishop.count).toBe(1);
    expect(bishop.far).toBe(1);
    expect(themes.far).toBe(1);
  });

  it("turns that into a fact with a key of its own", () => {
    const themes = tacticalThemes([GAME]);
    // One judged move is below the floor, so the themes are withheld entirely -
    // which is the behaviour, not an accident of the fixture.
    expect(keysOf(archiveFacts({ stats: STATS, insights: INSIGHTS, themes }))).not.toContain(
      "motif.attaquant.b",
    );

    const keys = keysOf(
      archiveFacts({
        stats: STATS,
        insights: INSIGHTS,
        themes: { ...themes, judged: 60, by_attacker: [{ piece: "b", count: 19, far: 14 }] },
      }),
    );
    expect(keys).toContain("motif.attaquant.b");
  });

  it("ignores the opponent's mistakes and the moves nobody judged", () => {
    const themes = tacticalThemes([{ ...GAME, user_color: "black" }]);
    expect(themes.judged).toBe(0);
    expect(themes.allowed.hangs).toBe(0);
  });
});
