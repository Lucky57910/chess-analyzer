/**
 * @vitest-environment jsdom
 *
 * The screens render, with the data layer faked at the api module.
 *
 * P4 rewired the shell, both providers, the navigation and two pages without
 * any of it ever running: there is no Android SDK on the development machine
 * and the native plugins do not exist in a browser. So nothing here had been
 * executed even once. These tests are the first thing that does.
 *
 * They are deliberately shallow. They do not check layout or wording - they
 * check that a page mounts, asks the api for what it needs, and puts the
 * answer on screen, which is exactly the class of mistake a large mechanical
 * rewiring produces: a provider that was never wrapped, a field renamed on one
 * side of a boundary, a null nobody guarded.
 */

import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Testing Library gives a `findBy` one second by default. Every test in this
// file renders a whole page through lazy routes, two providers and a fake
// database, and the analysis page runs real chess.js geometry - mate
// detection walks every legal move - on every ply it is stepped through. On a
// loaded machine (CI, or a full local run with fifteen files in parallel) that
// crosses a second while nothing at all is wrong, and the failures it produced
// were timing rather than behaviour: the same tests passed in isolation.
//
// Fifteen seconds is not a real wait, and it sits under the 20 s vitest gives
// the test itself - the two clocks have to stay in that order or the outer one
// fires first and reports a timeout for the wrong reason. Nothing here is
// expected to take even one second; the number only has to be far enough above
// the noise that a red run means something is broken.
configure({ asyncUtilTimeout: 15_000 });

