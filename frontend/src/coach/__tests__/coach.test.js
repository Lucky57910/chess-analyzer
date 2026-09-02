/**
 * The coach layer, without a key and without a network.
 *
 * Three things are worth holding here, and they are the three that would ship
 * broken without a test:
 *
 *   1. The digest never says anything the engine did not. It is the whole
 *      defence against a model inventing a variation, so a change that let a
 *      raw PGN through would be the worst regression this feature can have.
 *   2. A model's answer is checked, not trusted. Every failure mode below has
 *      been seen from a real small model: a fenced block, a ply that was never
 *      asked about, an essay where a comment was wanted.
 *   3. One failed chunk does not cost the others.
 *
 * Each test is written to fail if the behaviour it names is removed - the
 * "wrong ply" case, for instance, asserts the absence, not just the presence.
 */

import { describe, expect, it, vi } from "vitest";

import { createCoach, extractJson, validate, MAX_COMMENT_CHARS } from "../client.js";
import {
  buildDigest,
  entriesFor,
  formatEntry,
  headerFor,
  structuralChanges,
  CHUNK_SIZE,
} from "../digest.js";
import { createLimiter, retryDelay } from "../throttle.js";
import { costPerGame, formatCost, tokensForGame } from "../cost.js";
import { narrate } from "../narrate.js";
import { PROVIDERS } from "../providers.js";
import {
  keySetting,
  publicCoachConfig,
  readCoachConfig,
  writeCoachConfig,
  SETTING_COACH_FALLBACK,
  SETTING_COACH_KEY,
  SETTING_COACH_MODEL,
  SETTING_COACH_PROVIDER,
} from "../config.js";

/** A four-move game with one judged blunder for White. */
const GAME = {
  id: 1,
  user_color: "white",
  user_rating: 1400,
  opponent_username: "rival",
  opponent_rating: 1380,
  time_class: "blitz",
  opening: "Sicilian Defense",
  result: "loss",
  pgn: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
};

const ANALYSIS = {
  moves: [
    { ply: 1, judgment: null, is_best: true, cp_loss: 0, eval_cp_before: 20, eval_cp: 25 },
    { ply: 3, judgment: "mistake", is_best: false, cp_loss: 180, best_move_san: "Nf3",
      eval_cp_before: 25, eval_cp: -155 },
  ],
};

