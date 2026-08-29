/**
 * Turning a stored analysis into a coach's commentary.
 *
 * The engine already knows what every move cost. What it cannot do is say why
 * it cost that, in a sentence aimed at the person who played it — "tu
 * développes vite mais ton roi reste au centre trois coups de trop" is not a
 * number Stockfish computes.
 *
 * So a handful of requests per game, carrying nothing but the facts from
 * `digest.js`, and an answer that is checked before it is believed:
 *
 *   - the reply must be JSON with a `comments` array;
 *   - a comment for a ply that was not asked about is dropped;
 *   - a comment longer than the cap is dropped rather than truncated, because
 *     a sentence cut mid-word reads as a bug in the app rather than as a limit
 *     of the model;
 *   - a chunk that fails leaves the others standing.
 *
 * Nothing here is required for the app to work. Without a key, `narrate.js`
 * keeps saying what the engine found, exactly as before — the coach is a layer
 * on top of that, never a replacement for it.
 */

import { buildDigest } from "./digest.js";
import { RESPONSE_SCHEMA_HINT, providerFor } from "./providers.js";
import { createLimiter, retryDelay } from "./throttle.js";

/** Longest a single comment may be. Two or three sentences. */
export const MAX_COMMENT_CHARS = 400;

/**
 * Output room per request.
 *
 * Sized from what is actually asked for: a chunk of 24 moves, most of them
 * quiet and answered in one short sentence, a handful judged and answered in
 * three. That lands near 2,600 tokens of French; 4,000 leaves the margin that
 * keeps a long game from being truncated into an unparseable answer, which is
 * the failure that costs a whole chunk.
 */
const MAX_OUTPUT_TOKENS = 4000;

/** How many times to sit out a 429 before giving up on a chunk. */
const MAX_RETRIES = 2;

export class CoachError extends Error {}

/**
 * The instructions, which are mostly a list of things not to do.
 *
 * A model handed a chess position will produce plausible chess prose whether
 * or not it has understood anything, and a wrong variation stated in the voice
 * of a coach is worse than no coach: the player will try it. Hence the first
 * rule, and hence the digest.
 *
 * The length rule is graded rather than fixed. Every move gets a comment —
 * that is the point of the feature — but a developing move does not need three
 * sentences, and asking for three produces filler that reads as padding and
 * costs output tokens on every request.
 */
export const SYSTEM_PROMPT = [
  "Tu es un entraîneur d’échecs francophone. Tu commentes une partie déjà analysée par Stockfish.",
  "",
  "Règles absolues :",
  "- N’utilise QUE les faits fournis. N’invente aucun coup, aucune variante, aucune évaluation, aucun nom d’ouverture.",
  "- Reprends la notation des coups exactement telle qu’elle est écrite dans les faits.",
  "- Tutoie le joueur.",
  "- Dis POURQUOI, pas seulement QUOI : ce que le coup prépare, ce qu’il oublie, ce qu’il fallait voir.",
  "- Quand le temps de réflexion explique la faute, dis-le : un coup grave joué en deux secondes est une habitude, pas une erreur de calcul.",
  "- Quand un fait de structure est donné (roi non roqué, pions doublés, pièces non développées), rattache-le au coup au lieu de le répéter tel quel.",
  "- Aucun markdown, aucune liste, aucun emoji, aucun titre.",
  "",
  "Longueur, selon le coup :",
  "- Coup jugé (imprécision, erreur, gaffe) : deux à trois phrases. Nomme l’idée à retenir, pas seulement la perte en centipions.",
  "- Meilleur coup du moteur : une phrase qui dit ce qu’il accomplit.",
  "- Coup ordinaire : une phrase courte sur son rôle dans le plan. Pas de remplissage, pas de félicitations creuses.",
  "- Jamais plus de 400 caractères.",
  "",
  `Réponds uniquement par cet objet JSON : ${RESPONSE_SCHEMA_HINT}`,
  "Un objet par coup fourni, dans le même ordre, avec le même numéro de ply.",
].join("\n");

/**
 * Pull the JSON out of an answer.
 *
 * `responseMimeType` and `response_format` make this unnecessary on a good
 * day. This is for the other days: a model that wrapped the object in a fenced
 * block, or prefaced it with a sentence.
 */
export function extractJson(text) {
  if (!text) throw new CoachError("Réponse vide du modèle");
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new CoachError("Réponse illisible du modèle");
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new CoachError("Réponse illisible du modèle");
  }
}

/**
 * Keep the comments that answer the question that was asked.
 *
 * Anything for a ply outside `plies` is a hallucinated move number, and a
 * comment that long stopped being a comment. Both are dropped silently: the
 * screen falls back to the engine's own sentences for that move, which is a
 * worse answer, not a broken one.
 */
