/**
 * The second layer of statistics.
 *
 * Nothing here is pinned to a recording of anything, which is exactly why the
 * tests have to carry their own weight. Every one of these numbers is a ratio
 * or an average that stays perfectly plausible when it is wrong - a rating
 * band that swallows its own boundary twice, a mistake list ranked from
 * already-lost positions, a clock read against the wrong side. So each case
 * below pairs what should be counted with what should not.
 */

import { describe, expect, it } from "vitest";

import {
  byPiece,
  byRatingGap,
  clockPressure,
  clockSeconds,
  computeInsights,
  conversion,
  costlyMistakes,
  moveTimes,
  openingExit,
  periodComparison,
  pieceOf,
  sessionTilt,
  timeControl,
} from "../insights.js";

const DAY = 86_400;
const BASE = 1_756_000_000;

/** A game with just enough on it for the function under test. */
function game(overrides = {}) {
  const { moves, errors, counts, ...rest } = overrides;
  return {
    id: 1,
    user_color: "white",
    result: "win",
    opponent_username: "rival",
    user_rating: 1200,
    opponent_rating: 1200,
    opening: "Sicilian Defense",
    end_time: BASE,
    played_at: new Date(BASE * 1000).toISOString(),
    ...rest,
    analysis:
      moves || errors || counts
        ? {
            moves: moves ?? [],
            errors: errors ?? [],
            judgment_counts: { white: counts ?? {}, black: counts ?? {} },
            accuracy_white: 80,
            accuracy_black: 80,
            acpl_white: 40,
            acpl_black: 40,
          }
        : (rest.analysis ?? null),
  };
}

const move = (ply, over = {}) => ({
  ply,
  move_number: Math.ceil(ply / 2),
  color: ply % 2 ? "white" : "black",
  san: "e4",
  eval_cp: 0,
  cp_loss: 0,
  judgment: null,
  ...over,
});

describe("byRatingGap", () => {
  // The bands are half-open, so a gap sitting exactly on a boundary must land
  // in one of them and only one. Counted twice it inflates both rows; counted
  // in neither it silently disappears from the table.
  it("puts a gap on exactly one side of a boundary", () => {
    const rows = byRatingGap([
      game({ id: 1, opponent_rating: 1049 }), // -151
      game({ id: 2, opponent_rating: 1050 }), // -150 exactly
      game({ id: 3, opponent_rating: 1350 }), // +150 exactly
      game({ id: 4, opponent_rating: 1349 }), // +149
    ]);
    expect(rows.reduce((n, r) => n + r.games, 0)).toBe(4);
    expect(rows.find((r) => r.key === "much_weaker").games).toBe(1);
    expect(rows.find((r) => r.key === "weaker").games).toBe(1);
    expect(rows.find((r) => r.key === "stronger").games).toBe(1);
    expect(rows.find((r) => r.key === "much_stronger").games).toBe(1);
  });

  it("ignores a game with no rating on one side rather than calling it even", () => {
    const rows = byRatingGap([
      game({ id: 1, opponent_rating: null }),
      game({ id: 2, user_rating: null }),
      game({ id: 3, opponent_rating: 1200 }),
    ]);
    expect(rows.reduce((n, r) => n + r.games, 0)).toBe(1);
    expect(rows[0].key).toBe("even");
  });

  it("scores draws as half a win", () => {
    const rows = byRatingGap([
      game({ id: 1, result: "win" }),
      game({ id: 2, result: "draw" }),
      game({ id: 3, result: "loss" }),
      game({ id: 4, result: "loss" }),
    ]);
    expect(rows[0].win_rate).toBe(37.5);
    expect(rows[0].losses).toBe(2);
  });

  it("drops empty bands instead of printing them as zeroes", () => {
    const rows = byRatingGap([game()]);
    expect(rows.length).toBe(1);
  });
});