describe("the digest a model is allowed to see", () => {
  it("covers the player's moves and nobody else's", () => {
    const entries = entriesFor({ game: GAME, analysis: ANALYSIS });
    expect(entries.map((e) => e.ply)).toEqual([1, 3, 5, 7]);
    // Black's replies are absent: they double the request and the player
    // cannot do anything about them.
    expect(entries.some((e) => e.ply % 2 === 0)).toBe(false);
  });

  it("carries the engine's judgment onto the move it belongs to", () => {
    const entries = entriesFor({ game: GAME, analysis: ANALYSIS });
    const judged = entries.find((e) => e.ply === 3);
    expect(judged.judgment).toBe("mistake");
    expect(judged.cp_loss).toBe(180);
    expect(judged.best_move_san).toBe("Nf3");
    expect(formatEntry(judged)).toContain("erreur, coûte 180 cp");
    expect(formatEntry(judged)).toContain("le moteur jouait Nf3");
  });

  it("never hands over the PGN", () => {
    const [chunk] = buildDigest({ game: GAME, analysis: ANALYSIS });
    // The single most important property of this module: the model reasons
    // about the engine's findings, not about a game it would re-analyse
    // itself - badly, and confidently.
    expect(chunk.text).not.toContain(GAME.pgn);
    expect(chunk.text).not.toMatch(/1\. e4 e5/);
  });

  it("says who is playing whom, so the tone can fit the level", () => {
    expect(headerFor(GAME)).toContain("blancs (1400)");
    expect(headerFor(GAME)).toContain("rival (1380)");
    expect(headerFor(GAME)).toContain("résultat défaite");
  });

  it("splits long games into request-sized chunks that each stand alone", () => {
    const long = { ...GAME, pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. c3 Nf6 6. b4 Bb6 " +
      "7. a4 a6 8. Bg5 h6 9. Bh4 g5 10. Bg3 Nh5 11. Nbd2 Nxg3 12. hxg3 Qf6 13. Qb3 Qg6 " +
      "14. O-O-O Be6 15. d4 exd4 16. cxd4 O-O-O 17. d5 Bxd5 18. exd5 Nb8 *" };
    const chunks = buildDigest({ game: long, analysis: { moves: [] }, size: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk repeats the header, because a model given moves 6-10 with no
    // idea whose side it is on writes advice for the wrong player.
    for (const chunk of chunks) expect(chunk.text).toContain("Joueur : blancs");
  });

  it("still produces a digest for a game analysed before variations were stored", () => {
    const chunks = buildDigest({ game: GAME, analysis: { moves: [{ ply: 3, judgment: "blunder", cp_loss: 400 }] } });
    expect(chunks[0].text).toContain("gaffe, coûte 400 cp");
  });
});

describe("reading a model's answer", () => {
  it("finds the object inside a fenced block", () => {
    const answer = '```json\n{"comments":[{"ply":3,"text":"Trop tôt."}]}\n```';
    expect(extractJson(answer)).toEqual({ comments: [{ ply: 3, text: "Trop tôt." }] });
  });

  it("finds the object after a sentence the model added anyway", () => {
    const answer = 'Voici : {"comments":[{"ply":1,"text":"Bien."}]}';
    expect(extractJson(answer).comments[0].ply).toBe(1);
  });

  it("refuses an answer with no object in it", () => {
    expect(() => extractJson("désolé, je ne peux pas")).toThrow(/illisible/);
    expect(() => extractJson("")).toThrow(/vide/);
  });

  it("drops a comment about a move it was not asked about", () => {
    const notes = validate(
      { comments: [{ ply: 3, text: "ok" }, { ply: 99, text: "inventé" }] },
      [1, 3],
    );
    expect(notes).toEqual({ 3: "ok" });
    expect(notes[99]).toBeUndefined();
  });

  it("drops an over-long comment rather than cutting it mid-sentence", () => {
    const long = "a".repeat(MAX_COMMENT_CHARS + 1);
    expect(validate({ comments: [{ ply: 1, text: long }] }, [1])).toEqual({});
  });

  it("survives a shape that is not the one that was asked for", () => {
    expect(validate(null, [1])).toEqual({});
    expect(validate({ comments: "non" }, [1])).toEqual({});
  });
});

/** A CapacitorHttp stand-in returning whatever the test queues up. */
function fakeHttp(responses) {
  const calls = [];
  const post = vi.fn(async (request) => {
    calls.push(request);
    // The last queued answer repeats: a test about retrying should not have to
    // count how many times the client will try.
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (typeof next === "function") return next(request);
    return next;
  });
  return { http: { post }, calls };
}

/**
 * A clock the test drives.
 *
 * Sleeping advances it instead of waiting, so a minute of rate-limited traffic
 * runs in a millisecond - and, unlike a no-op sleep, the limiter's window
 * actually empties, which is the difference between a fast test and a spin.
 */
function virtualClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

// The Interactions API answers with a timeline. A thinking step sits in front
// of the output on the 3.x models, and picking it up instead would produce a
// parse failure rather than a comment, so the fixture carries one.
const geminiReply = (comments) => ({
  status: 200,
  data: {
    status: "completed",
    steps: [
      { type: "thinking", content: [{ type: "text", text: "Le cavalier est en prise…" }] },
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify({ comments }) }],
      },
    ],
  },
});

