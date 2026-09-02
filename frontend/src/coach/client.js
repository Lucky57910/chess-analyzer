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
 * And a chunk fails later than it used to. A 429, a 5xx and a request that
 * never arrived are all *the moment*, not the request: they are waited out,
 * and then handed to the next provider a key is stored for. The free tier this
 * app defaults to answers "modèle surchargé" often enough that a game took
 * several attempts to comment, and every one of those attempts was the app
 * repeating a message it could have acted on instead.
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
 * The providers to try, in order: the one chosen, then every other one a key
 * is stored for. Nothing is sent to the second until the first has run out of
 * retries — a spare wheel, not a race.
 */
export function providerChain(config) {
  return [
    { provider: config.provider, model: config.model, apiKey: config.apiKey },
    ...(config.fallbacks ?? []).filter((entry) => entry.apiKey),
  ];
}

/**
 * Every request a game would make, built but not sent.
 *
 * This is what lets the work leave the WebView. Android freezes a backgrounded
 * WebView, so "start it and put the phone away" means the posting has to
 * happen in a native foreground service — and the one thing that service must
 * not contain is judgment. So the chess, the digest, the prompt, the provider
 * shapes and the fallback order are all resolved here, into a list of chunks
 * each carrying its ordered attempts, and what crosses to Java is a URL, some
 * headers and a string of bytes.
 *
 * `skipPlies` is what a resumed run passes: a chunk whose moves are already
 * commented is not rebuilt, so finishing a commentary that half failed does
 * not pay for the half that worked.
 */
export function planGame({ game, analysis, config, skipPlies = [] }) {
  if (!config?.apiKey) throw new CoachError("Aucune clé API renseignée.");
  const done = new Set(skipPlies.map(Number));
  const chain = providerChain(config);

  return buildDigest({ game, analysis })
    .filter(({ plies }) => !plies.every((ply) => done.has(ply)))
    .map(({ plies, text }) => ({
      plies,
      attempts: chain.map(({ provider, model, apiKey }) => {
        const adapter = providerFor(provider);
        const { url, headers, data } = adapter.request({
          apiKey,
          model: model || adapter.models[0],
          system: SYSTEM_PROMPT,
          user: text,
          maxTokens: adapter.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        });
        // A string, not an object: the carrier writes bytes and is not asked
        // to have an opinion about JSON.
        return { provider, url, headers, body: JSON.stringify(data) };
      }),
    }));
}

/**
 * One answer that came back from somewhere else, turned into notes.
 *
 * The mirror of `planGame`: the service stores raw bodies, and every
 * provider-shaped decision — which field holds the text, is it wrapped in a
 * fence, is this ply one we asked about — is made back here, against the same
 * `validate` the foreground path uses.
 */
export function readChunk({ provider, status, body, plies }) {
  const adapter = providerFor(provider);
  const parsed = typeof body === "string" ? safeParse(body) : body;
  if (status >= 400 || parsed === null) {
    throw new CoachError(adapter.error?.(parsed) ?? `Le modèle a répondu ${status}`);
  }
  return validate(extractJson(adapter.text(parsed)), plies);
}

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

/**
 * A failure that is about the moment rather than about the request.
 *
 * Three of them, and telling them apart is the whole difference between a
 * coach that works and one that works two times in ten:
 *
 *   - `rate`: a 429. Our own window is respected, but the daily quota is a
 *     separate counter and the provider's minute does not start when ours
 *     does.
 *   - `overloaded`: a 500, 502, 503 or 504. The free tier answers this a lot,
 *     and it used to kill the chunk outright — "serveur surchargé, réessayez
 *     plus tard" was the app dutifully repeating a message it should have
 *     acted on.
 *   - `network`: the request never arrived. A phone changing cell or leaving
 *     wifi mid-commentary is not a reason to lose sixteen moves of it.
 *
 * All three are retried, and then handed to the next provider that has a key.
 * Anything else — a refused key, a model that does not exist, an answer that
 * will not parse — is a real failure and is raised as one.
 */
class Retriable extends Error {
  constructor(kind, { headers, message } = {}) {
    super(message ?? kind);
    this.kind = kind;
    this.headers = headers ?? {};
  }
}

