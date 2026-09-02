/**
 * Dashboard aggregates, from backend/app/routes/stats.py.
 *
 * Pure functions over an already-loaded list of games. The server version ran
 * these over rows it had just queried; keeping the query out means the whole
 * thing is testable against the Python without a database in the way.
 *
 * Rounding goes through `roundTo`, not `Math.round`, for the same reason it
 * does in the engine: Python rounds ties to even, and a win rate is a small
 * integer ratio, so exact .x5 values are common rather than rare.
 */

import { roundTo } from "../engine/scoring.js";

export const PHASES = ["opening", "middlegame", "endgame"];
const JUDGMENTS = ["inaccuracy", "mistake", "blunder"];

/** Accuracy, ACPL, judgment counts and phase stats from the user's side. */
export function mine(game) {
  const analysis = game.analysis;
  if (!analysis) return null;
  const white = game.user_color === "white";
  return {
    accuracy: white ? analysis.accuracy_white : analysis.accuracy_black,
    acpl: white ? analysis.acpl_white : analysis.acpl_black,
    counts: (analysis.judgment_counts ?? {})[game.user_color] ?? {},
    phases: (analysis.phase_stats ?? {})[game.user_color] ?? {},
  };
}

/** A draw is half a win. */
export function rate(wins, draws, total) {
  if (!total) return 0.0;
  return roundTo((100 * (wins + 0.5 * draws)) / total, 1);
}

const mean = (values, digits) =>
  values.length ? roundTo(values.reduce((a, b) => a + b, 0) / values.length, digits) : null;

export function breakdown(games, key) {
  const buckets = new Map();
  for (const game of games) {
    const name = key(game) || "unknown";
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(game);
  }

  const rows = [];
  for (const [name, group] of buckets) {
    const wins = group.filter((g) => g.result === "win").length;
    const draws = group.filter((g) => g.result === "draw").length;
    const accuracies = group
      .map((g) => mine(g))
      .filter((m) => m && m.accuracy !== null && m.accuracy !== undefined)
      .map((m) => m.accuracy);
    rows.push({
      name,
      games: group.length,
      wins,
      draws,
      losses: group.length - wins - draws,
      win_rate: rate(wins, draws, group.length),
      avg_accuracy: mean(accuracies, 1),
    });
  }
  // Python's sorted() is stable, so equal counts keep insertion order - which
  // is first-seen order, and games arrive newest first.
  return rows.sort((a, b) => b.games - a.games);
}

export function computeStats(games) {
  const total = games.length;
  const wins = games.filter((g) => g.result === "win").length;
  const draws = games.filter((g) => g.result === "draw").length;
  const losses = total - wins - draws;

  const analysed = games.map((g) => mine(g)).filter(Boolean);
  const defined = (value) => value !== null && value !== undefined;
  const accuracies = analysed.map((m) => m.accuracy).filter(defined);
  const acpls = analysed.map((m) => m.acpl).filter(defined);

  const judgments = Object.fromEntries(JUDGMENTS.map((j) => [j, 0]));
  for (const m of analysed) {
    for (const j of JUDGMENTS) judgments[j] += m.counts[j] ?? 0;
  }

  const phaseTotals = Object.fromEntries(PHASES.map((p) => [p, []]));
  for (const m of analysed) {
    for (const [phase, data] of Object.entries(m.phases ?? {})) {
      if (phase in phaseTotals && defined(data?.acpl)) phaseTotals[phase].push(data.acpl);
    }
  }
  const phase_acpl = {};
  for (const [phase, values] of Object.entries(phaseTotals)) {
    if (values.length) phase_acpl[phase] = mean(values, 1);
  }

  // The phase bleeding the most centipawns, not the one with the worst
  // accuracy. Python's max() over a dict keeps the first key on a tie, and
  // insertion order here is PHASES order, same as there.
  let weakest = null;
  for (const [phase, value] of Object.entries(phase_acpl)) {
    if (weakest === null || value > phase_acpl[weakest]) weakest = phase;
  }

  const n = analysed.length || 1;
  const perGame = (count) => (analysed.length ? roundTo(count / n, 2) : null);

  return {
    games: total,
    analysed: analysed.length,
    wins,
    losses,
    draws,
    win_rate: rate(wins, draws, total),
    avg_accuracy: mean(accuracies, 1),
    avg_acpl: mean(acpls, 1),
    blunders_per_game: perGame(judgments.blunder),
    mistakes_per_game: perGame(judgments.mistake),
    inaccuracies_per_game: perGame(judgments.inaccuracy),
    weakest_phase: weakest,
    by_time_class: breakdown(games, (g) => g.time_class),
    by_color: breakdown(games, (g) => g.user_color),
    top_opponents: breakdown(games, (g) => g.opponent_username).slice(0, 10),
    top_openings: breakdown(games, (g) => g.opening).slice(0, 10),
    phase_acpl,
  };
}