describe("commenting a whole game", () => {
  const config = { provider: "gemini", model: "gemini-3.7-flash", apiKey: "test-key" };

  it("keys the commentary by ply and reports nothing failed", async () => {
    const { http, calls } = fakeHttp([
      geminiReply([
        { ply: 1, text: "Tu ouvres au centre." },
        { ply: 3, text: "La dame sort trop tôt." },
      ]),
    ]);
    const result = await createCoach(http).commentGame({ game: GAME, analysis: ANALYSIS, config });

    expect(result.notes[3]).toBe("La dame sort trop tôt.");
    expect(result.failed).toBe(0);
    // The key travels in the header the provider asked for, and nowhere else.
    expect(calls[0].headers["x-goog-api-key"]).toBe("test-key");
    expect(JSON.stringify(calls[0].data)).not.toContain(GAME.pgn);
  });

  it("keeps what one chunk produced when another fails", async () => {
    // Long enough to be split in two, whatever CHUNK_SIZE is set to. A
    // knights' shuffle is the shortest legal way to an arbitrary move count.
    const moves = [];
    for (let n = 1; n <= CHUNK_SIZE; n += 1) {
      moves.push(`${2 * n - 1}. Nf3 Nf6`, `${2 * n}. Ng1 Ng8`);
    }
    const long = { ...GAME, pgn: `${moves.join(" ")} *` };
    expect(buildDigest({ game: long, analysis: { moves: [] } })).toHaveLength(2);

    const { http, calls } = fakeHttp([
      geminiReply([{ ply: 1, text: "Bon départ." }]),
      { status: 500, data: { error: { message: "boom" } } },
    ]);
    const seen = [];
    const result = await createCoach(http, virtualClock()).commentGame({
      game: long,
      analysis: { moves: [] },
      config,
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });

    // One request for the first chunk, then three for the second: a 500 is
    // retried before it is believed.
    expect(calls).toHaveLength(4);
    // The second request failed; the first request's work survives it.
    expect(result.notes[1]).toBe("Bon départ.");
    expect(result.failed).toBe(1);
    expect(seen).toEqual(["1/2", "2/2"]);
  });

  it("gives up only when every chunk failed, and says why", async () => {
    const { http } = fakeHttp([{ status: 500, data: { error: { message: "surcharge" } } }]);
    await expect(
      createCoach(http, virtualClock()).commentGame({ game: GAME, analysis: ANALYSIS, config }),
    ).rejects.toThrow(/surchargé/);
  });

  // The report this exists for: "sur une dizaine d'essais, deux parties
  // commentées". A 503 used to kill the chunk on the spot and the app repeated
  // the provider's message back - which is the one thing it could do nothing
  // with. It is the moment, not the request.
  it("waits out an overloaded model instead of losing the chunk", async () => {
    const { http, calls } = fakeHttp([
      { status: 503, data: { error: { message: "model overloaded" } } },
      geminiReply([{ ply: 1, text: "Reprise après surcharge." }]),
    ]);
    const result = await createCoach(http, virtualClock()).commentGame({
      game: GAME,
      analysis: ANALYSIS,
      config,
    });

    expect(calls).toHaveLength(2);
    expect(result.notes[1]).toBe("Reprise après surcharge.");
    expect(result.failed).toBe(0);
  });

  // A phone changing cell mid-commentary. The transport throws, nothing was
  // answered, and there is nothing to read - which is exactly the case worth
  // retrying rather than reporting.
  it("retries a request that never arrived", async () => {
    let first = true;
    const { http } = fakeHttp([
      () => {
        if (first) {
          first = false;
          throw new Error("Network request failed");
        }
        return geminiReply([{ ply: 1, text: "Le réseau est revenu." }]);
      },
    ]);
    const result = await createCoach(http, virtualClock()).commentGame({
      game: GAME,
      analysis: ANALYSIS,
      config,
    });
    expect(result.notes[1]).toBe("Le réseau est revenu.");
  });

  it("says the network is the problem when it never comes back", async () => {
    const { http } = fakeHttp([
      () => {
        throw new Error("Network request failed");
      },
    ]);
    await expect(
      createCoach(http, virtualClock()).commentGame({ game: GAME, analysis: ANALYSIS, config }),
    ).rejects.toThrow(/injoignable/);
  });

  it("says which credential problem it hit, in French", async () => {
    const { http, calls } = fakeHttp([{ status: 401, data: {} }]);
    await expect(
      createCoach(http, virtualClock()).commentGame({ game: GAME, analysis: ANALYSIS, config }),
    ).rejects.toThrow(/Clé API refusée/);
    // A rejected key is not a rate limit: retrying it would only spend the
    // quota faster, so it fails on the first answer.
    expect(calls).toHaveLength(1);
  });

  it("waits out a 429 rather than losing the chunk to it", async () => {
    const waited = [];
    const { http, calls } = fakeHttp([
      { status: 429, headers: { "retry-after": "1" }, data: {} },
      geminiReply([{ ply: 1, text: "Reprise après attente." }]),
    ]);
    const result = await createCoach(http, virtualClock()).commentGame({
      game: GAME,
      analysis: ANALYSIS,
      config,
      onWait: (seconds) => waited.push(seconds),
    });

    expect(calls).toHaveLength(2);
    expect(result.notes[1]).toBe("Reprise après attente.");
    expect(result.failed).toBe(0);
    // The screen is told how long it is sitting out, so the pause is not a
    // frozen button.
    expect(waited).toEqual([1]);
  });

  it("gives up after two retries and says what to do about it", async () => {
    const { http, calls } = fakeHttp([{ status: 429, data: {} }]);
    await expect(
      createCoach(http, virtualClock()).commentGame({ game: GAME, analysis: ANALYSIS, config }),
    ).rejects.toThrow(/Quota du modèle atteint/);
    expect(calls).toHaveLength(3);
  });

  it("costs one request for a short game", async () => {
    const { http, calls } = fakeHttp([geminiReply([{ ply: 1, text: "ok" }])]);
    await createCoach(http, virtualClock()).commentGame({ game: GAME, analysis: ANALYSIS, config });
    // Four of the player's moves against a chunk of 24: the whole game is one
    // request, not one request per move.
    expect(calls).toHaveLength(1);
  });

  it("refuses to call anything without a key", async () => {
    const { http, calls } = fakeHttp([]);
    await expect(
      createCoach(http).commentGame({ game: GAME, analysis: ANALYSIS, config: { provider: "gemini" } }),
    ).rejects.toThrow(/clé API/i);
    expect(calls).toHaveLength(0);
  });

  it("speaks each provider's own dialect", async () => {
    const { http, calls } = fakeHttp([
      { status: 200, data: { choices: [{ message: { content: '{"comments":[{"ply":1,"text":"ok"}]}' } }] } },
    ]);
    const result = await createCoach(http, virtualClock()).commentGame({
      game: GAME,
      analysis: ANALYSIS,
      config: { provider: "openrouter", model: "x/y:free", apiKey: "k" },
    });
    expect(result.notes[1]).toBe("ok");
    expect(calls[0].url).toBe(PROVIDERS.openrouter.request({ apiKey: "k", model: "x/y:free" }).url);
    expect(calls[0].headers.Authorization).toBe("Bearer k");
  });
});