vi.mock("../utils/api", () => {
  const api = {
    settings: vi.fn(async () => ({
      chess_com_username: "maxime",
      last_synced_at: "2026-08-26T10:00:00.000Z",
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: false,
        fallback: true,
        keys: { gemini: false, openrouter: false, anthropic: false },
      },
    })),
    updateSettings: vi.fn(async (patch) => ({
      chess_com_username: patch.chess_com_username?.trim() ?? "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: patch.coach?.provider ?? "gemini",
        model: patch.coach?.model ?? "gemini-3.7-flash",
        key_set: patch.coach?.apiKey ? true : false,
        fallback: patch.coach?.fallback ?? true,
        keys: {
          gemini: false,
          openrouter: false,
          anthropic: false,
          [patch.coach?.provider ?? "gemini"]: Boolean(patch.coach?.apiKey),
        },
      },
    })),
    // No foreground service in a browser, which is the case every test here
    // renders: the in-app loop is still the whole feature without one.
    coachRunner: vi.fn(async () => ({ available: false })),
    coachGameBackground: vi.fn(async () => ({ started: true, jobId: "job-1", chunks: 2 })),
    requestCoachNotifications: vi.fn(async () => ({ notifications: "granted" })),
    collectCoachResults: vi.fn(async () => ({ games: [] })),
    coachGame: vi.fn(async () => ({
      notes: { 3: "Ta dame sort trop tôt : elle sera chassée avec gain de temps." },
      added: 1,
      failed: 0,
    })),
    // The archive-wide review. Null by default: the statistics screen must
    // stand up before the coach has ever been asked for one.
    latestReview: vi.fn(async () => null),
    reviews: vi.fn(async () => []),
    coachReview: vi.fn(async () => ({
      id: 1,
      created_at: new Date().toISOString(),
      game_kind: "rated",
      window_days: null,
      games: 42,
      provider: "gemini",
      findings: [
        {
          title: "Tu sors la dame trop tôt",
          detail: "Tes coups de dame coûtent 61 centipions en moyenne.",
          drill: "Dix parties sans sortir la dame avant le coup 10.",
          evidence: ["piece.Q"],
        },
      ],
      facts: [{ key: "piece.Q", text: "coups de dame : 812 coups, 61 centipions perdus" }],
    })),
    games: vi.fn(async () => [
      {
        id: 1,
        user_color: "white",
        result: "win",
        opponent_username: "rival",
        opponent_rating: 1380,
        opening: "Sicilian Defense",
        time_class: "blitz",
        played_at: "2026-08-24T02:26:40.000Z",
        analysis_status: "done",
        accuracy: 88.1,
        chess_com_accuracy: 87.3,
        mistakes: 1,
        blunders: 0,
      },
    ]),
    // 342 games behind a 25-row window, so "load more" has somewhere to go.
    gamesPage: vi.fn(async ({ limit = 25 } = {}) => ({
      games: Array.from({ length: Math.min(limit, 342) }, (_, i) => ({
        id: i + 1,
        user_color: i % 2 ? "black" : "white",
        result: "win",
        opponent_username: i === 0 ? "rival" : `joueur${i}`,
        opponent_rating: 1380,
        opening: "Sicilian Defense",
        time_class: "blitz",
        played_at: "2026-08-24T02:26:40.000Z",
        analysis_status: "done",
        accuracy: 88.1,
        chess_com_accuracy: 87.3,
        mistakes: 1,
        blunders: 0,
      })),
      total: 342,
    })),
    stats: vi.fn(async () => ({
      games: 12,
      analysed: 9,
      wins: 6,
      losses: 4,
      draws: 2,
      win_rate: 58.3,
      avg_accuracy: 81.4,
      avg_acpl: 42.7,
      blunders_per_game: 0.44,
      mistakes_per_game: 1.2,
      inaccuracies_per_game: 2.1,
      weakest_phase: "middlegame",
      by_time_class: [],
      by_color: [],
      top_opponents: [],
      top_openings: [],
      phase_acpl: { middlegame: 60.2 },
    })),
    syncStatus: vi.fn(async () => ({
      pending: 3,
      running: 0,
      done: 9,
      error: 0,
      stale: 0,
      total: 12,
    })),
    sync: vi.fn(async () => ({ imported: 0, updated: 0, skipped: 0, pending_analysis: 3 })),
    refresh: vi.fn(async () => ({ status: "pending" })),
    reclaimStuck: vi.fn(async () => ({ requeued: 0, retired: 0 })),
    // Answers like the UCI driver: White's point of view, plus the move it
    // would play. The reply is always the first legal move, which is enough
    // for the board to move and keeps the fixture from needing a real search.
    evaluate: vi.fn(async () => ({ cp: 15, mate: null, best_uci: "e7e5", depth: 12 })),
    health: vi.fn(async () => ({
      engine: { available: true, name: "Stockfish 17.1", path: "/x" },
      engine_depth: 18,
      cpu_abi: "arm64-v8a",
    })),
    trends: vi.fn(async () => [
      { period: "2026-W33", games: 4, win_rate: 50, avg_accuracy: 79.2, avg_acpl: 48 },
      { period: "2026-W34", games: 6, win_rate: 66.7, avg_accuracy: 83.1, avg_acpl: 39 },
    ]),
    judgmentTrends: vi.fn(async () => [
      {
        period: "2026-W33",
        games: 4,
        analysed: 4,
        moves: 120,
        blunders: 5,
        mistakes: 7,
        inaccuracies: 9,
        blunders_per_game: 1.25,
        mistakes_per_game: 1.75,
        inaccuracies_per_game: 2.25,
        blunders_per_100: 4.17,
        mistakes_per_100: 5.83,
        inaccuracies_per_100: 7.5,
      },
      {
        period: "2026-W34",
        games: 6,
        analysed: 6,
        moves: 200,
        blunders: 3,
        mistakes: 6,
        inaccuracies: 11,
        blunders_per_game: 0.5,
        mistakes_per_game: 1,
        inaccuracies_per_game: 1.83,
        blunders_per_100: 1.5,
        mistakes_per_100: 3,
        inaccuracies_per_100: 5.5,
      },
    ]),
    // The smoothed series carries both halves of the two time charts under the
    // same field names as `trends` and `judgmentTrends`, plus the raw dailies.
    smoothedTrends: vi.fn(async () =>
      ["2026-08-20", "2026-08-21", "2026-08-22"].map((period, i) => ({
        period,
        games: i + 1,
        analysed: i + 1,
        window_games: 6,
        blunders: 4 - i,
        mistakes: 3,
        inaccuracies: 5,
        raw_win_rate: i === 1 ? 0 : 100,
        raw_avg_accuracy: i === 1 ? 55 : 90,
        raw_blunders_per_game: 4 - i,
        win_rate: 60 + i,
        avg_accuracy: 80 + i,
        avg_acpl: 40 - i,
        blunders_per_game: 1.2 - i * 0.1,
        mistakes_per_game: 1.5,
        inaccuracies_per_game: 2,
        blunders_per_100: 4 - i * 0.5,
        mistakes_per_100: 5,
        inaccuracies_per_100: 7,
      })),
    ),
    mistakes: vi.fn(async () => ({
      worst_moves: [],
      by_move_number: [
        { move_number: 7, count: 2 },
        { move_number: 23, count: 5 },
      ],
    })),
    insights: vi.fn(async () => ({
      by_rating_gap: [
        { key: "even", name: "Équivalent (−50 à +50)", games: 8, win_rate: 50, avg_accuracy: 80 },
      ],
      // Ranked worst-first, as the statistics screen wants them. The home
      // screen wants the most recent instead, so the biggest one here is
      // deliberately the older: taking the head of this list is wrong there
      // and a single entry would never say so.
      costly_mistakes: [
        {
          game_id: 4,
          played_at: "2026-08-02T12:00:00.000Z",
          opponent: "ancien",
          move_number: 9,
          ply: 17,
          san: "Qa4",
          best_move_san: "Nc3",
          cp_loss: 480,
          judgment: "blunder",
          phase: "opening",
          eval_cp_before: 10,
        },
        {
          game_id: 1,
          played_at: "2026-08-24T02:26:40.000Z",
          opponent: "rival",
          move_number: 14,
          ply: 27,
          san: "Nd5",
          best_move_san: "Bd2",
          cp_loss: 260,
          judgment: "mistake",
          phase: "middlegame",
          eval_cp_before: 20,
        },
      ],
      conversion: {
        winning_positions: 6,
        converted: 4,
        conversion_rate: 66.7,
        losing_positions: 5,
        saved: 1,
        save_rate: 20,
      },
      by_piece: [{ piece: "Q", name: "Dame", moves: 40, avg_cp_loss: 61.2, blunders: 3 }],
      opening_exit: [{ name: "Sicilian Defense", games: 4, moves: 40, acpl: 22.5, win_rate: 50 }],
      session_tilt: [
        { rank: 1, name: "1ʳᵉ", games: 6, win_rate: 66.7, avg_accuracy: 84, blunders_per_game: 0.5 },
      ],
      clock: {
        games: 9,
        moves: 300,
        blunders: 8,
        median_seconds: 6.4,
        fast_blunders: 6,
        fast_blunder_share: 75,
        buckets: [
          { key: "instant", name: "moins de 5 s", moves: 120, blunders: 5, blunder_rate: 4.2 },
          { key: "slow", name: "plus de 30 s", moves: 40, blunders: 0, blunder_rate: 0 },
        ],
      },
      opponent_strength: {
        games: 9,
        avg_opponent_rating: 1240,
        avg_user_rating: 1200,
        avg_gap: 40,
        by_result: {
          win: { games: 5, avg_opponent_rating: 1180, avg_user_rating: 1200, avg_gap: -20 },
          draw: { games: 0, avg_opponent_rating: null, avg_user_rating: null, avg_gap: null },
          loss: { games: 4, avg_opponent_rating: 1310, avg_user_rating: 1200, avg_gap: 110 },
        },
        win_loss_gap: 130,
      },
      comparison: {
        days: 30,
        baseline: "previous",
        current: { games: 10, win_rate: 60, avg_accuracy: 82, blunders_per_game: 0.6 },
        previous: { games: 8, win_rate: 50, avg_accuracy: 78, blunders_per_game: 1.1 },
        deltas: { win_rate: 10, avg_accuracy: 4, blunders_per_game: -0.5, avg_acpl: -3 },
      },
    })),
    game: vi.fn(async () => ({
      id: 1,
      user_color: "white",
      result: "win",
      opponent_username: "rival",
      opponent_rating: 1380,
      opening: "King's Pawn",
      time_class: "blitz",
      played_at: "2026-08-24T02:26:40.000Z",
      termination: null,
      url: null,
      analysis_status: "done",
      pgn: '[Event "x"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 *',
      accuracy: 88.1,
      chess_com_accuracy: null,
    })),
    analysis: vi.fn(async () => ({
      coach: {},
      accuracy_white: 88.1,
      accuracy_black: 71.4,
      acpl_white: 22,
      acpl_black: 61,
      judgment_counts: { white: { inaccuracy: 1 }, black: { blunder: 1 } },
      phase_stats: { white: { opening: { acpl: 22 } }, black: { opening: { acpl: 61 } } },
      // Ply 1 has an engine move to peek at; ply 2 does not, which is what
      // makes the button's disabled state meaningful in the test below.
      moves: [
        {
          ply: 1,
          move_number: 1,
          color: "white",
          san: "e4",
          uci: "e2e4",
          eval_cp: 30,
          eval_mate: null,
          best_move_san: "d4",
          best_move_uci: "d2d4",
          is_best: false,
          cp_loss: 12,
          judgment: null,
          phase: "opening",
        },
        // A judged move carrying what the driver now keeps: the line the
        // engine wanted, and the line that punishes what was played.
        {
          ply: 3,
          move_number: 2,
          color: "white",
          san: "Qh5",
          uci: "d1h5",
          eval_cp: -300,
          eval_mate: null,
          best_move_san: "Nf3",
          best_move_uci: "g1f3",
          is_best: false,
          cp_loss: 330,
          judgment: "blunder",
          phase: "opening",
          best_line: ["g1f3", "b8c6"],
          reply_line: ["b8c6", "g1f3"],
        },
        {
          ply: 2,
          move_number: 1,
          color: "black",
          san: "e5",
          uci: "e7e5",
          eval_cp: 25,
          eval_mate: null,
          best_move_san: "e5",
          best_move_uci: "e7e5",
          is_best: true,
          cp_loss: 0,
          judgment: null,
          phase: "opening",
        },
      ],
    })),
  };
  // One sync object, not a fresh one per call: the test asserts on the same
  // `runQueue` the provider actually invoked. Rebuilding it here made that
  // assertion vacuous.
  const sync = { runQueue: vi.fn(async () => 0) };
  return {
    api,
    ApiError: class ApiError extends Error {},
    getApi: vi.fn(async () => ({ api, sync })),
  };
});

