/**
 * The second layer of statistics: everything the Python backend never
 * computed.
 *
 * It lives outside `stats.js` on purpose. That module is a port held to a
 * recording of the backend, compared field for field, and the backend is gone -
 * so a new key there breaks an oracle nothing can regenerate. Nothing here is
 * pinned to anything; it is new work, and it is held to its own tests.
 *
 * Everything is a pure function over an already-loaded list of games, the same
 * contract `stats.js` keeps, so the whole file is testable without a database.
 */

import { roundTo } from "../engine/scoring.js";
import { computeStats, mine, myMoveCount } from "./stats.js";

/** A position this far from level is winning; the mirror of it is lost. */
const DECISIVE_CP = 200;

/** Below this, the user was still in a game worth playing well. */
const PLAYABLE_CP = 300;

/** Games closer together than this belong to the same sitting. */
const SESSION_GAP_S = 30 * 60;

const mean = (values, digits) =>
  values.length ? roundTo(values.reduce((a, b) => a + b, 0) / values.length, digits) : null;

const share = (part, whole) => (whole ? roundTo((100 * part) / whole, 1) : null);

/** The user's own moves of a game, with their analysis, oldest first. */
function myMoves(game) {
  const moves = game.analysis?.moves;
  if (!Array.isArray(moves)) return [];
  return moves.filter((move) => move.color === game.user_color);
}

/** Centipawns from the user's side rather than White's. */
function myEval(game, move) {
  const cp = move.eval_cp;
  if (cp === null || cp === undefined) return null;
  return game.user_color === "white" ? cp : -cp;
}

/* ------------------------------------------------------------------ *
 * Rating gap                                                          *
 * ------------------------------------------------------------------ */

/**
 * Bands on `opponent_rating - user_rating`: negative means a weaker opponent.
 *
 * Half-open, `[min, max)`, so a gap of exactly -150 belongs to one band and
 * only one. The labels are written to match that: "moins de -150" excludes the
 * boundary the next band owns.
 */
export const RATING_BANDS = [
  { key: "much_weaker", label: "Bien plus faible (moins de −150)", min: -Infinity, max: -150 },
  { key: "weaker", label: "Plus faible (−150 à −50)", min: -150, max: -50 },
  { key: "even", label: "Équivalent (−50 à +50)", min: -50, max: 50 },
  { key: "stronger", label: "Plus fort (+50 à +150)", min: 50, max: 150 },
  { key: "much_stronger", label: "Bien plus fort (+150 et plus)", min: 150, max: Infinity },
];

/**
 * Results against opponents by how far above or below the user they were.
 *
 * This replaces the frequent-opponents table, which counted one or two games
 * per name in a pool that pairs at random and then printed a win rate over
 * them. A rating gap is the same question asked of a sample big enough to
 * answer it: are you losing to people you should beat?
 */
export function byRatingGap(games) {
  const buckets = new Map(RATING_BANDS.map((band) => [band.key, []]));

  for (const game of games) {
    if (!game.user_rating || !game.opponent_rating) continue;
    const gap = game.opponent_rating - game.user_rating;
    // `max` is exclusive so a gap of exactly -150 lands in one band only.
    const band = RATING_BANDS.find((b) => gap >= b.min && gap < b.max);
    if (band) buckets.get(band.key).push(game);
  }

  return RATING_BANDS.map((band) => {
    const group = buckets.get(band.key);
    const wins = group.filter((g) => g.result === "win").length;
    const draws = group.filter((g) => g.result === "draw").length;
    const accuracies = group
      .map((g) => mine(g)?.accuracy)
      .filter((a) => a !== null && a !== undefined);
    return {
      key: band.key,
      name: band.label,
      games: group.length,
      wins,
      draws,
      losses: group.length - wins - draws,
      win_rate: group.length ? roundTo((100 * (wins + 0.5 * draws)) / group.length, 1) : null,
      avg_accuracy: mean(accuracies, 1),
    };
  }).filter((row) => row.games > 0);
}

/* ------------------------------------------------------------------ *
 * Mistakes that actually cost something                               *
 * ------------------------------------------------------------------ */

/**
 * The worst moves played while the game was still worth playing.
 *
 * `computeMistakes` in stats.js ranks purely on centipawns lost, so its list
 * fills with moves played from already-lost positions - a −900 from −1200
 * teaches nothing and outranks the −250 that threw a level game. Two filters
 * fix it: the position had to be within `PLAYABLE_CP` of level beforehand, and
 * only the worst move of each game is kept, or one catastrophe takes the list.
 *
 * A move with no recorded evaluation before it is kept rather than dropped:
 * analyses stored before that field existed would otherwise vanish entirely.
 */
