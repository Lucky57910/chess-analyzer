/**
 * `normalizeGame` against the frozen Python output.
 *
 * The function is small but almost entirely branches - which side am I, is this
 * a draw code or a loss, where does the opening name come from - and every one
 * of them silently produces a plausible-looking row when wrong. A game filed
 * under the wrong colour still renders; it just makes the whole dashboard lie.
 */

import { describe, expect, it } from "vitest";

import golden from "../__fixtures__/golden-data.json";
import { DRAW_RESULTS, GAME_KINDS, gameKind, normalizeGame } from "../chessCom.js";

const ME = "maxime";

/**
 * Python writes `2025-08-24T02:26:40+00:00`, JS writes `...T02:26:40.000Z`.
 * Same instant, different spelling, and nothing reads it as a string - it is
 * stored for ordering and formatting. Compared as a timestamp, not text.
 */
function sameInstant(actual, expected) {
  expect(Date.parse(actual)).toBe(Date.parse(expected));
}

describe("normalizeGame", () => {
  it("knows the same draw codes as the Python", () => {
    expect([...DRAW_RESULTS].sort()).toEqual(golden.draw_results);
  });

  for (const { name, raw, out } of golden.normalize) {
    it(name, () => {
      const actual = normalizeGame(raw, ME);

      if (out === null) {
        expect(actual, "should have been rejected").toBeNull();
        return;
      }

      expect(actual).not.toBeNull();
      sameInstant(actual.played_at, out.played_at);

      const { played_at: _a, ...actualRest } = actual;
      const { played_at: _b, ...expectedRest } = out;
      expect(actualRest).toEqual(expectedRest);
    });
  }

  it("matches usernames case-insensitively", () => {
    const raw = golden.normalize.find((c) => c.name === "win_as_white").raw;
    expect(normalizeGame(raw, "MaXiMe")?.user_color).toBe("white");
  });

  it("covers both colours and all three results", () => {
    const rows = golden.normalize
      .map(({ raw }) => normalizeGame(raw, ME))
      .filter(Boolean);
    expect(new Set(rows.map((r) => r.user_color))).toEqual(new Set(["white", "black"]));
    expect(new Set(rows.map((r) => r.result))).toEqual(new Set(["win", "loss", "draw"]));
  });
});

describe("gameKind", () => {
  // The one rule that decides whether a game counts towards the player's real
  // strength. It reads `rated`, so it has to give the same answer for a raw
  // archive entry, a normalised row and a line of an old backup.
  it("files an unrated game as training and everything else as rated", () => {
    expect(gameKind({ rated: false })).toBe("training");
    expect(gameKind({ rated: true })).toBe("rated");
  });

  // Chess.com omits the field on some older archives, and a game with no
  // opinion about it is an ordinary game: defaulting the other way would empty
  // the rated statistics for anyone with an old archive.
  it("treats a missing or unreadable value as rated", () => {
    expect(gameKind({})).toBe("rated");
    expect(gameKind({ rated: undefined })).toBe("rated");
    expect(gameKind(null)).toBe("rated");
    expect(gameKind(undefined)).toBe("rated");
  });

  // `rated: 0` from a SQLite row is falsy but is not `false`. Reading it as
  // "not training" would put every unrated game back in the rated average
  // after a restore.
  it("is written against a real boolean, and says so", () => {
    expect(gameKind({ rated: 0 })).toBe("rated");
    expect(GAME_KINDS).toEqual(["rated", "training"]);
  });
});
