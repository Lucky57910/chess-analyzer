/**
 * Staying under a free tier's requests-per-minute, without paying for it in
 * latency when there is nothing to stay under.
 *
 * The naive version — sleep `60/rpm` seconds between every call — costs six
 * seconds per request on Gemini Flash's ten a minute, which is six seconds
 * added to a commentary that would otherwise have been instant. It spends the
 * budget it is supposed to protect.
 *
 * A sliding window spends nothing in the normal case. It remembers when the
 * last `rpm` requests went out; if fewer than that happened in the past
 * minute, the next one leaves immediately. Only a burst that would genuinely
 * cross the line waits, and it waits exactly until the oldest request falls
 * out of the window.
 *
 * `now` and `sleep` are injected so the tests can drive a whole minute of
 * traffic without taking a minute.
 */
export function createLimiter({
  rpm,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const window = [];

  return {
    /** Resolves when it is this caller's turn, and records the departure. */
    async take() {
      for (;;) {
        const cutoff = now() - 60_000;
        while (window.length && window[0] <= cutoff) window.shift();
        if (window.length < rpm) {
          window.push(now());
          return;
        }
        // Wait for the oldest request in the window to age out, plus a
        // margin: the provider's clock is not ours, and arriving one
        // millisecond early is a 429.
        await sleep(window[0] - cutoff + 250);
      }
    },
  };
}

/**
 * How long to wait before retrying a rejected request.
 *
 * `Retry-After` is a count of seconds or an HTTP date; providers send either,
 * and Gemini often sends neither. The cap matters more than the precision — a
 * quota that resets tomorrow reports a delay nobody is going to sit through,
 * and the honest answer there is to fail and say so rather than to hold the
 * screen for an hour.
 */
export function retryDelay(headers = {}, attempt = 0, max = 30_000) {
  const raw =
    headers["retry-after"] ?? headers["Retry-After"] ?? headers["retry_after"] ?? null;

  if (raw != null) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, max);
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), max);
  }
  // No header: back off geometrically from two seconds.
  return Math.min(2000 * 2 ** attempt, max);
}