const { api, getApi } = await import("../utils/api");
const { default: App } = await import("../App.jsx");
const { QueueProvider } = await import("../hooks/useQueue.jsx");
const { SettingsProvider } = await import("../hooks/useSettings.jsx");

// jsdom ships no matchMedia, and the analysis screen asks one whether it is on
// a desktop before deciding to draw the eval curve. Answering "no" keeps these
// tests on the phone layout, which is the one that matters here.
window.matchMedia ??= (query) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

function renderApp(route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <QueueProvider>
          <App />
        </QueueProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

// `clearAllMocks` wipes the recorded calls but keeps whatever implementation a
// test installed, so one `mockResolvedValue` would quietly follow the suite
// around. Anything a test overrides has to be put back here.
const DEFAULTS = new Map(
  ["gamesPage", "settings", "health", "insights", "game", "evaluate", "coachRunner"].map((name) => [
    name,
    api[name].getMockImplementation(),
  ]),
);

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, implementation] of DEFAULTS) api[name].mockImplementation(implementation);
});

// Testing Library only registers its own cleanup when vitest globals are on,
// and they are not. Without this every render stacks in the same document and
// the queries start finding the previous test's markup.
afterEach(cleanup);

describe("the dashboard", () => {
  it("shows the games it was given", async () => {
    renderApp("/games");
    expect(await screen.findByText("rival")).toBeDefined();
    expect(api.gamesPage).toHaveBeenCalled();
  });

  // The list used to stop at 25 rows with nothing saying there were more.
  it("says how much of the archive is on screen", async () => {
    renderApp("/games");
    expect(await screen.findByText("25 sur 342 parties")).toBeDefined();
  });

  it("widens the window instead of stitching pages together", async () => {
    renderApp("/games");
    const more = await screen.findByRole("button", { name: /Charger 25 de plus/ });
    fireEvent.click(more);

    // One query for the whole visible list, not an offset page appended to a
    // snapshot taken before the last analysis landed.
    await waitFor(() =>
      expect(api.gamesPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 })),
    );
    expect(await screen.findByText("50 sur 342 parties")).toBeDefined();
  });

  it("stops offering more once the whole set is shown", async () => {
    api.gamesPage.mockResolvedValue({
      games: [
        {
          id: 1,
          user_color: "white",
          result: "win",
          opponent_username: "rival",
          played_at: "2026-08-24T02:26:40.000Z",
          analysis_status: "done",
          accuracy: 88.1,
        },
      ],
      total: 1,
    });
    renderApp("/games");
    expect(await screen.findByText("1 sur 1 partie")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Charger/ })).toBe(null);
  });

  it("filters the query and goes back to the first window", async () => {
    renderApp("/games");
    fireEvent.click(await screen.findByRole("button", { name: /Charger 25 de plus/ }));
    expect(await screen.findByText("50 sur 342 parties")).toBeDefined();

    // The dropdowns are folded away until asked for: five permanent selects
    // above an unfiltered list is most of a phone screen.
    fireEvent.click(screen.getByRole("button", { name: /^Filtres/ }));
    fireEvent.change(screen.getByLabelText("Résultat"), { target: { value: "loss" } });

    await waitFor(() =>
      expect(api.gamesPage).toHaveBeenCalledWith(
        expect.objectContaining({ result: "loss", limit: 25 }),
      ),
    );
  });

  // The keystrokes are deliberately spaced by less than the debounce and more
  // than nothing: typed in the same tick they would collapse on their own, and
  // the test would pass against a version that has no debounce at all.
  it("searches on the opponent once the user stops typing", async () => {
    renderApp("/games");
    await screen.findByText("rival");
    const box = screen.getByPlaceholderText(/Chercher un adversaire/);

    fireEvent.change(box, { target: { value: "riv" } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    fireEvent.change(box, { target: { value: "rival" } });

    await waitFor(() =>
      expect(api.gamesPage).toHaveBeenCalledWith(expect.objectContaining({ search: "rival" })),
    );
    // The half-typed name never reached the database.
    expect(api.gamesPage).not.toHaveBeenCalledWith(expect.objectContaining({ search: "riv" }));
  });

  it("shows the summary numbers", async () => {
    renderApp("/games");
    await waitFor(() => expect(api.stats).toHaveBeenCalled());
    expect(await screen.findByText(/58[.,]3/)).toBeDefined();
  });

  // The queue costs battery and only runs in the foreground, so it must not
  // start itself the moment the app opens.
  it("offers the queue rather than starting it", async () => {
    renderApp("/games");
    const button = await screen.findByRole("button", { name: /Analyser/ });
    expect(button).toBeDefined();
    const { sync } = await getApi();
    expect(sync.runQueue).not.toHaveBeenCalled();
  });
});

