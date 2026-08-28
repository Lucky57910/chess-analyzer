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

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/api", () => {
  const api = {
    settings: vi.fn(async () => ({
      chess_com_username: "maxime",
      last_synced_at: "2026-08-26T10:00:00.000Z",
      engine_depth: 18,
    })),
    updateSettings: vi.fn(async (patch) => ({
      chess_com_username: patch.chess_com_username.trim(),
      last_synced_at: null,
      engine_depth: 18,
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
      costly_mistakes: [
        {
          game_id: 1,
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
      comparison: {
        days: 30,
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
  ["gamesPage", "settings", "health", "insights"].map((name) => [
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
    renderApp("/");
    expect(await screen.findByText("rival")).toBeDefined();
    expect(api.gamesPage).toHaveBeenCalled();
  });

  // The list used to stop at 25 rows with nothing saying there were more.
  it("says how much of the archive is on screen", async () => {
    renderApp("/");
    expect(await screen.findByText("25 sur 342 parties")).toBeDefined();
  });

  it("widens the window instead of stitching pages together", async () => {
    renderApp("/");
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
    renderApp("/");
    expect(await screen.findByText("1 sur 1 partie")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Charger/ })).toBe(null);
  });

  it("filters the query and goes back to the first window", async () => {
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: /Charger 25 de plus/ }));
    expect(await screen.findByText("50 sur 342 parties")).toBeDefined();

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
    renderApp("/");
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
    renderApp("/");
    await waitFor(() => expect(api.stats).toHaveBeenCalled());
    expect(await screen.findByText(/58[.,]3/)).toBeDefined();
  });

  // The queue costs battery and only runs in the foreground, so it must not
  // start itself the moment the app opens.
  it("offers the queue rather than starting it", async () => {
    renderApp("/");
    const button = await screen.findByRole("button", { name: /Analyser/ });
    expect(button).toBeDefined();
    const { sync } = await getApi();
    expect(sync.runQueue).not.toHaveBeenCalled();
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
  it("asks for a window that matches the granularity", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("week", 26));

    fireEvent.click(await screen.findByRole("button", { name: "Jour" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("day", 60));

    fireEvent.click(await screen.findByRole("button", { name: "Mois" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("month", 24));
  });

  // Both time series read the same granularity, so the selector drives both.
  it("moves the judgment series with the granularity too", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.judgmentTrends).toHaveBeenCalledWith("week", 26));

    fireEvent.click(await screen.findByRole("button", { name: "Jour" }));
    await waitFor(() => expect(api.judgmentTrends).toHaveBeenCalledWith("day", 60));
  });

  // Neither of these depends on the granularity. Re-deriving them on every
  // click means two more full passes over the archive for identical numbers.
  it("does not rebuild the period-independent stats when the granularity changes", async () => {
    renderApp("/stats");
    await waitFor(() => expect(api.stats).toHaveBeenCalledTimes(1));
    expect(api.mistakes).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Jour" }));
    await waitFor(() => expect(api.trends).toHaveBeenCalledWith("day", 60));

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

  it("counts blunders per game or per hundred moves, on demand", async () => {
    renderApp("/stats");
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

describe("the best-move peek", () => {
  // It used to be a mode: asking to see the engine move on one ply left the
  // board rewound on every ply after it, so walking the game silently stopped
  // showing the game. It is now scoped to the position it was asked for.
  it("drops as soon as the user moves on", async () => {
    renderApp("/games/1");

    // Ply 0 is the starting position: there is no move to second-guess yet.
    const peek = await screen.findByRole("button", { name: /meilleur coup/ });
    expect(peek.disabled).toBe(true);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(peek.disabled).toBe(false));

    fireEvent.click(peek);
    expect(await screen.findByRole("button", { name: /Revenir au coup joué/ })).toBeDefined();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Revenir au coup joué/ })).toBe(null),
    );
    expect(screen.getByRole("button", { name: /Voir le meilleur coup/ })).toBeDefined();
  });
});
