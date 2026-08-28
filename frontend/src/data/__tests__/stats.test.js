/**
 * Dashboard aggregates against the frozen Python output.
 *
 * These numbers are the entire point of the app, and every one of them is a
 * ratio that stays plausible when it is wrong. A win rate that counts draws as
 * losses, an accuracy read from White's side regardless of who the user was,
 * a phase ranked by the wrong comparison - all render fine.
 */

import { describe, expect, it } from "vitest";

import golden from "../__fixtures__/golden-data.json";
import {
  computeJudgmentTrends,
  computeMistakes,
  computeSmoothedTrends,
  computeStats,
  computeTrends,
  formatBucket,
  isoWeek,
  myMoveCount,
  rate,
  smoothingWeights,
} from "../stats.js";

describe("stats against the Python", () => {
  for (const testCase of golden.stats) {
    describe(testCase.name, () => {
      const games = testCase.games;

      it("summary", () => {
        expect(computeStats(games)).toEqual(testCase.stats);
      });

      for (const period of ["day", "week", "month"]) {
        it(`trends by ${period}`, () => {
          expect(computeTrends(games, { period, limit: 12 })).toEqual(testCase.trends[period]);
        });
      }

      it("mistake patterns", () => {
        const actual = computeMistakes(games);
        expect(actual.by_move_number).toEqual(testCase.mistakes.by_move_number);
        expect(actual.worst_moves.length).toBe(testCase.mistakes.worst_moves.length);
        actual.worst_moves.forEach((move, i) => {
          const expected = testCase.mistakes.worst_moves[i];
          const { played_at: actualDate, ...actualRest } = move;
          const { played_at: expectedDate, ...expectedRest } = expected;
          expect(actualRest, `worst move ${i}`).toEqual(expectedRest);
          expect(Date.parse(actualDate)).toBe(Date.parse(expectedDate));
        });
      });
    });
  }
});

describe("win rate", () => {
  it("counts a draw as half a win", () => {
    expect(rate(1, 0, 2)).toBe(50.0);
    expect(rate(0, 2, 2)).toBe(50.0);
    expect(rate(1, 1, 2)).toBe(75.0);
    expect(rate(0, 0, 0)).toBe(0.0);
  });

  // 100 * 1.5 / 4 is exactly 37.5, and 100 * 0.5 / 8 is exactly 6.25 - the
  // rounding ties that Math.round would take the other way.
  it("rounds ties the way Python does", () => {
    expect(rate(1, 1, 4)).toBe(37.5);
    expect(rate(0, 1, 8)).toBe(6.2);
  });
});

describe("isoWeek", () => {
  // A week belongs to the year containing its Thursday, so these dates are in
  // a different ISO year than their calendar year.
  const cases = [
    { date: "2026-01-01T12:00:00Z", year: 2026, week: 1 },
    { date: "2021-01-01T12:00:00Z", year: 2020, week: 53 },
    { date: "2023-01-01T12:00:00Z", year: 2022, week: 52 },
    { date: "2024-12-30T12:00:00Z", year: 2025, week: 1 },
    { date: "2026-08-26T12:00:00Z", year: 2026, week: 35 },
  ];
  for (const { date, year, week } of cases) {
    it(date, () => {
      expect(isoWeek(new Date(date))).toEqual({ year, week });
    });
  }
});

describe("formatBucket", () => {
  // The axis was showing raw keys, which is unreadable at a daily granularity.
  // These assert the short form, and that the parse is anchored on the shape
  // `bucketOf` actually emits rather than on string position.
  const cases = [
    { key: "2026-08-14", period: "day", label: "14/08" },
    { key: "2026-01-02", period: "day", label: "02/01" },
    { key: "2026-W33", period: "week", label: "S33" },
    { key: "2021-W53", period: "week", label: "S53" },
    { key: "2026-08", period: "month", label: "08/26" },
    { key: "1999-12", period: "month", label: "12/99" },
  ];
  for (const { key, period, label } of cases) {
    it(`${period} ${key}`, () => {
      expect(formatBucket(key, period)).toBe(label);
    });
  }

  // Recharts hands the formatter whatever is in the data, including the gaps
  // it inserts itself. Returning `undefined/undefined` there would print
  // literal "undefined" on the axis.
  it("hands back anything it cannot parse", () => {
    expect(formatBucket("", "day")).toBe("");
    expect(formatBucket("2026-08-14", "week")).toBe("2026-08-14");
    expect(formatBucket(undefined, "day")).toBe(undefined);
    expect(formatBucket(7, "month")).toBe(7);
  });
});