describe("what the bubble is told to say", () => {
  const move = { judgment: "blunder", cp_loss: 320, best_move_san: "Nf3", is_best: false };

  it("leads with the coach's paragraph but keeps the engine underneath it", () => {
    const message = narrate({
      move,
      motifs: [{ key: "hangs", side: "opponent", victim: "q", square: "h5", moved: true }],
      lines: {},
      aiText: "Ta dame n’a rien à faire là.",
    });
    expect(message.source).toBe("ai");
    expect(message.headline).toBe("Ta dame n’a rien à faire là.");
    // The engine's own finding is still on screen: the model writes the
    // advice, the engine keeps the last word on what happened.
    expect(message.details.map((d) => d.text).join(" ")).toMatch(/la dame/);
  });

  it("falls back to the engine when there is no commentary", () => {
    const message = narrate({
      move,
      motifs: [{ key: "hangs", side: "opponent", victim: "q", square: "h5", moved: true }],
      lines: {},
    });
    expect(message.source).toBe("engine");
    expect(message.headline).toMatch(/la dame/);
  });

  it("ranks the mate above the open file rather than printing them in detector order", () => {
    const message = narrate({
      move: { judgment: null, is_best: false },
      motifs: [
        { key: "rookOpenFile", side: "you", file: "e" },
        { key: "checkmate", side: "you" },
      ],
      lines: {},
    });
    expect(message.headline).toBe("Échec et mat.");
  });
});

/**
 * The limiter exists to cost nothing when there is nothing to protect against.
 * A version that sleeps between every request would pass a "stays under the
 * limit" test and still be wrong, so the first case here is the one about not
 * waiting.
 */
describe("staying under a free tier's requests per minute", () => {
  it("does not wait while the window has room", async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ rpm: 10, ...clock });
    const started = clock.now();
    for (let i = 0; i < 10; i += 1) await limiter.take();
    expect(clock.now()).toBe(started);
  });

  it("waits exactly until the oldest request ages out", async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ rpm: 3, ...clock });
    for (let i = 0; i < 3; i += 1) await limiter.take();

    const before = clock.now();
    await limiter.take();
    // A minute after the first request, plus the margin against a provider
    // clock that is not ours. Not a fixed 60/rpm between every call.
    expect(clock.now() - before).toBe(60_250);
  });

  it("lets a later burst through once the window has emptied on its own", async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ rpm: 2, ...clock });
    await limiter.take();
    await limiter.take();
    clock.advance(61_000);

    const before = clock.now();
    await limiter.take();
    await limiter.take();
    expect(clock.now()).toBe(before);
  });
});

