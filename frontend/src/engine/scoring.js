/**
 * The judgment and accuracy model, ported from backend/app/services/engine.py.
 *
 * Everything here is pure: no engine, no board, no I/O. That is what makes it
 * testable against the frozen Python output in __fixtures__/golden.json, which
 * is the only reason to trust a hand transcription of this much floating-point
 * arithmetic. Chess.com's accuracy cannot play that role - it comes from CAPS2,
 * a different model, so it validates plausibility and nothing else.
 *
 * Field names stay snake_case because they travel straight into the components
 * and the local database, both of which already speak the API's shape.
 */

export const MATE_CP = 10_000;
export const CLIP_CP = 1_000; // beyond +-10 pawns a position is winning; further gain is noise

export const INACCURACY_CP = 50;
export const MISTAKE_CP = 100;
export const BLUNDER_CP = 300;

// Accuracy aggregation (Lichess model). The window slides over the win% curve
// and its standard deviation becomes the weight of the move played inside it.
export const ACCURACY_WINDOW_MIN = 2;
export const ACCURACY_WINDOW_MAX = 8;
export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 12.0;
export const HARMONIC_FLOOR = 0.5;

/**
 * Python's `round(value, digits)`, which is not `Math.round`.
 *
 * Two differences, and both bite here. Python breaks ties to even, JS rounds
 * half up; and Python rounds the *exact* binary value of the double, so
 * `round(2.675, 2)` is 2.67 because 2.675 is really 2.67499999999999982.
 *
 * An ACPL is a sum of integers over a count, so exact .x5 ties are routine
 * rather than exotic - `Math.round(0.25 * 10) / 10` gives 0.3 where Python
 * gives 0.2. `toFixed(18)` hands us the correctly-rounded decimal expansion,
 * far enough out that a tie in the string means a genuine tie in the double.
 */
export function roundTo(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const negative = value < 0 || Object.is(value, -0);
  const text = Math.abs(value).toFixed(18);
  const dot = text.indexOf(".");
  const decimals = text.slice(dot + 1);

  const keep = decimals.slice(0, digits);
  const rest = decimals.slice(digits);
  let digitsOut = text.slice(0, dot) + keep;

  const first = rest.charCodeAt(0) - 48;
  const tie = first === 5 && !/[1-9]/.test(rest.slice(1));
  const lastKept = digitsOut.charCodeAt(digitsOut.length - 1) - 48;
  const roundUp = first > 5 || (first === 5 && !tie) || (tie && lastKept % 2 === 1);

  if (roundUp) {
    // String increment: the integer may be longer than Number.MAX_SAFE_INTEGER
    // in principle, and this costs nothing.
    const chars = digitsOut.split("");
    let i = chars.length - 1;
    for (; i >= 0; i -= 1) {
      if (chars[i] === "9") {
        chars[i] = "0";
      } else {
        chars[i] = String(Number(chars[i]) + 1);
        break;
      }
    }
    if (i < 0) chars.unshift("1");
    digitsOut = chars.join("");
  }

  const magnitude = Number(digitsOut) / 10 ** digits;
  return negative ? -magnitude : magnitude;
}

export function clip(cp) {
  return Math.max(-CLIP_CP, Math.min(CLIP_CP, cp));
}

/** Lichess win-probability model, from the White point of view. */
export function winPercentWhite(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clip(cp))) - 1);
}