describe("myMoveCount", () => {
  const withMoves = {
    user_color: "black",
    analysis: {
      moves_evaluated: 5,
      moves: [
        { color: "white" },
        { color: "black" },
        { color: "white" },
        { color: "black" },
        { color: "white" },
      ],
    },
  };

  it("counts the user's own moves, not the plies", () => {
    expect(myMoveCount(withMoves)).toBe(2);
    expect(myMoveCount({ ...withMoves, user_color: "white" })).toBe(3);
  });

  // A game analysed before the move list was stored, and every fixture game,
  // has only the ply count. White plays the odd plies, Black the even ones.
  it("halves the ply count on the correct side when there is no move list", () => {
    const counts = (plies, color) =>
      myMoveCount({ user_color: color, analysis: { moves_evaluated: plies } });
    expect(counts(5, "white")).toBe(3);
    expect(counts(5, "black")).toBe(2);
    expect(counts(4, "white")).toBe(2);
    expect(counts(4, "black")).toBe(2);
  });

  it("says it does not know rather than guessing zero", () => {
    expect(myMoveCount({ user_color: "white" })).toBe(null);
    expect(myMoveCount({ user_color: "white", analysis: {} })).toBe(null);
    expect(myMoveCount({ user_color: "white", analysis: { moves: [] } })).toBe(null);
  });
});