export function costlyMistakes(games, { limit = 12, playable = PLAYABLE_CP } = {}) {
  const perGame = new Map();

  for (const game of games) {
    for (const move of game.analysis?.errors ?? []) {
      if (move.color !== game.user_color) continue;

      // No point of view is taken on the threshold, and none is needed: a
      // position three pawns from level is decided whichever side you are, and
      // the question here is only whether the game was still worth playing.
      const before = move.eval_cp_before;
      if (before !== null && before !== undefined && Math.abs(before) >= playable) continue;

      const current = perGame.get(game.id);
      if (current && current.cp_loss >= move.cp_loss) continue;
      perGame.set(game.id, {
        game_id: game.id,
        played_at: game.played_at,
        opponent: game.opponent_username,
        move_number: move.move_number,
        ply: move.ply,
        san: move.san,
        best_move_san: move.best_move_san,
        cp_loss: move.cp_loss,
        judgment: move.judgment,
        phase: move.phase,
        eval_cp_before: before ?? null,
      });
    }
  }

  return [...perGame.values()].sort((a, b) => b.cp_loss - a.cp_loss).slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Converting, and being converted                                     *
 * ------------------------------------------------------------------ */

/**
 * How often a winning position became a win, and a lost one was saved.
 *
 * Accuracy says how well the moves were played; this says whether it mattered.
 * A player who reaches winning positions and does not convert them has a
 * different problem from one who never reaches them.
 */
export function conversion(games, { threshold = DECISIVE_CP } = {}) {
  let winning = 0;
  let converted = 0;
  let losing = 0;
  let saved = 0;

  for (const game of games) {
    const moves = game.analysis?.moves;
    if (!Array.isArray(moves) || !moves.length) continue;

    let best = -Infinity;
    let worst = Infinity;
    for (const move of moves) {
      const cp = myEval(game, move);
      if (cp === null) continue;
      if (cp > best) best = cp;
      if (cp < worst) worst = cp;
    }

    if (best >= threshold) {
      winning += 1;
      if (game.result === "win") converted += 1;
    }
    if (worst <= -threshold) {
      losing += 1;
      // A draw from a lost position is a save; only a loss is not.
      if (game.result !== "loss") saved += 1;
    }
  }

  return {
    winning_positions: winning,
    converted,
    conversion_rate: share(converted, winning),
    losing_positions: losing,
    saved,
    save_rate: share(saved, losing),
  };
}

/* ------------------------------------------------------------------ *
 * Which piece costs the most                                          *
 * ------------------------------------------------------------------ */

export const PIECE_LABEL = {
  K: "Roi",
  Q: "Dame",
  R: "Tour",
  B: "Fou",
  N: "Cavalier",
  P: "Pion",
};

/** The piece a SAN move moved. Castling is the king; anything else is a pawn. */
export function pieceOf(san) {
  if (!san) return null;
  if (san.startsWith("O-O")) return "K";
  const first = san[0];
  return "KQRBN".includes(first) ? first : "P";
}

/**
 * Average centipawns lost per move, by the piece that moved.
 *
 * A dimension borrowed from Lichess Insights, and readable straight off the
 * SAN without asking the engine anything. It tends to name a habit rather than
 * a game: the queen out early, or the knight that keeps landing on a fork.
 */
export function byPiece(games) {
  const buckets = new Map(Object.keys(PIECE_LABEL).map((p) => [p, { losses: [], blunders: 0 }]));

  for (const game of games) {
    for (const move of myMoves(game)) {
      const piece = pieceOf(move.san);
      const bucket = buckets.get(piece);
      if (!bucket || move.cp_loss === null || move.cp_loss === undefined) continue;
      bucket.losses.push(move.cp_loss);
      if (move.judgment === "blunder") bucket.blunders += 1;
    }
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.losses.length > 0)
    .map(([piece, bucket]) => ({
      piece,
      name: PIECE_LABEL[piece],
      moves: bucket.losses.length,
      avg_cp_loss: mean(bucket.losses, 1),
      blunders: bucket.blunders,
    }))
    .sort((a, b) => b.avg_cp_loss - a.avg_cp_loss);
}

/* ------------------------------------------------------------------ *
 * Surviving the opening                                               *
 * ------------------------------------------------------------------ */

/**
 * What the first moves cost, per opening.
 *
 * The openings table already says which ones are won and lost, which is mostly
 * a statement about the middlegames that followed. This asks the narrower
 * question the repertoire can actually answer: do you come out of this opening
 * intact?
 */
export function openingExit(games, { moves: horizon = 12, minGames = 2, limit = 8 } = {}) {
  const buckets = new Map();

  for (const game of games) {
    const played = myMoves(game).slice(0, horizon);
    const losses = played
      .map((move) => move.cp_loss)
      .filter((cp) => cp !== null && cp !== undefined);
    if (!losses.length) continue;

    const name = game.opening || "Ouverture inconnue";
    if (!buckets.has(name)) buckets.set(name, { games: 0, losses: [], wins: 0, draws: 0 });
    const bucket = buckets.get(name);
    bucket.games += 1;
    bucket.losses.push(...losses);
    if (game.result === "win") bucket.wins += 1;
    if (game.result === "draw") bucket.draws += 1;
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.games >= minGames)
    .map(([name, bucket]) => ({
      name,
      games: bucket.games,
      moves: bucket.losses.length,
      acpl: mean(bucket.losses, 1),
      win_rate: roundTo((100 * (bucket.wins + 0.5 * bucket.draws)) / bucket.games, 1),
    }))
    .sort((a, b) => b.acpl - a.acpl)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Tilt                                                                *
 * ------------------------------------------------------------------ */

/**
 * Performance by position within a sitting.
 *
 * Games less than half an hour apart are treated as one session. If the fourth
 * game of an evening is reliably worse than the first, the fix is a habit
 * rather than a chess idea, and no other panel here would ever show it.
 */
export function sessionTilt(games, { gap = SESSION_GAP_S, maxRank = 4 } = {}) {
  const ordered = [...games]
    .filter((game) => game.end_time)
    .sort((a, b) => a.end_time - b.end_time);

  const ranks = new Map();
  let rank = 0;
  let previous = null;

  for (const game of ordered) {
    rank = previous !== null && game.end_time - previous <= gap ? rank + 1 : 1;
    previous = game.end_time;
    const key = Math.min(rank, maxRank);
    if (!ranks.has(key)) ranks.set(key, []);
    ranks.get(key).push(game);
  }

  return [...ranks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, group]) => {
      const analysed = group.map((g) => mine(g)).filter(Boolean);
      const wins = group.filter((g) => g.result === "win").length;
      const draws = group.filter((g) => g.result === "draw").length;
      const blunders = analysed.reduce((n, m) => n + (m.counts.blunder ?? 0), 0);
      return {
        rank: key,
        name: key === maxRank ? `${maxRank}ᵉ et au-delà` : `${key}${key === 1 ? "ʳᵉ" : "ᵉ"}`,
        games: group.length,
        win_rate: roundTo((100 * (wins + 0.5 * draws)) / group.length, 1),
        avg_accuracy: mean(
          analysed.map((m) => m.accuracy).filter((a) => a !== null && a !== undefined),
          1,
        ),
        blunders_per_game: analysed.length ? roundTo(blunders / analysed.length, 2) : null,
      };
    });
}