describe("the home screen", () => {
  // The logo used to be a dead <span>. It is the way back to the overview now,
  // which is the whole reason this screen exists.
  it("is where the title in the bar leads", async () => {
    renderApp("/games");
    expect(await screen.findByText("25 sur 342 parties")).toBeDefined();

    fireEvent.click(screen.getByRole("link", { name: /Chess Analyzer/ }));
    expect(await screen.findByText("Vue d’ensemble")).toBeDefined();
  });

  it("leads the headline numbers with the last thirty days", async () => {
    renderApp("/");
    expect(await screen.findByText(/30 derniers jours · 10 parties classées/)).toBeDefined();
    // 60 % over 10 games, from the comparison rather than from all of history.
    expect(await screen.findByText("60%")).toBeDefined();
    expect(await screen.findByText(/▲ 10 pts/)).toBeDefined();
  });

  // The queue only runs in the foreground and does not start itself, so the
  // one thing this screen exists to prompt is starting it.
  it("offers the analysis queue rather than starting it", async () => {
    renderApp("/");
    const button = await screen.findByRole("button", { name: "Analyser" });
    const { sync } = await getApi();
    expect(sync.runQueue).not.toHaveBeenCalled();
    expect(button).toBeDefined();
    expect(await screen.findByText(/3 parties en attente/)).toBeDefined();
  });

  it("names the weakness in one sentence and links to the detail", async () => {
    renderApp("/");
    // Weakest phase from the 30-day summary, worst move number from the
    // histogram: move 23 has 5 mistakes against move 7's 2.
    expect(await screen.findByText(/coup 23/)).toBeDefined();
  });

  // A -480 from three weeks ago is a bigger number and a worse lesson: the
  // habit worth catching is the one from last night.
  it("offers the most recent mistake worth replaying, not the biggest", async () => {
    renderApp("/");
    expect(await screen.findByText(/il fallait jouer Bd2/)).toBeDefined();
    expect(screen.queryByText(/il fallait jouer Nc3/)).toBe(null);
    // And it opens the game that mistake was played in, not the other one.
    const card = screen.getByRole("link", { name: /La dernière erreur à rejouer/ });
    expect(card.getAttribute("href")).toBe("/games/1");
  });

  it("shows only the last few games, with a way to the rest", async () => {
    renderApp("/");
    await screen.findByText("Vue d’ensemble");
    expect(api.gamesPage).toHaveBeenCalledWith({ limit: 3 });
    expect(screen.getByRole("link", { name: "Tout l’historique" })).toBeDefined();
  });

  // The window and the baseline are the two settings the tiles depend on, and
  // both have to reach the data layer: a control that changes nothing but its
  // own highlight is worse than no control.
  it("asks again when the window changes", async () => {
    renderApp("/");
    await screen.findByText("Vue d’ensemble");

    fireEvent.click(screen.getByRole("button", { name: "30 jours" }));
    await waitFor(() =>
      expect(api.insights).toHaveBeenCalledWith({
        kind: "rated",
        comparison: { days: 30, baseline: "previous" },
      }),
    );
  });

  it("asks again when the comparison moves to the whole archive", async () => {
    renderApp("/");
    await screen.findByText("Vue d’ensemble");

    fireEvent.click(screen.getByRole("button", { name: "Historique" }));
    await waitFor(() =>
      expect(api.insights).toHaveBeenCalledWith({
        kind: "rated",
        comparison: { days: 7, baseline: "all" },
      }),
    );
  });

  it("says what the arrows are measured against", async () => {
    renderApp("/");
    expect(
      await screen.findByText(/Les flèches comparent ces 30 jours aux 30 précédents/),
    ).toBeDefined();
  });

  it("reads rated games only, like every other statistic", async () => {
    renderApp("/");
    await waitFor(() =>
      expect(api.insights).toHaveBeenCalledWith({
        kind: "rated",
        comparison: { days: 7, baseline: "previous" },
      }),
    );
    expect(api.mistakes).toHaveBeenCalledWith("rated");
    expect(api.smoothedTrends).toHaveBeenCalledWith(3, 30, "rated");
  });
});

describe("without a Chess.com username", () => {
  it("sends the user to the settings instead of an empty list", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "",
      last_synced_at: null,
      engine_depth: 18,
    });
    renderApp("/");
    expect(await screen.findByText(/Reliez votre compte Chess\.com/)).toBeDefined();
  });
});

describe("the settings page", () => {
  it("shows the engine the plugin reported", async () => {
    renderApp("/settings");
    expect(await screen.findByText(/Stockfish 17\.1/)).toBeDefined();
  });

  it("says so when the engine is missing rather than looking healthy", async () => {
    api.health.mockResolvedValueOnce({
      engine: { available: false, error: "Stockfish binary missing at /nope" },
      engine_depth: 18,
    });
    renderApp("/settings");
    expect(await screen.findByText(/Stockfish indisponible/)).toBeDefined();
  });

  it("pre-fills the stored username", async () => {
    renderApp("/settings");
    await waitFor(() => expect(api.settings).toHaveBeenCalled());
    const input = await screen.findByPlaceholderText("pseudo Chess.com");
    expect(input.value).toBe("maxime");
  });
});