describe("computeJudgmentTrends", () => {
  const game = (id, day, color, counts, plies) => ({
    id,
    user_color: color,
    result: "loss",
    played_at: `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    analysis: {
      moves_evaluated: plies,
      judgment_counts: { [color]: counts },
    },
  });

  const games = [
    game(1, 10, "white", { inaccuracy: 2, mistake: 1, blunder: 1 }, 40),
    game(2, 10, "black", { inaccuracy: 0, mistake: 2, blunder: 3 }, 60),
    game(3, 11, "white", { inaccuracy: 1, mistake: 0, blunder: 0 }, 20),
  ];

  it("sums each judgment per bucket", () => {
    const [first, second] = computeJudgmentTrends(games, { period: "day", limit: 10 });
    expect(first.period).toBe("2026-08-10");
    expect(first.games).toBe(2);
    expect(first.blunders).toBe(4);
    expect(first.mistakes).toBe(3);
    expect(first.inaccuracies).toBe(2);
    expect(second.blunders).toBe(0);
    expect(second.inaccuracies).toBe(1);
  });

  it("divides per game by the analysed games, not by every game", () => {
    const withUnanalysed = [...games, { ...game(4, 10, "white", {}, 0), analysis: null }];
    const [first] = computeJudgmentTrends(withUnanalysed, { period: "day", limit: 10 });
    expect(first.games).toBe(3);
    expect(first.analysed).toBe(2);
    expect(first.blunders_per_game).toBe(2);
  });

  // 20 + 30 = 50 of the user's own moves in that bucket, 4 blunders: 8 per 100.
  it("rates per hundred of the user's own moves", () => {
    const [first] = computeJudgmentTrends(games, { period: "day", limit: 10 });
    expect(first.moves).toBe(50);
    expect(first.blunders_per_100).toBe(8);
    expect(first.mistakes_per_100).toBe(6);
  });

  // The trap: counting a game's blunders while its moves are missing from the
  // denominator turns thin data into a spike that looks like a collapse.
  it("keeps a game out of the rate entirely when its moves are unknown", () => {
    const blind = {
      ...game(9, 10, "white", { inaccuracy: 0, mistake: 0, blunder: 5 }, 0),
      analysis: { judgment_counts: { white: { blunder: 5 } } },
    };
    const [first] = computeJudgmentTrends([...games, blind], { period: "day", limit: 10 });
    expect(first.blunders).toBe(9); // still reported as a total
    expect(first.moves).toBe(50); // its moves are not in the denominator
    expect(first.blunders_per_100).toBe(8); // so its blunders are not in the numerator
  });

  it("reports no rate at all rather than zero when nothing is analysed", () => {
    const [only] = computeJudgmentTrends(
      [{ ...game(1, 10, "white", {}, 0), analysis: null }],
      { period: "day", limit: 10 },
    );
    expect(only.analysed).toBe(0);
    expect(only.moves).toBe(null);
    expect(only.blunders_per_game).toBe(null);
    expect(only.blunders_per_100).toBe(null);
  });

  it("keeps the newest buckets when there are more than the limit", () => {
    const many = [1, 2, 3, 4, 5].map((d) => game(d, d + 9, "white", { blunder: d }, 20));
    const points = computeJudgmentTrends(many, { period: "day", limit: 2 });
    expect(points.map((p) => p.period)).toEqual(["2026-08-13", "2026-08-14"]);
  });
});

describe("smoothingWeights", () => {
  it("peaks on the day itself and falls off symmetrically", () => {
    expect(smoothingWeights(3).map((w) => w.weight)).toEqual([1, 2, 3, 4, 3, 2, 1]);
    expect(smoothingWeights(3).map((w) => w.offset)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(smoothingWeights(0).map((w) => w.weight)).toEqual([1]);
  });
});

describe("computeSmoothedTrends", () => {
  const on = (day, over = {}) => {
    const { accuracy = 80, acpl = 40, counts = {}, plies = 40, result = "win" } = over;
    return {
      id: `${day}-${Math.random()}`,
      user_color: "white",
      result,
      played_at: `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`,
      analysis: {
        moves_evaluated: plies,
        accuracy_white: accuracy,
        accuracy_black: accuracy,
        acpl_white: acpl,
        acpl_black: acpl,
        judgment_counts: { white: counts, black: counts },
      },
    };
  };

  // Without this the series is drawn against the days that happen to have
  // games, so a "neighbour" can be three weeks away across a gap and the
  // smoothing quietly averages across it.
  it("walks the calendar, including days with no games", () => {
    const series = computeSmoothedTrends([on(10), on(14)], { radius: 1 });
    expect(series.map((p) => p.period)).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
    // The 12th sits two days from either game, outside a radius of 1.
    expect(series[2].win_rate).toBe(null);
    expect(series[2].games).toBe(0);
  });

  // The whole reason the raw components are carried around rather than the
  // daily averages: otherwise a day with one game weighs as much as a day
  // with ten, and one bad afternoon owns the line.
  it("weighs by games played, not by days", () => {
    const games = [
      on(10, { result: "loss" }),
      ...Array.from({ length: 9 }, () => on(11, { result: "win" })),
    ];
    const series = computeSmoothedTrends(games, { radius: 1 });
    const eleventh = series.find((p) => p.period === "2026-08-11");

    // Ten games in the window, nine of them wins - not the midpoint of a 0 %
    // day and a 100 % day, which would be 50.
    expect(eleventh.window_games).toBe(10 + 9); // weight 2 on the day itself
    expect(eleventh.win_rate).toBeGreaterThan(90);
  });

  it("keeps each day's own value beside the smoothed one", () => {
    const series = computeSmoothedTrends([on(10, { accuracy: 100 }), on(11, { accuracy: 0 })], {
      radius: 1,
    });
    const tenth = series[0];
    expect(tenth.raw_avg_accuracy).toBe(100);
    // Its own day carries weight 2, the neighbour weight 1: (2*100 + 0) / 3.
    expect(tenth.avg_accuracy).toBe(66.7);
  });

  it("smooths the judgment counts the same way", () => {
    const series = computeSmoothedTrends(
      [on(10, { counts: { blunder: 4 }, plies: 40 }), on(11, { counts: { blunder: 0 }, plies: 40 })],
      { radius: 1 },
    );
    // The raw totals keep the field names computeJudgmentTrends uses, so a
    // caller can sum a window without knowing which series it is holding.
    expect(series[0].blunders).toBe(4);
    expect(series[1].blunders).toBe(0);
    expect(series[0].raw_blunders_per_game).toBe(4);
    expect(series[0].blunders_per_game).toBe(2.67); // (2*4 + 0) / 3
    // 20 of the user's own moves per game, weighted 2 and 1: 60 moves, 8 blunders.
    expect(series[0].blunders_per_100).toBe(13.33);
  });

  it("smooths across the edge of the window rather than at it", () => {
    // 40 days of play, asked for the last 5: those five must still be smoothed
    // against the days before them, not against an empty left edge.
    const games = Array.from({ length: 28 }, (_, i) => on(i + 1, { accuracy: 50 }));
    const series = computeSmoothedTrends(games, { radius: 3, limit: 5 });
    expect(series.length).toBe(5);
    expect(series[0].avg_accuracy).toBe(50);
  });

  it("has nothing to say about an empty archive", () => {
    expect(computeSmoothedTrends([])).toEqual([]);
    expect(computeSmoothedTrends([{ played_at: "nonsense", user_color: "white" }])).toEqual([]);
  });
});