describe("costlyMistakes", () => {
  const error = (over = {}) => ({
    color: "white",
    ply: 21,
    move_number: 11,
    san: "Nf3",
    best_move_san: "Bb5",
    cp_loss: 200,
    judgment: "mistake",
    phase: "middlegame",
    eval_cp_before: 0,
    ...over,
  });

  // The whole point of the rewrite: a huge loss from an already-lost position
  // outranked the moderate one that threw a level game.
  it("drops moves played from a position that was already decided", () => {
    const rows = costlyMistakes([
      game({ id: 1, errors: [error({ cp_loss: 900, eval_cp_before: -1200 })] }),
      game({ id: 2, errors: [error({ cp_loss: 250, eval_cp_before: 20 })] }),
    ]);
    expect(rows.map((r) => r.game_id)).toEqual([2]);
  });

  // The threshold is symmetric on purpose: three pawns from level is decided
  // whichever side you are on, so a Black player's +400 is dropped for exactly
  // the same reason a White player's -400 is.
  it("drops a decided position from either side of the board", () => {
    const dropped = (color, before) =>
      costlyMistakes([
        game({ id: 1, user_color: color, errors: [error({ color, eval_cp_before: before })] }),
      ]).length === 0;

    expect(dropped("black", 400)).toBe(true);
    expect(dropped("white", -400)).toBe(true);
    expect(dropped("black", -400)).toBe(true);
    expect(dropped("white", 400)).toBe(true);
    // And a position still within reach survives from either side.
    expect(dropped("black", 250)).toBe(false);
    expect(dropped("white", -250)).toBe(false);
  });

  // The worst move is deliberately not the last one: keeping "the most recent"
  // instead of "the worst" would pass a list ordered the other way round.
  it("keeps only the worst move of each game, whatever order they arrive in", () => {
    const errors = [error({ cp_loss: 120, ply: 5 }), error({ cp_loss: 260, ply: 9 }), error({ cp_loss: 180, ply: 15 })]
    for (const order of [errors, [...errors].reverse()]) {
      const rows = costlyMistakes([game({ id: 1, errors: order })]);
      expect(rows.length).toBe(1);
      expect(rows[0].cp_loss).toBe(260);
      expect(rows[0].ply).toBe(9);
    }
  });

  it("ignores the opponent's mistakes", () => {
    const rows = costlyMistakes([game({ id: 1, errors: [error({ color: "black" })] })]);
    expect(rows).toEqual([]);
  });

  // Analyses stored before the field existed would otherwise disappear from
  // the list entirely, which reads as "you played cleanly".
  it("keeps a move whose earlier evaluation was never recorded", () => {
    const rows = costlyMistakes([
      game({ id: 1, errors: [error({ eval_cp_before: undefined })] }),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].eval_cp_before).toBe(null);
  });

  it("ranks across games and honours the limit", () => {
    const games = [1, 2, 3].map((id) =>
      game({ id, errors: [error({ cp_loss: id * 100 })] }),
    );
    const rows = costlyMistakes(games, { limit: 2 });
    expect(rows.map((r) => r.cp_loss)).toEqual([300, 200]);
  });
});

describe("conversion", () => {
  it("counts a game once it has been winning, whatever happened after", () => {
    const result = conversion([
      game({ id: 1, result: "loss", moves: [move(1, { eval_cp: 400 }), move(3, { eval_cp: -50 })] }),
      game({ id: 2, result: "win", moves: [move(1, { eval_cp: 300 })] }),
    ]);
    expect(result.winning_positions).toBe(2);
    expect(result.converted).toBe(1);
    expect(result.conversion_rate).toBe(50);
  });

  it("reads the evaluation from the user's side", () => {
    // +400 White is winning for White and losing for Black.
    const asBlack = conversion([
      game({ id: 1, user_color: "black", result: "loss", moves: [move(2, { eval_cp: 400 })] }),
    ]);
    expect(asBlack.winning_positions).toBe(0);
    expect(asBlack.losing_positions).toBe(1);
  });

  it("treats a draw from a lost position as saved", () => {
    const result = conversion([
      game({ id: 1, result: "draw", moves: [move(1, { eval_cp: -500 })] }),
      game({ id: 2, result: "loss", moves: [move(1, { eval_cp: -500 })] }),
    ]);
    expect(result.losing_positions).toBe(2);
    expect(result.saved).toBe(1);
    expect(result.save_rate).toBe(50);
  });

  it("has no opinion when nothing was ever decided", () => {
    const result = conversion([game({ id: 1, moves: [move(1, { eval_cp: 10 })] })]);
    expect(result.winning_positions).toBe(0);
    expect(result.conversion_rate).toBe(null);
  });
});

describe("pieceOf", () => {
  const cases = [
    ["e4", "P"],
    ["exd5", "P"],
    ["e8=Q", "P"],
    ["Nf3", "N"],
    ["Qxd5+", "Q"],
    ["Rae1", "R"],
    ["Bb5#", "B"],
    ["Kg1", "K"],
    ["O-O", "K"],
    ["O-O-O", "K"],
  ];
  for (const [san, piece] of cases) {
    it(`${san} moves a ${piece}`, () => expect(pieceOf(san)).toBe(piece));
  }
});