describe("when the database will not open", () => {
  // The first native thing the app does is open SQLite. A blank screen here
  // reads as a slow load; the user needs to be told.
  it("explains instead of showing an empty shell", async () => {
    api.settings.mockRejectedValueOnce(new Error("no such table: settings"));
    renderApp("/");
    expect(await screen.findByText(/Base de données inaccessible/)).toBeDefined();
    expect(await screen.findByText(/no such table/)).toBeDefined();
  });
});

describe("navigation", () => {
  it("shows the queue depth so it is visible from every screen", async () => {
    renderApp("/");
    expect(await screen.findByText(/3 en attente/)).toBeDefined();
  });
});

describe("the stats page", () => {
  // 16 buckets was one number for three granularities: four months by week,
  // barely two weeks by day - which is the window the daily view exists to
  // widen. The count has to follow the granularity.
  // By week there are not enough weeks to read anything, and by day a single
  // afternoon swings the line end to end, so the smoothed daily view opens.
  it("opens on the smoothed daily view", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.smoothedTrends).toHaveBeenCalledWith(3, 60, "rated"));
    expect(api.trends).not.toHaveBeenCalled();
    expect(api.judgmentTrends).not.toHaveBeenCalled();
    expect(await screen.findByText(/la semaine autour d’elle/)).toBeDefined();
  });

  it("asks for a window that matches the granularity", async () => {
    renderApp("/stats");
    fireEvent.click(await screen.findByRole("button", { name: "Semaine" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("week", 26, "rated"));

    fireEvent.click(await screen.findByRole("button", { name: "Jour" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("day", 60, "rated"));

    fireEvent.click(await screen.findByRole("button", { name: "Mois" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("month", 24, "rated"));
  });

  // Both time series read the same granularity, so the selector drives both.
  it("moves the judgment series with the granularity too", async () => {
    renderApp("/stats");
    fireEvent.click(await screen.findByRole("button", { name: "Semaine" }));
    await waitFor(() => expect(api.judgmentTrends).toHaveBeenCalledWith("week", 26, "rated"));

    fireEvent.click(await screen.findByRole("button", { name: "Jour" }));
    await waitFor(() => expect(api.judgmentTrends).toHaveBeenCalledWith("day", 60, "rated"));
  });

  // One pass over the archive builds both halves, so the smoothed view must
  // not also go through the two unsmoothed series.
  it("builds the smoothed view from a single pass", async () => {
    renderApp("/stats");
    fireEvent.click(await screen.findByRole("button", { name: "Semaine" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "Jour lissé" }));
    await waitFor(() => expect(api.smoothedTrends).toHaveBeenCalledTimes(2));
    expect(api.trends).toHaveBeenCalledTimes(1);
    expect(api.judgmentTrends).toHaveBeenCalledTimes(1);
  });

  // Neither of these depends on the granularity. Re-deriving them on every
  // click means two more full passes over the archive for identical numbers.
  it("does not rebuild the period-independent stats when the granularity changes", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.stats).toHaveBeenCalledTimes(1));
    expect(api.mistakes).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Jour" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("day", 60, "rated"));

    expect(api.stats).toHaveBeenCalledTimes(1);
    expect(api.mistakes).toHaveBeenCalledTimes(1);
  });

  // Frequent opponents counted one or two games per name in a pool that pairs
  // at random, then printed a win rate over them.
  it("has replaced the frequent-opponents table with the rating gap", async () => {
    renderApp("/stats");
    expect(await screen.findByText("Par écart de classement")).toBeDefined();
    expect(screen.queryByText("Adversaires fréquents")).toBe(null);
  });

  it("ranks the mistakes that were played from a live position", async () => {
    renderApp("/stats");
    expect(await screen.findByText("Les coups qui vous ont coûté la partie")).toBeDefined();
    expect(await screen.findByText("Nd5")).toBeDefined();
    expect(screen.queryByText("Vos pires coups")).toBe(null);
  });

  it("shows the clock panel when the games carry clocks", async () => {
    renderApp("/stats");
    expect(await screen.findByText("Le temps et les gaffes")).toBeDefined();
    expect(await screen.findByText("75%")).toBeDefined();
  });

  // A table of zeroes would claim every move was instant, which is worse than
  // saying nothing.
  it("leaves the clock panel out entirely when no game carries one", async () => {
    const base = await api.insights();
    api.insights.mockResolvedValue({ ...base, clock: null });
    renderApp("/stats");
    expect(await screen.findByText("Par écart de classement")).toBeDefined();
    expect(screen.queryByText("Le temps et les gaffes")).toBe(null);
  });

  it("puts the headline numbers against the previous window", async () => {
    renderApp("/stats");
    expect(await screen.findByText(/comparent les 30 derniers jours/)).toBeDefined();
    // Fewer blunders is progress, so that arrow points down and reads as good;
    // more accuracy is progress, so that one points up and reads the same way.
    const fewerBlunders = await screen.findByText(/▼ 0\.5/);
    expect(fewerBlunders.className).toContain("text-good");
    const moreAccuracy = await screen.findByText(/▲ 4 pts/);
    expect(moreAccuracy.className).toContain("text-good");
  });

  // A game the user could take moves back in is not a measurement of how they
  // play. Counting it in quietly flatters every number on the screen, so the
  // rated view is the one that opens.
  it("opens on rated games and asks every statistic for the same kind", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.stats).toHaveBeenCalledWith(undefined, "rated"));
    expect(api.mistakes).toHaveBeenCalledWith("rated");
    expect(api.insights).toHaveBeenCalledWith({ kind: "rated" });
    expect(await screen.findByText(/celles où le résultat comptait/)).toBeDefined();
  });

  it("carries a change of kind into every statistic at once", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.stats).toHaveBeenCalledWith(undefined, "rated"));

    fireEvent.click(await screen.findByRole("button", { name: "Entraînement" }));

    await waitFor(() => expect(api.stats).toHaveBeenCalledWith(undefined, "training"));
    expect(api.mistakes).toHaveBeenCalledWith("training");
    expect(api.insights).toHaveBeenCalledWith({ kind: "training" });
    await waitFor(() =>
      expect(api.smoothedTrends).toHaveBeenCalledWith(3, 60, "training"),
    );
  });

  it("counts blunders per game or per hundred moves, on demand", async () => {
    renderApp("/stats");
    fireEvent.click(await screen.findByRole("button", { name: "Semaine" }));
    // 5 + 3 blunders over 4 + 6 analysed games in the mocked window.
    expect(await screen.findByText(/8 gaffes sur 10 parties analysées/)).toBeDefined();
    expect(await screen.findByRole("button", { name: "Par partie" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Pour 100 coups" })).toBeDefined();
  });

  // Score and accuracy are unrelated numbers shown side by side in the same
  // percent format. Without the glossary the page never says which is which.
  it("defines score, accuracy and the centipawn", async () => {
    renderApp("/stats");
    expect(await screen.findByText(/victoires \+ ½ nulles/)).toBeDefined();
    expect(await screen.findByText(/Précision = qualité de vos coups/)).toBeDefined();
    expect(await screen.findByText(/unité d’évaluation du moteur/)).toBeDefined();
    // Read off the thresholds, so a change to them cannot leave the glossary
    // quietly describing the old ones.
    expect(await screen.findByText(/à partir de 300 cp/)).toBeDefined();
  });
});

describe("saying what a move did", () => {
  // The judgment already says a move was bad. This says what about it was,
  // which is the part that transfers to the next game.
  it("names the motif under the board", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({
      ...base,
      pgn: "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0",
    });
    renderApp("/games/1");
    await screen.findByRole("button", { name: /meilleur coup/ });

    for (let i = 0; i < 7; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("Échec et mat.")).toBeDefined();
  });

  // It is geometry over the PGN, not a stored field, so it works on a game
  // analysed long before any of this existed.
  it("needs no analysis to say it", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({
      ...base,
      analysis_status: "pending",
      pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O *",
    });
    renderApp("/games/1");
    await screen.findByRole("button", { name: /Ré-analyser/ });

    for (let i = 0; i < 7; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText(/Roque/)).toBeDefined();
    // And it does not claim the rooks are connected: after castling here the
    // queen still stands on d1, between them. Being right about the easy half
    // and wrong about the other one is exactly what makes an annotation worse
    // than none.
    expect(screen.queryByText(/lie les tours/)).toBe(null);
  });

  it("says nothing rather than something vague on a quiet move", async () => {
    renderApp("/games/1");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.queryByText(/Roque/)).toBe(null));
    expect(screen.queryByText(/fourchette/)).toBe(null);
  });
});

