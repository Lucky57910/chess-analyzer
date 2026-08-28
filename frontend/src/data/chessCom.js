/**
 * Chess.com Published-Data API client, from backend/app/services/chess_com.py.
 *
 * The API is public and unauthenticated but rejects requests without a
 * descriptive User-Agent, so every call goes through `request`.
 *
 * Requests go out through CapacitorHttp, which performs them on the native HTTP
 * stack rather than in the WebView. That is what makes this app possible
 * without a server: a browser calling api.chess.com is subject to CORS, a
 * native client is not. It is also why the backend's proxy role disappears
 * rather than moving somewhere cheaper.
 */

import { Chess } from "chess.js";

export const BASE = "https://api.chess.com/pub";

export const USER_AGENT = "chess-analyzer/1.0";

export const DRAW_RESULTS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

export class ChessComError extends Error {}

/**
 * @param {object} [http] Injected for tests; defaults to CapacitorHttp.
 */
export function createClient(http) {
  const request = async (url) => {
    const response = await http.get({
      url,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      connectTimeout: 20_000,
      readTimeout: 20_000,
    });
    return response;
  };

  const getJson = async (url, { missingIsEmpty = false } = {}) => {
    const response = await request(url);
    if (response.status === 404) {
      if (missingIsEmpty) return null;
      throw new ChessComError(`Not found: ${url}`);
    }
    if (response.status >= 400) {
      throw new ChessComError(`Chess.com returned ${response.status} for ${url}`);
    }
    // The native layer parses JSON when the content type says so, and hands
    // back a string when it does not.
    return typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  };

  return {
    async playerExists(username) {
      const response = await request(`${BASE}/player/${username.toLowerCase()}`);
      return response.status === 200;
    },

    /** Monthly archive URLs, oldest first. */
    async listArchives(username) {
      const data = await getJson(
        `${BASE}/player/${username.toLowerCase()}/games/archives`,
        { missingIsEmpty: true },
      );
      if (data === null) throw new ChessComError(`Chess.com user '${username}' not found`);
      return data.archives ?? [];
    },

    async fetchArchive(url) {
      const data = await getJson(url, { missingIsEmpty: true });
      return data === null ? [] : (data.games ?? []);
    },

    async fetchCurrentMonth(username) {
      const now = new Date();
      const month = String(now.getUTCMonth() + 1).padStart(2, "0");
      return this.fetchArchive(
        `${BASE}/player/${username.toLowerCase()}/games/${now.getUTCFullYear()}/${month}`,
      );
    },

    /** The last `months` archives, including the current one, oldest first. */
    async fetchRecentMonths(username, months) {
      const archives = await this.listArchives(username);
      const wanted = archives.slice(-Math.max(months, 1));
      const games = [];
      for (const url of wanted) games.push(...(await this.fetchArchive(url)));
      return games;
    },
  };
}

function pgnHeaders(pgn) {
  try {
    const game = new Chess();
    game.loadPgn(pgn);
    return game.getHeaders();
  } catch {
    return {}; // a malformed PGN must never kill a sync
  }
}

/**
 * The two kinds of game, and the whole of the rule that tells them apart.
 *
 * `training` is everything that does not measure the player's real strength:
 * games against the coach or a bot, and casual games. They still get analysed
 * and reviewed - the point of the split is that they do not sit in the same
 * average as rated play, where the result stood for something.
 *
 * The rule is `rated`, which Chess.com sends with every archived game and this
 * app has stored since the first version. It reads that one field, so it works
 * on a raw archive entry, on a normalised row and on a line of an old backup
 * alike - which is why the kind is filed at insert time rather than in
 * `normalizeGame`, whose output is compared field for field to a recording of
 * the Python backend and cannot gain one.
 *
 * Checked against a real archive of 227 games rather than assumed: the unrated
 * games were exactly the games whose PGN says `[Event "Play vs Coach"]`, all 33
 * of them against the same account, and nothing else in the archive was
 * unrated. The Event header is the more literal marker, and this is not it on
 * purpose - any coach or computer mode is unrated, so `rated` keeps working
 * when Chess.com adds another one under a different name. It errs only towards
 * being too broad, and too broad here means keeping a game that was not played
 * for a rating out of the average that stands for the player's rating.
 */
export const GAME_KINDS = ["rated", "training"];

export function gameKind(raw) {
  return raw?.rated === false ? "training" : "rated";
}

/** Chess.com puts the opening in ECOUrl, e.g. .../openings/Sicilian-Defense-Najdorf. */
function openingName(headers) {
  if (headers.Opening) return headers.Opening.slice(0, 160);
  const url = headers.ECOUrl;
  if (!url) return null;
  return url.replace(/\/+$/, "").split("/").pop().replaceAll("-", " ").slice(0, 160);
}

/**
 * Turn a Chess.com archive entry into a row for `games`.
 *
 * Returns null for anything we cannot analyse: variants, missing PGN, or a game
 * this player is not in.
 */
export function normalizeGame(raw, chessComUsername) {
  if (raw.rules !== "chess") return null;
  const pgn = raw.pgn;
  if (!pgn) return null;

  const me = chessComUsername.toLowerCase();
  const white = raw.white ?? {};
  const black = raw.black ?? {};

  let mine;
  let theirs;
  let color;
  if ((white.username ?? "").toLowerCase() === me) {
    [mine, theirs, color] = [white, black, "white"];
  } else if ((black.username ?? "").toLowerCase() === me) {
    [mine, theirs, color] = [black, white, "black"];
  } else {
    return null;
  }

  const rawResult = mine.result ?? "";
  let result;
  if (rawResult === "win") result = "win";
  else if (DRAW_RESULTS.has(rawResult)) result = "draw";
  else result = "loss";

  // Termination is whichever side's result code is not the generic "win".
  const termination = rawResult === "win" ? (theirs.result ?? null) : rawResult;

  const headers = pgnHeaders(pgn);
  const endTime = Number(raw.end_time ?? 0) || 0;

  // Only present once the game has been reviewed on Chess.com.
  const accuracies = raw.accuracies ?? {};

  return {
    chess_com_game_id: String(raw.uuid ?? raw.url ?? endTime),
    url: raw.url ?? null,
    pgn,
    user_color: color,
    user_rating: mine.rating ?? null,
    opponent_username: theirs.username ?? "?",
    opponent_rating: theirs.rating ?? null,
    result,
    termination,
    time_class: raw.time_class ?? null,
    time_control: raw.time_control ?? null,
    rated: Boolean(raw.rated ?? true),
    eco: headers.ECO || null,
    opening: openingName(headers),
    chess_com_accuracy: accuracies[color] ?? null,
    played_at: new Date(endTime * 1000).toISOString(),
    end_time: endTime,
  };
}