/* ------------------------------------------------------------------ *
 * The clock                                                           *
 * ------------------------------------------------------------------ */

const CLOCK_TAG = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/g;

export const TIME_BUCKETS = [
  { key: "instant", label: "moins de 5 s", max: 5 },
  { key: "fast", label: "5 à 10 s", max: 10 },
  { key: "normal", label: "10 à 30 s", max: 30 },
  { key: "slow", label: "plus de 30 s", max: Infinity },
];

/** Seconds on the clock after each ply, in ply order, or [] if untagged. */
export function clockSeconds(pgn) {
  if (!pgn) return [];
  const out = [];
  for (const [, h, m, s] of pgn.matchAll(CLOCK_TAG)) {
    out.push(Number(h) * 3600 + Number(m) * 60 + Number(s));
  }
  return out;
}

/**
 * Base seconds and increment from a Chess.com `TimeControl`.
 *
 * "180+2" is three minutes plus two seconds a move; "600" is ten minutes flat.
 * Daily games are written "1/259200" - seconds per move, not a clock - and are
 * excluded, because a move there is thought about across a day.
 */
export function timeControl(value) {
  if (typeof value !== "string" || value.includes("/")) return null;
  const [base, increment] = value.split("+");
  const seconds = Number(base);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { base: seconds, increment: Number(increment ?? 0) || 0 };
}

/**
 * Seconds spent on each of the user's own moves, paired with its judgment.
 *
 * The clock tag records what was left after the move, so the time spent is the
 * previous reading of that same side minus this one, plus whatever increment
 * was just added. The first move of each side measures against the base.
 */
export function moveTimes(game) {
  const control = timeControl(game.time_control);
  const clocks = clockSeconds(game.pgn);
  if (!control || clocks.length < 2) return [];

  const analysed = game.analysis?.moves ?? [];
  const byPly = new Map(analysed.map((move) => [move.ply, move]));
  const mineIsWhite = game.user_color === "white";

  const times = [];
  for (let i = 0; i < clocks.length; i += 1) {
    const isWhite = i % 2 === 0;
    if (isWhite !== mineIsWhite) continue;

    const previous = i < 2 ? control.base : clocks[i - 2];
    // Negative readings happen when a clock was adjusted or the tags are
    // partial; a move cannot have taken less than no time.
    const spent = Math.max(0, previous - clocks[i] + control.increment);
    const move = byPly.get(i + 1);
    times.push({
      ply: i + 1,
      seconds: roundTo(spent, 1),
      judgment: move?.judgment ?? null,
      cp_loss: move?.cp_loss ?? null,
      san: move?.san ?? null,
    });
  }
  return times;
}