describe("how long to sit out a rejection", () => {
  it("believes Retry-After when the provider sends one", () => {
    expect(retryDelay({ "retry-after": "12" }, 0)).toBe(12_000);
    expect(retryDelay({ "Retry-After": "3" }, 0)).toBe(3000);
  });

  it("backs off geometrically when it does not", () => {
    expect(retryDelay({}, 0)).toBe(2000);
    expect(retryDelay({}, 1)).toBe(4000);
    expect(retryDelay({}, 2)).toBe(8000);
  });

  // A daily quota reports a delay measured in hours. Holding the screen for
  // that is not waiting, it is hanging; the caller fails and says so instead.
  it("caps the wait rather than holding the screen for an hour", () => {
    expect(retryDelay({ "retry-after": "3600" }, 0)).toBe(30_000);
    expect(retryDelay({}, 12)).toBe(30_000);
  });

  it("ignores a header it cannot make sense of", () => {
    expect(retryDelay({ "retry-after": "bientôt" }, 0)).toBe(2000);
  });
});

/**
 * The two facts added to the digest after the first release of the coach, and
 * the reason they were: the model cannot derive either one, and a coach who
 * cannot say "you played that in two seconds" is missing the most useful
 * sentence available to them.
 */
describe("the clock and the structure in the digest", () => {
  // A real Chess.com PGN carries a [%clk] tag per ply and a TimeControl.
  const TIMED = {
    ...GAME,
    time_control: "180+2",
    pgn:
      "1. e4 {[%clk 0:03:00]} e5 {[%clk 0:02:59]} " +
      "2. Qh5 {[%clk 0:02:59.9]} Nc6 {[%clk 0:02:55]} " +
      "3. Bc4 {[%clk 0:02:50]} Nf6 {[%clk 0:02:50]} " +
      "4. Qxf7# {[%clk 0:02:45]} 1-0",
  };

  it("says how long each move took", () => {
    const entries = entriesFor({ game: TIMED, analysis: ANALYSIS });
    // Move 2 left 2:59.9 from a start of 3:00 with a 2s increment, so it took
    // about two seconds of thought after the increment is put back.
    const quick = entries.find((e) => e.ply === 3);
    expect(quick.seconds).toBeGreaterThan(0);
    expect(quick.seconds).toBeLessThan(5);
    expect(formatEntry(quick)).toMatch(/réfléchi [\d.,]+ s/);
  });

  it("survives a game with no clock tags at all", () => {
    const entries = entriesFor({ game: GAME, analysis: ANALYSIS });
    expect(entries.every((e) => e.seconds === null)).toBe(true);
    // And the line is still a line, without an empty "réfléchi" on it.
    expect(formatEntry(entries[0])).not.toMatch(/réfléchi/);
  });

  it("survives a daily game, whose time control is not a clock", () => {
    const daily = { ...TIMED, time_control: "1/259200" };
    expect(() => entriesFor({ game: daily, analysis: ANALYSIS })).not.toThrow();
    expect(entriesFor({ game: daily, analysis: ANALYSIS })[0].seconds).toBe(null);
  });

  it("puts the standing structure at the head of every chunk", () => {
    const [chunk] = buildDigest({ game: GAME, analysis: ANALYSIS });
    // A chunk that starts mid-game must know where the king is; the first one
    // proves the line is written at all.
    expect(chunk.text).toMatch(/État avant le coup 1 :/);
    expect(chunk.text).toContain("roi en e1, non roqué");
  });

  it("reports a structural change once, on the move that caused it", () => {
    // 2. exd5 doubles White's d-pawn.
    const doubling = {
      ...GAME,
      pgn: "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 *",
    };
    const entries = entriesFor({ game: doubling, analysis: { moves: [] } });
    const capture = entries.find((e) => e.san === "exd5");
    const later = entries.find((e) => e.san === "d4");

    expect(structuralChanges(capture, entries[0])).toContain("pions doublés colonne d");
    // And not again on every move afterwards: repeating a fact twenty times is
    // how the coach ends up writing about it twenty times.
    expect(structuralChanges(later, entries[2])).not.toContain("pions doublés colonne d");
  });

  it("notices the king that never castled, once, when it becomes late", () => {
    const stalling = {
      ...GAME,
      pgn:
        "1. a3 e5 2. a4 Nc6 3. h3 Nf6 4. h4 Bc5 5. b3 O-O 6. b4 Bb6 " +
        "7. c3 d6 8. c4 Be6 9. d3 Qd7 10. g3 Rae8 11. g4 h6 12. Ra2 a6 *",
    };
    const entries = entriesFor({ game: stalling, analysis: { moves: [] } });
    const flagged = entries.filter((entry, i) =>
      structuralChanges(entry, i === 0 ? null : entries[i - 1]).some((c) =>
        c.includes("non roqué"),
      ),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].move_number).toBe(10);
  });

  it("names a piece shuffled around the opening, which no position can show", () => {
    const shuffle = { ...GAME, pgn: "1. e4 e5 2. Nf3 Nc6 3. Ng5 h6 4. Nf3 d6 *" };
    const [chunk] = buildDigest({ game: shuffle, analysis: { moves: [] } });
    expect(chunk.text).toContain("pièces déplacées plus d’une fois");
    expect(chunk.text).toContain("cavalier en f3 (3 fois)");
  });

  it("keeps the opening habit out of the chunks that are not the opening", () => {
    const moves = [];
    for (let n = 1; n <= CHUNK_SIZE; n += 1) {
      moves.push(`${2 * n - 1}. Nf3 Nf6`, `${2 * n}. Ng1 Ng8`);
    }
    const chunks = buildDigest({ game: { ...GAME, pgn: `${moves.join(" ")} *` }, analysis: { moves: [] } });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain("pièces déplacées plus d’une fois");
    expect(chunks[1].text).not.toContain("pièces déplacées plus d’une fois");
  });

  it("still hands over no PGN, with all of this on it", () => {
    const [chunk] = buildDigest({ game: TIMED, analysis: ANALYSIS });
    expect(chunk.text).not.toContain(TIMED.pgn);
    expect(chunk.text).not.toMatch(/%clk/);
  });
});