describe("explaining a move with the engine's own line", () => {
  // A piece is not lost on the move that hangs it, it is lost two plies later.
  // That half needs the variation, which the driver now keeps.
  it("replays what the opponent does next", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({ ...base, pgn: "1. e4 e5 2. Qh5 Nc6 *" });
    renderApp("/games/1");
    await screen.findByRole("button", { name: /meilleur coup/ });

    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText(/L’adversaire enchaîne/)).toBeDefined();
    expect(await screen.findByText(/Il fallait jouer/)).toBeDefined();
    // The moves inside both sentences are buttons, not text: this is the line
    // the reader can walk rather than replay in their head. Scoped to the
    // bubble, because the move list beside the board carries the same names.
    const bubble = within(screen.getByLabelText("Commentaire du coach"));
    expect(bubble.getAllByRole("button", { name: "Nc6" }).length).toBe(2);
    expect(bubble.getAllByRole("button", { name: "Nf3" }).length).toBe(2);
  });

  // A line the reader can only read is a line they have to play in their head
  // against a board showing something else, which is the skill they came here
  // without.
  it("walks the line on the board, saying what each move does", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({ ...base, pgn: "1. e4 e5 2. Qh5 Nc6 *" });
    renderApp("/games/1");
    await screen.findByRole("button", { name: /meilleur coup/ });

    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    const bubble = within(screen.getByLabelText("Commentaire du coach"));
    fireEvent.click(bubble.getAllByRole("button", { name: "Nc6" })[0]);

    // Whose move it is, said out loud: half the plies of a refutation are the
    // opponent's, and a reader who loses track of that reads the line backwards.
    expect(await screen.findByText("Les noirs jouent Nc6.")).toBeDefined();
    expect(screen.getByText(/n’ont pas été joués/)).toBeDefined();

    // The arrows now walk the line rather than the game.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText("Les blancs jouent Nf3.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Retour à la partie/ }));
    await waitFor(() => expect(screen.queryByText(/n’ont pas été joués/)).toBe(null));
    // And the game is where it was left, not where the line ended.
    expect(screen.getByText(/L’adversaire enchaîne/)).toBeDefined();
  });

  // Stepping back off the front of a line is the same gesture as leaving it.
  it("returns to the game when walked back past its first move", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({ ...base, pgn: "1. e4 e5 2. Qh5 Nc6 *" });
    renderApp("/games/1");
    await screen.findByRole("button", { name: /meilleur coup/ });

    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    const walkable = within(screen.getByLabelText("Commentaire du coach"));
    fireEvent.click(walkable.getAllByRole("button", { name: "Nc6" })[0]);
    expect(await screen.findByText("Les noirs jouent Nc6.")).toBeDefined();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.queryByText(/n’ont pas été joués/)).toBe(null));
  });

  // Everything analysed before the driver kept variations has none of this,
  // and the app is not going to re-analyse hours of phone time to get it.
  it("says nothing at all on a move analysed before lines were stored", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({ ...base, pgn: "1. e4 e5 2. Qh5 Nc6 *" });
    renderApp("/games/1");
    await screen.findByRole("button", { name: /meilleur coup/ });

    // Ply 1 is judged as nothing and carries no line.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.queryByText(/L’adversaire enchaîne/)).toBe(null));
    expect(screen.queryByText(/Il fallait jouer/)).toBe(null);
  });
});

