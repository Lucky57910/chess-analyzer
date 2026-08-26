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
import { computeMistakes, computeStats, computeTrends, isoWeek, rate } from "../stats.js";

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