/**
 * A provider retires a model generation by closing it to new keys, and the
 * app finds out as a 400 the user reads as "the coach is broken". Both halves
 * of the defence are here: the request has to match what the provider
 * currently documents, and a name saved before the change has to be dropped
 * rather than sent.
 */
describe("outliving a model generation", () => {
  const settings = (rows) => ({
    getSetting: async (key, fallback) => rows[key] ?? fallback,
    setSetting: async () => {},
  });

  it("asks Gemini over the Interactions API, with the model in the body", () => {
    const { url, data } = PROVIDERS.gemini.request({
      apiKey: "k",
      model: "gemini-3.7-flash",
      system: "s",
      user: "u",
      maxTokens: 100,
    });
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(url).not.toContain("generateContent");
    expect(data.model).toBe("gemini-3.7-flash");
    expect(data.input).toBe("u");
    expect(data.system_instruction).toBe("s");
  });

  it("sends none of the sampling parameters 3.x rejects", () => {
    const { data } = PROVIDERS.gemini.request({ apiKey: "k", model: "m", maxTokens: 10 });
    const sent = JSON.stringify(data);
    for (const dead of ["temperature", "top_p", "topP", "top_k", "topK", "thinking_budget"]) {
      expect(sent).not.toContain(dead);
    }
    expect(data.generation_config.max_output_tokens).toBe(10);
  });

  it("reads the model's step and leaves the thinking behind", () => {
    const text = PROVIDERS.gemini.text({
      steps: [
        { type: "thinking", content: [{ type: "text", text: "not this" }] },
        { type: "model_output", content: [{ type: "text", text: "this" }] },
      ],
    });
    expect(text).toBe("this");
  });

  it("drops a stored model the provider no longer offers", async () => {
    const config = await readCoachConfig(
      settings({ [SETTING_COACH_PROVIDER]: "gemini", [SETTING_COACH_MODEL]: "gemini-2.5-flash" }),
    );
    expect(config.model).toBe(PROVIDERS.gemini.models[0]);
  });

  it("keeps a stored model that is still offered", async () => {
    const chosen = PROVIDERS.gemini.models[1];
    const config = await readCoachConfig(
      settings({ [SETTING_COACH_PROVIDER]: "gemini", [SETTING_COACH_MODEL]: chosen }),
    );
    expect(config.model).toBe(chosen);
  });
});

/**
 * A key per provider, and a provider per failure.
 *
 * The default is a free tier, and a free tier says no: quota, overload, a
 * request that never arrives. One key meant one answer to that - wait, and try
 * the same door again. A second key elsewhere is a second door, and the thing
 * that made it possible is storing keys separately: the settings screen used
 * to drop the key whenever the provider changed.
 */