/** What to tell the user when every provider has refused for this reason. */
const EXHAUSTED = {
  rate:
    "Quota du modèle atteint. Réessayez dans quelques minutes, ou ajoutez une clé " +
    "chez un autre fournisseur dans les réglages.",
  overloaded:
    "Le modèle est surchargé et l’est resté après plusieurs tentatives. Une clé " +
    "chez un second fournisseur évite d’attendre qu’il se libère.",
  network:
    "Le modèle est injoignable. Vérifiez la connexion du téléphone, puis relancez : " +
    "les coups déjà commentés sont conservés.",
};

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
      maxTokens: adapter.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    });

    let response;
    try {
      response = await http.post({
        url,
        headers,
        data,
        connectTimeout: 30_000,
        readTimeout: 90_000,
      });
    } catch (error) {
      // The transport threw: DNS, a dropped connection, a timeout. Nothing was
      // answered, so there is nothing to read and everything to retry.
      throw new Retriable("network", { message: String(error?.message ?? error) });
    }

    // The native layer parses JSON when the content type says so and hands
    // back a string when it does not, exactly as the Chess.com client found.
    const body = typeof response.data === "string" ? safeParse(response.data) : response.data;

    if (response.status === 401 || response.status === 403) {
      throw new CoachError("Clé API refusée. Vérifiez-la dans les réglages.");
    }
    if (response.status === 429) throw new Retriable("rate", { headers: response.headers });
    if (response.status >= 500) {
      throw new Retriable("overloaded", {
        headers: response.headers,
        message: adapter.error?.(body) ?? `Le modèle a répondu ${response.status}`,
      });
    }
    if (response.status >= 400) {
      throw new CoachError(adapter.error?.(body) ?? `Le modèle a répondu ${response.status}`);
    }
    return adapter.text(body);
  }

  return {
    /**
     * Comment one whole game.
     *
     * @returns {Promise<{notes: Record<number,string>, failed: number,
     *   providers: Record<string, number>}>}
     *   `notes` is keyed by ply. `failed` counts the chunks that did not come
     *   back — a partial commentary is still worth storing, and saying how
     *   partial it is beats pretending it is complete. `providers` counts the
     *   chunks each provider answered, so a screen can say what was spent
     *   where rather than only that something was.
     */
    async commentGame({
      game,
      analysis,
      config,
      skipPlies = [],
      onProgress,
      onWait,
      onFallback,
      onChunk,
    }) {
      if (!config?.apiKey) throw new CoachError("Aucune clé API renseignée.");

      const done = new Set(skipPlies.map(Number));
      const chunks = buildDigest({ game, analysis }).filter(
        ({ plies }) => !plies.every((ply) => done.has(ply)),
      );
      if (!chunks.length) throw new CoachError("Cette partie n’a aucun coup à commenter.");

      const chain = providerChain(config);

      // A window per provider, per call. Per provider because their limits are
      // separate counters; per call because the coach is only ever driven from
      // one screen, and a limiter that outlived its request would hold a fresh
      // commentary back for a minute after an unrelated one finished.
      const limiters = new Map(
        chain.map(({ provider }) => [
          provider,
          createLimiter({ rpm: providerFor(provider).rpm ?? 10, now, sleep: wait }),
        ]),
      );

      const notes = {};
      // Counted, not just listed: one of these providers may be billed by the
      // token, and "some of this was written by Claude" is a different thing
      // to be told than "three of the four chunks were".
      const used = {};
      let failed = 0;

      for (const [index, { plies, text }] of chunks.entries()) {
        try {
          const { answer, provider } = await send({ chain, user: text, limiters, onWait, onFallback });
          used[provider] = (used[provider] ?? 0) + 1;
          const written = validate(extractJson(answer), plies);
          Object.assign(notes, written);
          // Handed over as it arrives, so leaving the screen costs at most the
          // chunk in flight. A commentary written and then lost to a phone
          // call was paid for twice.
          await onChunk?.(written);
        } catch (error) {
          // One refused chunk must not cost the moves an earlier one already
          // produced. A key that is wrong fails on the first chunk and then on
          // every one after it, which the count makes obvious.
          failed += 1;
          if (failed === chunks.length) throw error;
        }
        onProgress?.(index + 1, chunks.length);
      }

      return { notes, failed, providers: used };
    },
  };

  /**
   * One chunk: retried where retrying can work, then moved to the next
   * provider rather than lost.
   *
   * Both halves earn their keep. The limiter should make a 429 rare — but
   * "rare" is not "never", and waiting out one or two is cheaper than throwing
   * away sixteen moves of commentary. And an overloaded free tier is often
   * still overloaded after three waits, which is where the second key comes
   * in: another provider, same digest, same validation, and the reader cannot
   * tell which one answered.
   */
  async function send({ chain, user, limiters, onWait, onFallback }) {
    let last = null;

    for (const [rank, config] of chain.entries()) {
      if (rank > 0) onFallback?.(providerFor(config.provider).label, last?.kind ?? null);

      for (let attempt = 0; ; attempt += 1) {
        await limiters.get(config.provider).take();
        try {
          return { answer: await post({ ...config, user }), provider: config.provider };
        } catch (error) {
          // A refused key or an unparseable answer is not the moment's fault
          // and will fail the same way on every retry and every provider.
          if (!(error instanceof Retriable)) throw error;
          last = error;
          if (attempt >= MAX_RETRIES) break;
          // No extra penalty on the limiter: the rejected request is already
          // in its window, and stacking a full-window wait on top of the retry
          // delay would sit out ninety seconds for one 429.
          const delay = retryDelay(error.headers, attempt);
          onWait?.(Math.round(delay / 1000));
          await wait(delay);
        }
      }
    }

    throw new CoachError(EXHAUSTED[last?.kind] ?? EXHAUSTED.overloaded);
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