/** Lichess per-move accuracy; both win% already from the mover point of view. */
export function moveAccuracy(winBefore, winAfter) {
  const drop = Math.max(0, winBefore - winAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

export function judgmentFor(cpLoss) {
  if (cpLoss >= BLUNDER_CP) return "blunder";
  if (cpLoss >= MISTAKE_CP) return "mistake";
  if (cpLoss >= INACCURACY_CP) return "inaccuracy";
  return null;
}

/**
 * Population standard deviation, matching `statistics.pstdev`.
 *
 * Python computes the sum of squares in exact rational arithmetic before
 * taking the root, so a naive float loop drifts in the last few bits.
 * Neumaier compensation closes that gap to well below anything that survives
 * the clamp and the eventual round to one decimal.
 */
function pstdev(values) {
  const n = values.length;
  if (n === 0) return 0;

  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    compensation +=
      Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  const mean = (sum + compensation) / n;

  let squares = 0;
  let squaresCompensation = 0;
  for (const value of values) {
    const deviation = value - mean;
    const term = deviation * deviation;
    const next = squares + term;
    squaresCompensation +=
      Math.abs(squares) >= Math.abs(term) ? squares - next + term : term - next + squares;
    squares = next;
  }
  return Math.sqrt(Math.max(0, (squares + squaresCompensation) / n));
}

/** White-POV win% for every position of the game, starting position included. */
export function positionWinPercents(moves) {
  if (!moves.length) return [];
  const opening = moves[0].eval_cp_before;
  const series = [winPercentWhite(opening == null ? 0 : opening)];
  for (const move of moves) {
    series.push(winPercentWhite(move.eval_cp == null ? 0 : move.eval_cp));
  }
  return series;
}

/**
 * How much each move counts, from how sharp the position was around it.
 *
 * A slip in a knife-edge position matters more than one in a settled endgame,
 * so every move is weighted by the standard deviation of the win% inside a
 * sliding window. The first window is repeated to cover the opening moves,
 * which have no history behind them.
 */
export function volatilityWeights(winPercents) {
  const n = winPercents.length;
  if (n < 2) return new Array(n).fill(WEIGHT_MIN);

  const size = Math.max(
    ACCURACY_WINDOW_MIN,
    Math.min(ACCURACY_WINDOW_MAX, Math.floor(n / 10)),
  );

  let windows;
  if (n <= size) {
    windows = new Array(n).fill(winPercents);
  } else {
    windows = new Array(size - 1).fill(winPercents.slice(0, size));
    for (let i = 0; i <= n - size; i += 1) windows.push(winPercents.slice(i, i + size));
  }
  return windows.map((w) => Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, pstdev(w))));
}

/**
 * Lichess' game accuracy: the mean of a weighted mean and a harmonic mean.
 *
 * A plain arithmetic mean lets two blunders hide behind forty quiet moves,
 * which read ~15 points above Chess.com. The harmonic half punishes a single
 * terrible move the way a human reviewer does.
 *
 * @param {Array<[number, number]>} pairs [accuracy, weight]
 */
export function blendAccuracy(pairs) {
  if (!pairs.length) return null;

  const totalWeight = pairs.reduce((acc, [, weight]) => acc + weight, 0);
  const weighted = totalWeight
    ? pairs.reduce((acc, [value, weight]) => acc + value * weight, 0) / totalWeight
    : pairs.reduce((acc, [value]) => acc + value, 0) / pairs.length;

  // One exact zero would drag the harmonic mean to zero and swallow the whole
  // game, so the per-move values are floored just above it.
  const harmonic =
    pairs.length / pairs.reduce((acc, [value]) => acc + 1 / Math.max(value, HARMONIC_FLOOR), 0);

  return roundTo(Math.max(0, Math.min(100, (weighted + harmonic) / 2)), 1);
}

const PHASES = ["opening", "middlegame", "endgame"];
const JUDGMENTS = ["inaccuracy", "mistake", "blunder"];

/** Per-colour accuracy, ACPL, judgment counts and phase breakdown. */
export function aggregate(moves) {
  const out = {
    accuracy_white: null,
    accuracy_black: null,
    acpl_white: null,
    acpl_black: null,
    judgment_counts: {},
    phase_stats: {},
  };

  // One weight per *position*, so there is one more of them than there are
  // moves. Python's zip() drops the extra, which pairs weight[i] with move[i]
  // - the weight of the position the move was played from. Slicing here keeps
  // that pairing rather than re-deriving it.
  const weights = volatilityWeights(positionWinPercents(moves));
  const paired = moves.map((move, i) => [move, weights[i]]).filter(([, w]) => w !== undefined);

  for (const color of ["white", "black"]) {
    const side = moves.filter((m) => m.color === color);
    if (!side.length) continue;

    out[`accuracy_${color}`] = blendAccuracy(
      paired.filter(([m]) => m.color === color).map(([m, w]) => [m.accuracy, w]),
    );
    out[`acpl_${color}`] = roundTo(
      side.reduce((acc, m) => acc + m.cp_loss, 0) / side.length,
      1,
    );
    out.judgment_counts[color] = Object.fromEntries(
      JUDGMENTS.map((j) => [j, side.filter((m) => m.judgment === j).length]),
    );

    const phases = {};
    for (const phase of PHASES) {
      const inPhase = side.filter((m) => m.phase === phase);
      if (!inPhase.length) continue;
      const plies = new Set(inPhase.map((m) => m.ply));
      phases[phase] = {
        moves: inPhase.length,
        acpl: roundTo(inPhase.reduce((acc, m) => acc + m.cp_loss, 0) / inPhase.length, 1),
        accuracy: blendAccuracy(
          paired.filter(([m]) => plies.has(m.ply)).map(([m, w]) => [m.accuracy, w]),
        ),
      };
    }
    out.phase_stats[color] = phases;
  }
  return out;
}