describe("more than one way to reach a model", () => {
  const store = (rows = {}) => {
    const data = { ...rows };
    return {
      data,
      getSetting: async (key, fallback) => data[key] ?? fallback,
      setSetting: async (key, value) => {
        data[key] = value;
      },
    };
  };

  it("offers every other provider holding a key as a spare", async () => {
    const config = await readCoachConfig(
      store({
        [SETTING_COACH_PROVIDER]: "gemini",
        [keySetting("gemini")]: "g-key",
        [keySetting("anthropic")]: "a-key",
      }),
    );
    expect(config.apiKey).toBe("g-key");
    expect(config.fallbacks).toEqual([
      { provider: "anthropic", model: PROVIDERS.anthropic.models[0], apiKey: "a-key" },
    ]);
  });

  it("offers none when the chain is switched off", async () => {
    const config = await readCoachConfig(
      store({
        [SETTING_COACH_PROVIDER]: "gemini",
        [SETTING_COACH_FALLBACK]: "0",
        [keySetting("gemini")]: "g-key",
        [keySetting("anthropic")]: "a-key",
      }),
    );
    expect(config.fallback).toBe(false);
    expect(config.fallbacks).toEqual([]);
  });

  // The screen has to know which providers it can reach without ever holding a
  // key: a secret that is never read back cannot be read off a screenshot.
  it("tells the screen which keys exist and none of what they are", async () => {
    const config = await publicCoachConfig(
      store({
        [SETTING_COACH_PROVIDER]: "anthropic",
        [keySetting("gemini")]: "g-key",
        [keySetting("anthropic")]: "a-key",
      }),
    );
    expect(config.keys).toEqual({ gemini: true, openrouter: false, anthropic: true });
    expect(config.key_set).toBe(true);
    expect(JSON.stringify(config)).not.toContain("a-key");
  });

  it("keeps the other providers' keys when the provider changes", async () => {
    const repo = store({
      [SETTING_COACH_PROVIDER]: "gemini",
      [keySetting("gemini")]: "g-key",
    });
    await writeCoachConfig(repo, { provider: "anthropic" });
    await writeCoachConfig(repo, { apiKey: "a-key" });

    const config = await readCoachConfig(repo);
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("a-key");
    expect(config.fallbacks.map((f) => f.provider)).toEqual(["gemini"]);
  });

  // The single key row that predates the split belongs to whoever was selected
  // when it was written, and leaving is the last moment that is knowable.
  it("adopts the single key an older version stored", async () => {
    const repo = store({ [SETTING_COACH_PROVIDER]: "gemini", [SETTING_COACH_KEY]: "old-key" });
    expect((await readCoachConfig(repo)).apiKey).toBe("old-key");

    await writeCoachConfig(repo, { provider: "anthropic" });
    expect(repo.data[keySetting("gemini")]).toBe("old-key");
  });

  it("forgets a key for good, including the row an older version wrote", async () => {
    const repo = store({ [SETTING_COACH_PROVIDER]: "gemini", [SETTING_COACH_KEY]: "old-key" });
    await writeCoachConfig(repo, { apiKey: "" });
    expect((await readCoachConfig(repo)).apiKey).toBe("");
  });
});