/**
 * ISO-8601 week number, matching `datetime.isocalendar()`.
 *
 * Not the same as "week of the year": weeks belong to the year containing their
 * Thursday, so early January can fall in the previous ISO year. Getting this
 * wrong puts one bucket per year in the wrong place, which is invisible until
 * someone looks at a January trend.
 */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = d.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil((d.getTime() - yearStart) / 86_400_000 / 7 + 1 / 7);
  return { year: d.getUTCFullYear(), week };
}

function bucketOf(game, period) {
  const date = new Date(game.played_at);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (period === "day") {
    return `${year}-${month}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  if (period === "month") return `${year}-${month}`;
  const iso = isoWeek(date);
  return `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
}

/**
 * Short axis label for a bucket key.
 *
 * The keys `bucketOf` produces are built to sort, not to read: `2026-08-14`,
 * `2026-W33`, `2026-08`. Lives here rather than in the chart because the shape
 * being parsed is the one produced four lines up - the two drift together or
 * not at all.
 */
export function formatBucket(key, period) {
  if (typeof key !== "string") return key;
  // A smoothed series is still one point per calendar day.
  if (period === "day" || period === "smooth") {
    const [, month, day] = key.split("-");
    return month && day ? `${day}/${month}` : key;
  }
  if (period === "week") {
    const week = key.split("-W")[1];
    return week ? `S${week}` : key;
  }
  const [year, month] = key.split("-");
  return month ? `${month}/${year.slice(2)}` : key;
}

/** The last `limit` buckets, oldest first, as `[key, games]` pairs. */
function bucketed(games, period, limit) {
  const grouped = new Map();
  for (const game of games) {
    const key = bucketOf(game, period);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(game);
  }
  return [...grouped.keys()]
    .sort()
    .slice(-limit)
    .map((key) => [key, grouped.get(key)]);
}

export function computeTrends(games, { period = "week", limit = 12 } = {}) {
  const defined = (value) => value !== null && value !== undefined;
  return bucketed(games, period, limit).map(([key, group]) => {
    const wins = group.filter((g) => g.result === "win").length;
    const draws = group.filter((g) => g.result === "draw").length;
    const stats = group.map((g) => mine(g)).filter(Boolean);
    return {
      period: key,
      games: group.length,
      win_rate: rate(wins, draws, group.length),
      avg_accuracy: mean(stats.map((m) => m.accuracy).filter(defined), 1),
      avg_acpl: mean(stats.map((m) => m.acpl).filter(defined), 1),
    };
  });
}

/**
 * How many moves the user themself played in a game, or null if unknown.
 *
 * Two sources, because they are not always both there. A stored analysis
 * carries the whole move list, which can be counted exactly; the golden
 * fixtures carry only the aggregates the Python emitted, and a game analysed
 * before the move list existed carries `moves_evaluated`, a ply count covering
 * both sides. Halving that is exact rather than approximate: White plays the
 * odd plies, Black the even ones.
 */
export function myMoveCount(game) {
  const analysis = game.analysis;
  if (!analysis) return null;

  const moves = analysis.moves;
  if (Array.isArray(moves) && moves.length) {
    return moves.filter((m) => m.color === game.user_color).length;
  }

  const plies = analysis.moves_evaluated;
  if (!plies) return null;
  return game.user_color === "white" ? Math.ceil(plies / 2) : Math.floor(plies / 2);
}

/**
 * How thin a sample is allowed to get before a rate stops being reported.
 *
 * A rate per hundred moves computed over twenty moves is not a small number
 * with a wide error bar - it is one game's story printed in the units of a
 * trend, and it lands on the chart looking exactly like a point built from six
 * hundred moves. The two failures it produces are both real:
 *
 *   - a short game is *conditioned* on the mistake. A game that ended by mate
 *     on move twelve ended that way because somebody blundered, so a window
 *     holding one of those and nothing else reports a blunder rate three or
 *     four times anyone's real one;
 *   - a day with no games near it reports nothing at all, and a chart drawing
 *     nothing as zero opens the series at the floor before it "climbs".
 *
 * So below these, the rate is `null` rather than a number, and the window's
 * own size travels beside it so a screen can say why.
 *
 * Eighty of the player's own moves is about two and a half blitz games, which
 * is where a per-hundred rate stops moving by whole points on one blunder.
 *
 * Only the per-hundred rate is held to it. The per-game series has the same
 * noise and not the same lie: its denominator is the number of games, which is
 * exactly what its label says, so "3 gaffes par partie" over one game is a
 * true statement about a bad evening rather than a rate computed from six
 * moves and drawn like a trend.
 */
export const MIN_RATE_MOVES = 80;

/**
 * Blunders, mistakes and inaccuracies over time - the thing that decides games
 * at club level, and the one series `computeTrends` cannot carry.
 *
 * It is a separate function rather than three more fields on `computeTrends`
 * because that one is pinned to a recording of the Python backend that no
 * longer exists to regenerate it. Adding a key there breaks the oracle with no
 * way to re-derive it, so the new numbers live here and are held to their own
 * tests.
 *
 * Two normalisations, because neither alone is honest: per game is what the
 * player feels, but a 25-move loss and an 80-move grind are not comparable, so
 * per 100 of the user's own moves is what actually shows a trend.
 */
export function computeJudgmentTrends(games, { period = "week", limit = 12 } = {}) {
  return bucketed(games, period, limit).map(([key, group]) => {
    const totals = Object.fromEntries(JUDGMENTS.map((j) => [j, 0]));
    // Counted apart from the totals: a game whose move count is unknown must
    // not put its blunders in the numerator of a rate its moves are missing
    // from, which would inflate the rate exactly when data is thin.
    const counted = Object.fromEntries(JUDGMENTS.map((j) => [j, 0]));
    let analysed = 0;
    let moves = 0;

    for (const game of group) {
      const m = mine(game);
      if (!m) continue;
      analysed += 1;
      const played = myMoveCount(game);
      for (const j of JUDGMENTS) {
        const n = m.counts[j] ?? 0;
        totals[j] += n;
        if (played) counted[j] += n;
      }
      if (played) moves += played;
    }

    const perGame = (n) => (analysed ? roundTo(n / analysed, 2) : null);
    const per100 = (n) => (moves >= MIN_RATE_MOVES ? roundTo((100 * n) / moves, 2) : null);

    return {
      period: key,
      games: group.length,
      analysed,
      moves: moves || null,
      blunders: totals.blunder,
      mistakes: totals.mistake,
      inaccuracies: totals.inaccuracy,
      blunders_per_game: perGame(totals.blunder),
      mistakes_per_game: perGame(totals.mistake),
      inaccuracies_per_game: perGame(totals.inaccuracy),
      blunders_per_100: per100(counted.blunder),
      mistakes_per_100: per100(counted.mistake),
      inaccuracies_per_100: per100(counted.inaccuracy),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Smoothed daily trend                                                *
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/**
 * Triangular weights over a window of +-`radius` days, centred on the day.
 *
 * Triangular rather than flat so a day is described mostly by itself and its
 * neighbours, and only faintly by the edge of the window. `radius = 3` is a
 * week centred on the day, which is the span that turns a month of play into a
 * line you can read.
 */
export function smoothingWeights(radius) {
  const weights = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    weights.push({ offset, weight: radius + 1 - Math.abs(offset) });
  }
  return weights;
}

/** Every calendar day from the first game to the last, gaps included. */
function dayAxis(games) {
  let first = Infinity;
  let last = -Infinity;
  for (const game of games) {
    const time = Date.parse(game.played_at);
    if (!Number.isFinite(time)) continue;
    const day = Math.floor(time / DAY_MS);
    if (day < first) first = day;
    if (day > last) last = day;
  }
  if (!Number.isFinite(first)) return [];

  const days = [];
  for (let day = first; day <= last; day += 1) {
    days.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}

/** The raw ingredients of one day, kept unaveraged so they can be summed. */
function blankDay(key) {
  return {
    period: key,
    games: 0,
    wins: 0,
    draws: 0,
    analysed: 0,
    accuracy_sum: 0,
    accuracy_n: 0,
    acpl_sum: 0,
    acpl_n: 0,
    moves: 0,
    blunders: 0,
    mistakes: 0,
    inaccuracies: 0,
    counted_blunders: 0,
    counted_mistakes: 0,
    counted_inaccuracies: 0,
  };
}

const PLURAL = { blunder: "blunders", mistake: "mistakes", inaccuracy: "inaccuracies" };

/**
 * A daily series smoothed against the days around it.
 *
 * By week there are not enough weeks to see anything; by day a single
 * afternoon swings the line from 0 to 100. This is the middle: a point per
 * day, each one describing itself and the week around it.
 *
 * Two things it deliberately does not do. It does not average the daily
 * averages - a day with one game would then weigh as much as a day with ten -
 * but sums the numerators and the denominators separately across the window,
 * so every game counts once wherever it was played. And it walks the calendar
 * rather than the list of days that have games, so a neighbour is a day away
 * and not three weeks away across a gap where nothing was played.
 *
 * Every value comes back twice: `raw_*` is that day alone, and the plain name
 * is the smoothed one, so a chart can draw the trend without hiding the data
 * underneath it.
 */
export function computeSmoothedTrends(games, { radius = 3, limit = 60 } = {}) {
  const days = dayAxis(games);
  if (!days.length) return [];

  const byDay = new Map(days.map((key) => [key, blankDay(key)]));
  for (const game of games) {
    const bucket = byDay.get(bucketOf(game, "day"));
    if (!bucket) continue;

    bucket.games += 1;
    if (game.result === "win") bucket.wins += 1;
    if (game.result === "draw") bucket.draws += 1;

    const m = mine(game);
    if (!m) continue;
    bucket.analysed += 1;
    if (m.accuracy !== null && m.accuracy !== undefined) {
      bucket.accuracy_sum += m.accuracy;
      bucket.accuracy_n += 1;
    }
    if (m.acpl !== null && m.acpl !== undefined) {
      bucket.acpl_sum += m.acpl;
      bucket.acpl_n += 1;
    }

    const played = myMoveCount(game);
    if (played) bucket.moves += played;
    for (const judgment of JUDGMENTS) {
      const n = m.counts[judgment] ?? 0;
      bucket[PLURAL[judgment]] += n;
      // Same rule as `computeJudgmentTrends`: a game whose moves could not be
      // counted stays out of the per-hundred rate on both sides of the ratio.
      if (played) bucket[`counted_${PLURAL[judgment]}`] += n;
    }
  }

  const ordered = days.map((key) => byDay.get(key));
  const weights = smoothingWeights(radius);

  const series = ordered.map((day, index) => {
    const totals = blankDay(day.period);
    // The same window, unweighted. The weights cancel inside a ratio, so they
    // are right for the value and useless for judging whether there is enough
    // behind it: a single game on the centre day arrives in `totals` as four.
    // How much play a point actually rests on has to be counted, not weighted.
    const sample = { games: 0, analysed: 0, moves: 0 };

    for (const { offset, weight } of weights) {
      const neighbour = ordered[index + offset];
      if (!neighbour) continue;
      for (const field of Object.keys(totals)) {
        if (field === "period") continue;
        totals[field] += neighbour[field] * weight;
      }
      sample.games += neighbour.games;
      sample.analysed += neighbour.analysed;
      sample.moves += neighbour.moves;
    }

    const ratio = (numerator, denominator, digits) =>
      denominator ? roundTo(numerator / denominator, digits) : null;

    // Thin windows report nothing rather than a number the chart cannot draw
    // honestly - see MIN_RATE_MOVES.
    const perGame = (numerator) => ratio(numerator, totals.analysed, 2);
    const per100 = (numerator) =>
      sample.moves >= MIN_RATE_MOVES ? ratio(100 * numerator, totals.moves, 2) : null;

    return {
      period: day.period,
      games: day.games,
      analysed: day.analysed,
      window_games: totals.games,
      // What the smoothed values above actually rest on, counted rather than
      // weighted, so a screen can say "trois parties" instead of implying the
      // point is as solid as the one next to it.
      sample_games: sample.games,
      sample_analysed: sample.analysed,
      sample_moves: sample.moves,

      // That day's own totals, under the names `computeJudgmentTrends` uses,
      // so a caller can sum a window the same way whichever series it holds.
      blunders: day.blunders,
      mistakes: day.mistakes,
      inaccuracies: day.inaccuracies,

      raw_win_rate: day.games ? rate(day.wins, day.draws, day.games) : null,
      raw_avg_accuracy: ratio(day.accuracy_sum, day.accuracy_n, 1),
      raw_blunders_per_game: ratio(day.blunders, day.analysed, 2),

      win_rate: ratio(100 * (totals.wins + 0.5 * totals.draws), totals.games, 1),
      avg_accuracy: ratio(totals.accuracy_sum, totals.accuracy_n, 1),
      avg_acpl: ratio(totals.acpl_sum, totals.acpl_n, 1),

      blunders_per_game: perGame(totals.blunders),
      mistakes_per_game: perGame(totals.mistakes),
      inaccuracies_per_game: perGame(totals.inaccuracies),

      blunders_per_100: per100(totals.counted_blunders),
      mistakes_per_100: per100(totals.counted_mistakes),
      inaccuracies_per_100: per100(totals.counted_inaccuracies),
    };
  });

  return series.slice(-limit);
}

/** Where the damage happens: worst moves and the move numbers they cluster on. */
export function computeMistakes(games) {
  const worst = [];
  const byMoveNumber = new Map();

  for (const game of games) {
    if (!game.analysis) continue;
    for (const move of game.analysis.errors ?? []) {
      // The opponent's blunders are not the user's pattern.
      if (move.color !== game.user_color) continue;
      byMoveNumber.set(move.move_number, (byMoveNumber.get(move.move_number) ?? 0) + 1);
      worst.push({
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
      });
    }
  }

  worst.sort((a, b) => b.cp_loss - a.cp_loss);
  return {
    worst_moves: worst.slice(0, 25),
    by_move_number: [...byMoveNumber.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([move_number, count]) => ({ move_number, count })),
  };
}
