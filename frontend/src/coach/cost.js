/**
 * What a commented game costs, when it costs money.
 *
 * The free tiers cost a quota and the screen says so. A paid key costs
 * fractions of a cent per game, which is a number nobody can guess from
 * "$5 per million tokens" — and guessing wrong in either direction is bad:
 * refusing a feature that costs two euros a year, or turning one on that
 * quietly costs twenty.
 *
 * So it is computed, from the sizes this app actually sends. Every constant
 * below is measured against `digest.js` on a real 40-move blitz game rather
 * than assumed:
 *
 *   - a chunk of 24 of the player's moves is about 1,500 characters of facts,
 *     and the system prompt is about 1,400 more;
 *   - French runs near 3.5 characters per token, which is denser than the
 *     "four characters" rule of thumb and would otherwise flatter the input;
 *   - the answer is one to three sentences per move, so a full chunk comes
 *     back at roughly 4,800 characters, and on a model that thinks before it
 *     writes the thinking is spent out of the same budget.
 *
 * It is an estimate and it says so on screen. The point is the order of
 * magnitude: cents, not euros.
 */

import { CHUNK_SIZE } from "./digest.js";
import { providerFor } from "./providers.js";

/** Characters per token, for French prose. */
const CHARS_PER_TOKEN = 3.5;

/** The instructions, sent once per request. */
const SYSTEM_CHARS = 1400;

/** Facts, per one of the player's moves. */
const DIGEST_CHARS_PER_MOVE = 75;

/** Comment written back, per move. */
const ANSWER_CHARS_PER_MOVE = 200;

/**
 * Tokens spent thinking, per request, on a model that thinks by default.
 *
 * Charged as output, which is the expensive half. Effort is set as low as the
 * model allows, and the work itself is already done — this is the writing.
 */
const THINKING_TOKENS = 400;

/** The player's own moves in an ordinary game. Half of about seventy plies. */
export const MOVES_PER_GAME = 35;

const tokens = (chars) => chars / CHARS_PER_TOKEN;

/**
 * Input and output tokens for one game, per request and in total.
 *
 * Exported for the tests, which pin the arithmetic rather than the constants:
 * the numbers above will drift, and a test that asserts a price in dollars
 * would then be wrong in a way that looks like a failure.
 */
export function tokensForGame({ moves = MOVES_PER_GAME, thinks = false } = {}) {
  const requests = Math.max(1, Math.ceil(moves / CHUNK_SIZE));
  const perRequest = moves / requests;

  return {
    requests,
    input: requests * tokens(SYSTEM_CHARS + perRequest * DIGEST_CHARS_PER_MOVE),
    output:
      requests * (tokens(perRequest * ANSWER_CHARS_PER_MOVE) + (thinks ? THINKING_TOKENS : 0)),
  };
}

/**
 * Dollars per commented game, or null where there is nothing to charge.
 *
 * Null rather than zero for a free tier: "0,00 $" invites the reader to
 * conclude the quota is not a limit either, and the quota is the real limit
 * there.
 */
export function costPerGame(providerKey, model) {
  const adapter = providerFor(providerKey);
  const rates = adapter.pricing?.[model ?? adapter.models[0]];
  if (!rates) return null;

  const { input, output } = tokensForGame({
    thinks: Boolean(adapter.effort?.includes(model ?? adapter.models[0])),
  });
  return (input * rates.input + output * rates.output) / 1_000_000;
}

/**
 * "≈ 0,02 $ par partie", or the same figure for a hundred of them.
 *
 * Two decimals hides the difference between the cheapest model and the
 * dearest, which is the comparison the settings screen exists to make, so the
 * figure keeps enough digits to stay distinguishable and a hundred games is
 * offered beside it as the number with a familiar size.
 */
export function formatCost(dollars) {
  if (dollars === null || dollars === undefined) return null;
  const digits = dollars < 0.01 ? 4 : dollars < 1 ? 3 : 2;
  return `${dollars.toFixed(digits).replace(".", ",")} $`;
}