describe("falling back to another provider", () => {
  const chained = {
    provider: "gemini",
    model: "gemini-3.7-flash",
    apiKey: "g-key",
    fallbacks: [{ provider: "anthropic", model: "claude-haiku-4-5", apiKey: "a-key" }],
  };

  const claudeReply = (comments) => ({
    status: 200,
    data: { content: [{ type: "text", text: JSON.stringify({ comments }) }] },
  });

  it("moves to the next provider once the first has run out of retries", async () => {
    const spares = [];
    const { http, calls } = fakeHttp([
      { status: 503, data: { error: { message: "overloaded" } } },
      { status: 503, data: { error: { message: "overloaded" } } },
      { status: 503, data: { error: { message: "overloaded" } } },
      claudeReply([{ ply: 1, text: "Commenté ailleurs." }]),
    ]);

    const result = await createCoach(http, virtualClock()).commentGame({
      game: GAME,
      analysis: ANALYSIS,
      config: chained,
      onFallback: (label) => spares.push(label),
    });

    expect(calls).toHaveLength(4);
    expect(calls[3].url).toContain("api.anthropic.com");
    expect(calls[3].headers["x-api-key"]).toBe("a-key");
    expect(result.notes[1]).toBe("Commenté ailleurs.");
    expect(result.providers).toEqual(["anthropic"]);
    // Said once on screen: a quota spent somewhere else must not be spent
    // silently.
    expect(spares).toEqual(["Claude"]);
  });

  // A refused key fails the same way on every retry and at every provider, and
  // passing it on would spend a second key's quota to learn nothing.
  it("does not hand a refused key to the next provider", async () => {
    const { http, calls } = fakeHttp([{ status: 401, data: {} }]);
    await expect(
      createCoach(http, virtualClock()).commentGame({
        game: GAME,
        analysis: ANALYSIS,
        config: chained,
      }),
    ).rejects.toThrow(/Clé API refusée/);
    expect(calls).toHaveLength(1);
  });

  it("keeps the same digest whichever provider answers", async () => {
    const { http, calls } = fakeHttp([
      { status: 503, data: {} },
      { status: 503, data: {} },
      { status: 503, data: {} },
      claudeReply([{ ply: 1, text: "ok" }]),
    ]);
    await createCoach(http, virtualClock()).commentGame({
      game: GAME,
      analysis: ANALYSIS,
      config: chained,
    });

    expect(JSON.stringify(calls[3].data)).not.toContain(GAME.pgn);
    expect(calls[3].data.messages[0].content).toBe(calls[0].data.input);
  });

  it("says every provider refused rather than naming only the last", async () => {
    const { http } = fakeHttp([{ status: 503, data: { error: { message: "overloaded" } } }]);
    await expect(
      createCoach(http, virtualClock()).commentGame({
        game: GAME,
        analysis: ANALYSIS,
        config: chained,
      }),
    ).rejects.toThrow(/surchargé/);
  });
});

describe("asking Claude", () => {
  it("sends the shape the Messages API documents", () => {
    const { url, headers, data } = PROVIDERS.anthropic.request({
      apiKey: "k",
      model: "claude-opus-5",
      system: "s",
      user: "u",
      maxTokens: 8000,
    });
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBe("k");
    expect(data).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    // Stockfish did the analysis; what is left is writing it down in French.
    expect(data.output_config).toEqual({ effort: "low" });
  });

  // `output_config.effort` is rejected outright by Haiku 4.5, and sending it
  // would break the cheapest model on the list for whoever picks it.
  it("leaves the effort off the model that refuses it", () => {
    const { data } = PROVIDERS.anthropic.request({
      apiKey: "k",
      model: "claude-haiku-4-5",
      maxTokens: 8000,
    });
    expect(data.output_config).toBe(undefined);
  });

  it("reads the text blocks and leaves the thinking behind", () => {
    const text = PROVIDERS.anthropic.text({
      content: [
        { type: "thinking", thinking: "pas ça" },
        { type: "text", text: '{"comments":[]}' },
      ],
    });
    expect(text).toBe('{"comments":[]}');
  });
});

/**
 * What a commented game costs.
 *
 * "$25 per million output tokens" is not a number anyone can decide on. This
 * one is - and the tests pin the arithmetic rather than the constants, because
 * the measured sizes will drift and a test asserting a price in dollars would
 * then fail for the wrong reason.
 */
describe("what a paid coach costs", () => {
  it("splits a game into the requests the digest actually makes", () => {
    expect(tokensForGame({ moves: 12 }).requests).toBe(1);
    expect(tokensForGame({ moves: CHUNK_SIZE + 1 }).requests).toBe(2);
  });

  it("charges thinking to the output, where it is billed", () => {
    const quiet = tokensForGame({ thinks: false });
    const thinking = tokensForGame({ thinks: true });
    expect(thinking.output).toBeGreaterThan(quiet.output);
    expect(thinking.input).toBe(quiet.input);
  });

  it("prices a game in cents, and ranks the models the way the rates do", () => {
    const opus = costPerGame("anthropic", "claude-opus-5");
    const haiku = costPerGame("anthropic", "claude-haiku-4-5");
    expect(opus).toBeGreaterThan(haiku);
    expect(opus).toBeLessThan(1);
    expect(haiku).toBeGreaterThan(0);
  });

  // Zero would read as "this costs nothing", and on a free tier the quota is
  // the limit that actually bites.
  it("says nothing rather than zero for a free tier", () => {
    expect(costPerGame("gemini", "gemini-3.7-flash")).toBe(null);
    expect(formatCost(null)).toBe(null);
  });

  it("keeps enough digits for the models to stay apart", () => {
    expect(formatCost(costPerGame("anthropic", "claude-haiku-4-5"))).not.toBe(
      formatCost(costPerGame("anthropic", "claude-sonnet-5")),
    );
  });
});