/**
 * Do the mistakes come from moving too fast?
 *
 * The most useful thing a player at this level can be told, and the data was
 * already on the phone: Chess.com ships a clock reading per move inside the
 * PGN, which the importer stores whole. Returns null rather than zeroes when
 * no game carries clocks, so the screen can leave the panel out instead of
 * drawing an empty one.
 */
export function clockPressure(games) {
  const buckets = new Map(
    TIME_BUCKETS.map((bucket) => [bucket.key, { moves: 0, blunders: 0, losses: [] }]),
  );
  let gamesWithClocks = 0;
  let moves = 0;
  let blunders = 0;
  let fastBlunders = 0;
  const spent = [];

  for (const game of games) {
    const times = moveTimes(game);
    if (!times.length) continue;
    gamesWithClocks += 1;

    for (const move of times) {
      const bucket = buckets.get(TIME_BUCKETS.find((b) => move.seconds < b.max).key);
      bucket.moves += 1;
      moves += 1;
      spent.push(move.seconds);
      if (move.cp_loss !== null) bucket.losses.push(move.cp_loss);
      if (move.judgment === "blunder") {
        bucket.blunders += 1;
        blunders += 1;
        if (move.seconds < 10) fastBlunders += 1;
      }
    }
  }

  if (!gamesWithClocks) return null;

  const sorted = [...spent].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[middle]
      : roundTo((sorted[middle - 1] + sorted[middle]) / 2, 1)
    : null;

  return {
    games: gamesWithClocks,
    moves,
    blunders,
    median_seconds: median,
    fast_blunders: fastBlunders,
    fast_blunder_share: share(fastBlunders, blunders),
    buckets: TIME_BUCKETS.map((bucket) => {
      const data = buckets.get(bucket.key);
      return {
        key: bucket.key,
        name: bucket.label,
        moves: data.moves,
        blunders: data.blunders,
        blunder_rate: share(data.blunders, data.moves),
        avg_cp_loss: mean(data.losses, 1),
      };
    }).filter((bucket) => bucket.moves > 0),
  };
}

/* ------------------------------------------------------------------ *
 * Now against before                                                  *
 * ------------------------------------------------------------------ */

const HEADLINE = ["win_rate", "avg_accuracy", "blunders_per_game", "avg_acpl"];

/**
 * The same four headline numbers over this window and the one before it.
 *
 * A number with nothing to compare it to cannot say whether things are getting
 * better, which is the only question the summary tiles are asked. Both windows
 * are measured back from the newest game rather than from today, matching what
 * `api.stats(days)` does: opening the app after a fortnight away should not
 * show two empty windows.
 */
export function periodComparison(games, { days = 30 } = {}) {
  const newest = games.reduce((max, g) => Math.max(max, g.end_time ?? 0), 0);
  if (!newest) return null;

  const span = days * 86_400;
  const inWindow = (game, from, to) => (game.end_time ?? 0) > from && (game.end_time ?? 0) <= to;

  const current = games.filter((g) => inWindow(g, newest - span, newest));
  const previous = games.filter((g) => inWindow(g, newest - 2 * span, newest - span));
  if (!current.length) return null;

  const now = computeStats(current);
  const before = previous.length ? computeStats(previous) : null;

  const deltas = {};
  for (const field of HEADLINE) {
    const a = now[field];
    const b = before?.[field];
    deltas[field] =
      a === null || a === undefined || b === null || b === undefined ? null : roundTo(a - b, 2);
  }

  return { days, current: now, previous: before, deltas };
}

/* ------------------------------------------------------------------ *
 * The whole second layer, in one pass                                 *
 * ------------------------------------------------------------------ */

/**
 * Every new statistic, from one load of the archive.
 *
 * Deliberately one call rather than eight: the facade re-reads every game and
 * every analysis on each of its methods, so eight entry points here would be
 * eight passes over the database for one screen.
 */
export function computeInsights(games, options = {}) {
  return {
    by_rating_gap: byRatingGap(games),
    costly_mistakes: costlyMistakes(games, options.mistakes),
    conversion: conversion(games),
    by_piece: byPiece(games),
    opening_exit: openingExit(games, options.opening),
    session_tilt: sessionTilt(games),
    clock: clockPressure(games),
    comparison: periodComparison(games, options.comparison),
  };
}

export { myMoveCount };