describe("byPiece", () => {
  it("averages the loss per piece and counts the blunders", () => {
    const rows = byPiece([
      game({
        id: 1,
        moves: [
          move(1, { san: "Qh5", cp_loss: 300, judgment: "blunder" }),
          move(3, { san: "Qf3", cp_loss: 100 }),
          move(5, { san: "e4", cp_loss: 0 }),
          move(2, { san: "Nc6", cp_loss: 900 }), // the opponent's move
        ],
      }),
    ]);
    const queen = rows.find((r) => r.piece === "Q");
    expect(queen.moves).toBe(2);
    expect(queen.avg_cp_loss).toBe(200);
    expect(queen.blunders).toBe(1);
    // Black's knight move belongs to the opponent and must not appear.
    expect(rows.find((r) => r.piece === "N")).toBe(undefined);
  });
});

describe("openingExit", () => {
  const opened = (id, name, losses) =>
    game({
      id,
      opening: name,
      moves: losses.map((cp, i) => move(i * 2 + 1, { cp_loss: cp })),
    });

  it("only looks at the first moves", () => {
    const rows = openingExit([opened(1, "Sicilienne", [0, 0, 600]), opened(2, "Sicilienne", [])], {
      moves: 2,
      minGames: 1,
    });
    expect(rows[0].moves).toBe(2);
    expect(rows[0].acpl).toBe(0);
  });

  it("needs more than one game before naming an opening", () => {
    const rows = openingExit([opened(1, "Sicilienne", [100]), opened(2, "Française", [100])], {
      minGames: 2,
    });
    expect(rows).toEqual([]);
  });

  it("ranks the most expensive opening first", () => {
    const rows = openingExit(
      [
        opened(1, "Sicilienne", [200, 200]),
        opened(2, "Sicilienne", [200, 200]),
        opened(3, "Française", [10, 10]),
        opened(4, "Française", [10, 10]),
      ],
      { minGames: 2 },
    );
    expect(rows.map((r) => r.name)).toEqual(["Sicilienne", "Française"]);
    expect(rows[0].acpl).toBe(200);
  });
});

describe("sessionTilt", () => {
  it("starts a new session after a long enough gap", () => {
    const rows = sessionTilt([
      game({ id: 1, end_time: BASE }),
      game({ id: 2, end_time: BASE + 600 }), // same sitting
      game({ id: 3, end_time: BASE + 5 * DAY }), // a new one
    ]);
    expect(rows.find((r) => r.rank === 1).games).toBe(2);
    expect(rows.find((r) => r.rank === 2).games).toBe(1);
  });

  it("orders by when the game was played, not by the order it was handed", () => {
    const rows = sessionTilt([
      game({ id: 2, end_time: BASE + 600, result: "loss" }),
      game({ id: 1, end_time: BASE, result: "win" }),
    ]);
    expect(rows.find((r) => r.rank === 1).win_rate).toBe(100);
    expect(rows.find((r) => r.rank === 2).win_rate).toBe(0);
  });

  it("folds everything past the fourth game into one bucket", () => {
    const rows = sessionTilt(
      [0, 1, 2, 3, 4, 5].map((i) => game({ id: i + 1, end_time: BASE + i * 600 })),
    );
    expect(rows.at(-1).rank).toBe(4);
    expect(rows.at(-1).games).toBe(3);
  });
});