describe("playing the position out", () => {
  // The analysis says what should have been played. This is the question that
  // follows it and that a move list cannot answer.
  it("hands the board over without spending a search on arrival", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({ ...base, pgn: "1. d4 d5 *" });
    renderApp("/games/1");

    fireEvent.click(await screen.findByRole("button", { name: /Jouer d’ici/ }));
    expect(await screen.findByRole("button", { name: "Revenir à l’analyse" })).toBeDefined();
    // The starting position is White's, and the user has White here: there is
    // nothing for the engine to do until they move.
    expect(api.evaluate).not.toHaveBeenCalled();
  });

  // The bug behind "I tried it and it does nothing": the board on the analysis
  // screen shows the position *after* the move being looked at, so more often
  // than not the side to move is the opponent's. The engine was only ever
  // asked in reply to a move the user was not allowed to make, and the rally
  // sat there for good.
  it("opens the rally itself when the position is not yours to play", async () => {
    const base = await api.game();
    api.game.mockResolvedValue({ ...base, user_color: "black", pgn: "1. d4 d5 *" });
    api.evaluate.mockResolvedValue({ cp: 15, mate: null, best_uci: "d2d4", depth: 12 });
    renderApp("/games/1");

    fireEvent.click(await screen.findByRole("button", { name: /Jouer d’ici/ }));
    await waitFor(() => expect(api.evaluate).toHaveBeenCalled());
    expect(await screen.findByText(/À vous de jouer/)).toBeDefined();
  });

  // Stockfish has one search state and the driver serialises every call, so a
  // rally queued behind a whole game's analysis waits minutes for its first
  // reply. Taking the board means taking the engine.
  it("stops the analysis queue before taking the engine", async () => {
    let aborted = false;
    const { sync } = await getApi();
    sync.runQueue.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(0);
          });
        }),
    );

    // Started from the home screen, which is where the queue is offered, then
    // into a game from the card that links to one - the route a user takes.
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "Analyser" }));
    await waitFor(() => expect(sync.runQueue).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("link", { name: /La dernière erreur à rejouer/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Jouer d’ici/ }));

    // The runner only resolves when its signal aborts, so the rally starting
    // is what ended it.
    await waitFor(() => expect(aborted).toBe(true));
  });

  it("gives the board back on the way out", async () => {
    renderApp("/games/1");
    fireEvent.click(await screen.findByRole("button", { name: /Jouer d’ici/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Revenir à l’analyse" }));
    expect(await screen.findByRole("button", { name: /Jouer d’ici/ })).toBeDefined();
  });
});

describe("the best-move arrow", () => {
  // It used to be a mode: asking to see the engine move on one ply left the
  // board rewound on every ply after it, so walking the game silently stopped
  // showing the game. It is now scoped to the position it was asked for.
  it("drops as soon as the user moves on", async () => {
    renderApp("/games/1");

    // Ply 0 is the starting position: there is no move to second-guess yet.
    const peek = await screen.findByRole("button", { name: /meilleur coup/ });
    expect(peek.disabled).toBe(true);

    // Ply 1 is second-best but unjudged, so the arrow is off until asked for.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(peek.disabled).toBe(false));
    expect(peek.textContent).toMatch(/Voir le meilleur coup/);

    fireEvent.click(peek);
    expect(await screen.findByRole("button", { name: /Masquer le meilleur coup/ })).toBeDefined();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Masquer le meilleur coup/ })).toBe(null),
    );
  });

  // The whole point of drawing it rather than hiding it behind a button: on a
  // move that cost something, the arrow is already there. "Masquer" is the
  // label the button carries when it is, which is how this is observable
  // without reaching into chessground's SVG.
  it("is already drawn on a judged move", async () => {
    renderApp("/games/1");
    await screen.findByRole("button", { name: /meilleur coup/ });

    // Ply 3 is the blunder in the fixture; ply 2 is the engine's own move.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /meilleur coup/ }).disabled).toBe(true),
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("button", { name: /Masquer le meilleur coup/ })).toBeDefined();
  });
});

describe("the coach's review of the whole archive", () => {
  const withKey = () =>
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });

  it("says what it is before it has ever been asked, and does not ask on its own", async () => {
    withKey();
    renderApp("/stats");
    expect(await screen.findByRole("button", { name: /Demander un bilan/ })).toBeDefined();
    // It spends somebody's quota. It waits to be asked.
    expect(api.coachReview).not.toHaveBeenCalled();
  });

  it("shows the findings, and the numbers each one was written from", async () => {
    withKey();
    renderApp("/stats");
    fireEvent.click(await screen.findByRole("button", { name: /Demander un bilan/ }));

    expect(await screen.findByText("Tu sors la dame trop tôt")).toBeDefined();
    expect(screen.getByText(/Dix parties sans sortir la dame/)).toBeDefined();

    // The receipts are the point: a claim on this screen can be traced back to
    // a row of the archive, or it would not have survived validation.
    fireEvent.click(screen.getByRole("button", { name: /D’où ça sort/ }));
    expect(await screen.findByText(/812 coups, 61 centipions perdus/)).toBeDefined();
  });

  it("points at the settings instead of a dead button when no key is stored", async () => {
    renderApp("/stats");
    expect(await screen.findByRole("link", { name: /Activer le coach IA/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Demander un bilan/ })).toBe(null);
  });
});

