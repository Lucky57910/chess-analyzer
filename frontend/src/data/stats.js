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

export function computeTrends(games, { period = "week", limit = 12 } = {}) {
  const grouped = new Map();
  for (const game of games) {
    const key = bucketOf(game, period);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(game);
  }

  const defined = (value) => value !== null && value !== undefined;
  return [...grouped.keys()]
    .sort()
    .slice(-limit)
    .map((key) => {
      const group = grouped.get(key);
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