describe("the clock", () => {
  const pgn = (clocks) =>
    `[Event "Live Chess"]\n\n${clocks
      .map((c, i) => `${i % 2 === 0 ? `${i / 2 + 1}. ` : ""}e4 {[%clk ${c}]}`)
      .join(" ")} 1-0\n`;

  it("reads every clock tag in ply order", () => {
    expect(clockSeconds(pgn(["0:03:00", "0:02:58.5", "0:02:55"]))).toEqual([180, 178.5, 175]);
    expect(clockSeconds("1. e4 e5 1-0")).toEqual([]);
    expect(clockSeconds(null)).toEqual([]);
  });

  it("understands a base with and without an increment", () => {
    expect(timeControl("600")).toEqual({ base: 600, increment: 0 });
    expect(timeControl("180+2")).toEqual({ base: 180, increment: 2 });
    // Daily games are seconds per move, not a clock to run down.
    expect(timeControl("1/259200")).toBe(null);
    expect(timeControl(undefined)).toBe(null);
  });

  // The tag says what was left after the move, so the time spent is measured
  // against the previous reading of the same side - not the previous tag.
  it("measures against the same side's previous reading, plus the increment", () => {
    const times = moveTimes({
      user_color: "white",
      time_control: "180+2",
      pgn: pgn(["0:02:59", "0:02:58", "0:02:55", "0:02:50"]),
      analysis: { moves: [move(1), move(2), move(3, { judgment: "blunder" }), move(4)] },
    });
    expect(times.map((t) => t.ply)).toEqual([1, 3]);
    expect(times[0].seconds).toBe(3); // 180 - 179 + 2
    expect(times[1].seconds).toBe(6); // 179 - 175 + 2
    expect(times[1].judgment).toBe("blunder");
  });

  it("measures Black's moves off Black's clock", () => {
    const times = moveTimes({
      user_color: "black",
      time_control: "180",
      pgn: pgn(["0:02:59", "0:02:50", "0:02:55", "0:02:30"]),
      analysis: { moves: [] },
    });
    expect(times.map((t) => t.ply)).toEqual([2, 4]);
    expect(times[0].seconds).toBe(10); // 180 - 170
    expect(times[1].seconds).toBe(20); // 170 - 150
  });

  it("never reports a negative duration", () => {
    const times = moveTimes({
      user_color: "white",
      time_control: "180",
      pgn: pgn(["0:03:30", "0:02:00"]),
      analysis: { moves: [] },
    });
    expect(times[0].seconds).toBe(0);
  });

  it("says nothing at all rather than zero when no game carries a clock", () => {
    expect(clockPressure([game({ id: 1, pgn: "1. e4 e5 1-0", time_control: "180" })])).toBe(null);
    expect(clockPressure([])).toBe(null);
  });

  it("buckets the blunders by how long the move took", () => {
    const result = clockPressure([
      {
        ...game({
          id: 1,
          moves: [
            move(1, { judgment: "blunder", cp_loss: 400 }),
            move(3, { cp_loss: 10 }),
            move(5, { cp_loss: 20 }),
          ],
        }),
        time_control: "180",
        // White: 3 s, then 60 s, then 40 s. Black's readings are ignored.
        pgn: pgn(["0:02:57", "0:02:00", "0:01:57", "0:01:00", "0:01:17", "0:00:30"]),
      },
    ]);
    expect(result.games).toBe(1);
    expect(result.moves).toBe(3);
    expect(result.blunders).toBe(1);
    expect(result.fast_blunders).toBe(1);
    expect(result.fast_blunder_share).toBe(100);

    const instant = result.buckets.find((b) => b.key === "instant");
    expect(instant.moves).toBe(1);
    expect(instant.blunder_rate).toBe(100);
    expect(result.buckets.find((b) => b.key === "slow").moves).toBe(2);
    expect(result.buckets.find((b) => b.key === "fast")).toBe(undefined);
  });
});

describe("periodComparison", () => {
  const played = (id, daysAgo, result) =>
    game({ id, result, end_time: BASE - daysAgo * DAY, counts: { blunder: 1 } });

  it("compares the window against the one before it, measured from the newest game", () => {
    const result = periodComparison(
      [played(1, 0, "win"), played(2, 5, "win"), played(3, 40, "loss"), played(4, 50, "loss")],
      { days: 30 },
    );
    expect(result.current.games).toBe(2);
    expect(result.previous.games).toBe(2);
    expect(result.current.win_rate).toBe(100);
    expect(result.previous.win_rate).toBe(0);
    expect(result.deltas.win_rate).toBe(100);
  });

  it("has no delta when there is no earlier window to compare with", () => {
    const result = periodComparison([played(1, 0, "win")], { days: 30 });
    expect(result.previous).toBe(null);
    expect(result.deltas.win_rate).toBe(null);
  });

  it("says nothing when there are no games", () => {
    expect(periodComparison([])).toBe(null);
  });
});

describe("computeInsights", () => {
  it("survives an archive with nothing analysed in it", () => {
    const insights = computeInsights([game({ id: 1 })]);
    expect(insights.clock).toBe(null);
    expect(insights.costly_mistakes).toEqual([]);
    expect(insights.by_piece).toEqual([]);
    expect(insights.conversion.winning_positions).toBe(0);
    expect(insights.by_rating_gap.length).toBe(1);
  });

  it("survives an empty archive", () => {
    const insights = computeInsights([]);
    expect(insights.comparison).toBe(null);
    expect(insights.by_rating_gap).toEqual([]);
    expect(insights.session_tilt).toEqual([]);
  });
});