export function validate(payload, plies) {
  const allowed = new Set(plies);
  const notes = {};
  for (const comment of payload?.comments ?? []) {
    const ply = Number(comment?.ply);
    const text = typeof comment?.text === "string" ? comment.text.trim() : "";
    if (!allowed.has(ply) || !text || text.length > MAX_COMMENT_CHARS) continue;
    notes[ply] = text;
  }
  return notes;
}

/** A 429 is a wait, not a failure, until it has been waited out twice. */
class RateLimited extends Error {
  constructor(headers) {
    super("rate limited");
    this.headers = headers ?? {};
  }
}

/**
 * @param {object} http A CapacitorHttp-shaped client: `post({url, headers, data})`
 *   returning `{status, data, headers}`. Injected for the same reason the
 *   Chess.com client injects one — so this module can be tested without a
 *   device and without a key.
 * @param {object} [options] `sleep` and `now` are injected so the throttling
 *   tests can drive a minute of traffic in a millisecond.
 */
export function createCoach(http, { sleep, now } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function post({ provider, apiKey, model, user }) {
    const adapter = providerFor(provider);
    const { url, headers, data } = adapter.request({
      apiKey,
      model: model || adapter.models[0],
      system: SYSTEM_PROMPT,
      user,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    const response = await http.post({
      url,
      headers,
      data,
      connectTimeout: 30_000,
      readTimeout: 90_000,
    });

    // The native layer parses JSON when the content type says so and hands
    // back a string when it does not, exactly as the Chess.com client found.
    const body = typeof response.data === "string" ? safeParse(response.data) : response.data;

    if (response.status === 401 || response.status === 403) {
      throw new CoachError("Clé API refusée. Vérifiez-la dans les réglages.");
    }
    if (response.status === 429) throw new RateLimited(response.headers);
    if (response.status >= 400) {
      throw new CoachError(adapter.error?.(body) ?? `Le modèle a répondu ${response.status}`);
    }
    return adapter.text(body);
  }

  return {
    /**
     * Comment one whole game.
     *
     * @returns {Promise<{notes: Record<number,string>, failed: number}>}
     *   `notes` is keyed by ply. `failed` counts the chunks that did not come
     *   back — a partial commentary is still worth storing, and saying how
     *   partial it is beats pretending it is complete.
     */
    async commentGame({ game, analysis, config, onProgress, onWait }) {
      if (!config?.apiKey) throw new CoachError("Aucune clé API renseignée.");

      const chunks = buildDigest({ game, analysis });
      if (!chunks.length) throw new CoachError("Cette partie n’a aucun coup à commenter.");

      // A window per call, not per app: the coach is only ever driven from one
      // screen, and a limiter that outlives the request it protects would hold
      // a fresh commentary back for a minute after an unrelated one finished.
      const limiter = createLimiter({
        rpm: providerFor(config.provider).rpm ?? 10,
        now,
        sleep: wait,
      });

      const notes = {};
      let failed = 0;

      for (const [index, { plies, text }] of chunks.entries()) {
        try {
          const answer = await send({ config, user: text, limiter, onWait });
          Object.assign(notes, validate(extractJson(answer), plies));
        } catch (error) {
          // One refused chunk must not cost the moves an earlier one already
          // produced. A key that is wrong fails on the first chunk and then on
          // every one after it, which the count makes obvious.
          failed += 1;
          if (failed === chunks.length) throw error;
        }
        onProgress?.(index + 1, chunks.length);
      }

      return { notes, failed };
    },
  };

  /**
   * One chunk, through the limiter, retrying a 429 rather than losing the
   * chunk to it.
   *
   * The limiter should make a 429 rare — but "rare" is not "never": the daily
   * quota is a separate counter, another app may share the project, and the
   * provider's minute does not start when ours does. Waiting out one or two is
   * cheaper than throwing away sixteen moves of commentary.
   */
  async function send({ config, user, limiter, onWait }) {
    for (let attempt = 0; ; attempt += 1) {
      await limiter.take();
      try {
        return await post({ ...config, user });
      } catch (error) {
        if (!(error instanceof RateLimited)) throw error;
        if (attempt >= MAX_RETRIES) {
          throw new CoachError(
            "Quota du modèle atteint. Réessayez dans quelques minutes, ou passez à un modèle " +
              "à quota plus large dans les réglages.",
          );
        }
        // No extra penalty on the limiter: the rejected request is already in
        // its window, and stacking a full-window wait on top of the retry
        // delay would sit out ninety seconds for one 429.
        const delay = retryDelay(error.headers, attempt);
        onWait?.(Math.round(delay / 1000));
        await wait(delay);
      }
    }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
