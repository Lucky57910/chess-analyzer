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

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

beforeEach(() => {
  vi.clearAllMocks();
});

// Testing Library only registers its own cleanup when vitest globals are on,
// and they are not. Without this every render stacks in the same document and
// the queries start finding the previous test's markup.
afterEach(cleanup);

describe("the dashboard", () => {
  it("shows the games it was given", async () => {
    renderApp("/");
    expect(await screen.findByText("rival")).toBeDefined();
    expect(api.games).toHaveBeenCalled();
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