describe("the coach", () => {
  // Without a key the screen must not offer to spend one, and it must say
  // where the switch is instead of leaving a dead button.
  it("points at the settings until a key is stored", async () => {
    renderApp("/games/1");
    expect(await screen.findByRole("link", { name: /Activer le coach IA/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Faire commenter/ })).toBe(null);
    expect(api.coachGame).not.toHaveBeenCalled();
  });

  it("offers to comment the game once a key is stored", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    renderApp("/games/1");
    expect(await screen.findByRole("button", { name: /Faire commenter par le coach/ })).toBeDefined();
  });

  it("puts the generated paragraph on the move it was written about", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    renderApp("/games/1");
    fireEvent.click(await screen.findByRole("button", { name: /Faire commenter par le coach/ }));
    await waitFor(() => expect(api.coachGame).toHaveBeenCalled());

    // The commentary is for ply 3; the board opens on ply 0 and nothing should
    // claim otherwise until the user walks there.
    expect(screen.queryByText(/Ta dame sort trop tôt/)).toBe(null);
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText(/Ta dame sort trop tôt/)).toBeDefined();
  });

  // The generated paragraph leads, but the engine's own findings stay under it:
  // the model writes the advice, Stockfish keeps the last word on the facts.
  it("does not replace what the engine found", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    renderApp("/games/1");
    fireEvent.click(await screen.findByRole("button", { name: /Faire commenter par le coach/ }));
    await waitFor(() => expect(api.coachGame).toHaveBeenCalled());
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });

    await screen.findByText(/Ta dame sort trop tôt/);
    expect(screen.getByText(/L’adversaire enchaîne/)).toBeDefined();
  });

  // Re-analysing re-judges every move, so the stored commentary is dropped
  // with it. Leaving it on screen means paragraphs describing a verdict that
  // no longer exists - for as long as the queue takes, which is minutes.
  it("drops the commentary when the game is sent back for a fresh analysis", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    renderApp("/games/1");
    fireEvent.click(await screen.findByRole("button", { name: /Faire commenter par le coach/ }));
    await waitFor(() => expect(api.coachGame).toHaveBeenCalled());
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    await screen.findByText(/Ta dame sort trop tôt/);

    // The re-analysed game comes back pending, so nothing reloads the notes.
    api.game.mockResolvedValue({
      ...(await api.game()),
      analysis_status: "pending",
    });
    fireEvent.click(screen.getByRole("button", { name: /Ré-analyser la partie/ }));

    await waitFor(() => expect(screen.queryByText(/Ta dame sort trop tôt/)).toBe(null));
  });

  it("counts the whole game, not just what the last run added", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    // Two notes already stored, one added by this run: the status line has to
    // say three, because three is what the reader can now see on the board.
    api.coachGame.mockResolvedValueOnce({
      notes: { 1: "a", 3: "b", 5: "c" },
      added: 1,
      failed: 0,
    });
    renderApp("/games/1");
    fireEvent.click(await screen.findByRole("button", { name: /Faire commenter par le coach/ }));
    expect(await screen.findByText(/3 coups commentés sur la partie/)).toBeDefined();
  });

  it("says what went wrong instead of failing silently", async () => {
    api.settings.mockResolvedValueOnce({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    api.coachGame.mockRejectedValueOnce(new Error("Quota du modèle atteint."));
    renderApp("/games/1");
    fireEvent.click(await screen.findByRole("button", { name: /Faire commenter par le coach/ }));
    expect(await screen.findByText(/Quota du modèle atteint/)).toBeDefined();
  });

  // The key is write-only on purpose: it is never sent back to a screen, so it
  // cannot end up in a screenshot or a rendered tree.
  it("never renders the stored key back into the settings screen", async () => {
    api.settings.mockResolvedValue({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    renderApp("/settings");
    expect(await screen.findByText(/une clé est enregistrée/)).toBeDefined();
    const field = document.querySelector('input[type="password"]');
    expect(field.value).toBe("");
    expect(screen.getByRole("button", { name: /Oublier la clé/ })).toBeDefined();
  });

  /**
   * The reason the service exists: Android freezes a backgrounded WebView, so
   * the in-app loop stops the moment the phone goes in a pocket. Where there
   * is a service, the button hands the game to it and says so.
   */
  it("hands the game to the service when the phone has one", async () => {
    api.coachRunner.mockResolvedValue({ available: true, needsPermission: true });
    api.settings.mockResolvedValue({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: false },
      },
    });
    renderApp("/games/1");

    fireEvent.click(await screen.findByRole("button", { name: /Faire commenter par le coach/ }));
    await waitFor(() => expect(api.coachGameBackground).toHaveBeenCalled());
    // The notification is the point of running it there, and on Android 13+
    // it needs asking for.
    expect(api.requestCoachNotifications).toHaveBeenCalled();
    expect(api.coachGame).not.toHaveBeenCalled();
    expect(await screen.findByText(/Vous pouvez quitter l’application/)).toBeDefined();
  });

  // "Combien ça me couterait" is not answerable from "$25 per million output
  // tokens", and the screen is the only place the question gets asked.
  it("prices a commented game before the key is bought", async () => {
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    expect(await screen.findByText(/par partie commentée/)).toBeDefined();
  });

  it("offers the spare provider once a second key exists", async () => {
    api.settings.mockResolvedValue({
      chess_com_username: "maxime",
      last_synced_at: null,
      engine_depth: 18,
      coach: {
        provider: "gemini",
        model: "gemini-3.7-flash",
        key_set: true,
        fallback: true,
        keys: { gemini: true, openrouter: false, anthropic: true },
      },
    });
    renderApp("/settings");
    expect(await screen.findByText(/la demande repart chez Claude/)).toBeDefined();
  });

  it("saves the fallback switch without touching the key", async () => {
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Désactivé" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ coach: { fallback: false } }),
    );
  });

  it("files the key under the provider on screen, and the key only when one was typed", async () => {
    renderApp("/settings");
    const field = await screen.findByPlaceholderText(/Collez votre clé/);
    fireEvent.change(field, { target: { value: "AIza-test" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" })[1]);

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        coach: { keyProvider: "gemini", model: "gemini-3.7-flash", apiKey: "AIza-test" },
      }),
    );
  });

  /**
   * The trap this separation exists for.
   *
   * Selecting Claude to paste its key used to make Claude the provider asked
   * first, which is a paid request for every game from then on - the opposite
   * of why a second key is stored at all. Saving a key now says nothing about
   * who is asked first.
   */
  it("does not move the coach onto a paid provider just for storing its key", async () => {
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    fireEvent.change(screen.getByPlaceholderText(/Collez votre clé/), {
      target: { value: "sk-ant-test" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" })[1]);

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const [{ coach }] = api.updateSettings.mock.calls.at(-1);
    expect(coach.keyProvider).toBe("anthropic");
    expect(coach.provider).toBe(undefined);
  });

  it("moves it only when asked to, in as many words", async () => {
    renderApp("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: /Interroger Claude en premier/ }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        coach: { provider: "anthropic", model: "claude-opus-5" },
      }),
    );
  });
});
