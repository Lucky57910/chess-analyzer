/**
 * Where the coach's words come from.
 *
 * The app is free and sideloaded, so the default has to be a model with a free
 * tier and a key anyone can get without a card: Google's AI Studio key, which
 * allows about a thousand requests a day on Gemini Flash. A game costs two or
 * three of them.
 *
 * Three adapters rather than one, because the choice is the part most likely
 * to change: a free tier can be withdrawn, and a paid key may later be worth
 * it. Each adapter is a request shape and a way to find the text in the answer
 * — everything above them (the digest, the prompt, the validation, the
 * storage) is provider-agnostic, so a fourth is an entry here and nothing
 * else.
 *
 * They are also each other's spare. The free tier that is the default answers
 * "modèle surchargé" often enough that a game took several attempts to
 * comment; `client.js` moves to the next provider that has a key rather than
 * losing the chunk, which is what a second key is for. What differs between
 * them is what a request costs: the free ones cost a quota, and `pricing` on a
 * paid one is what `cost.js` turns into a figure per game.
 *
 * There is no key in this repository and none in the APK. The user pastes
 * their own into the settings screen, where it is stored in the same local
 * SQLite as everything else on the phone.
 */

/** A JSON object with one comment per requested ply. */
export const RESPONSE_SCHEMA_HINT =
  '{"comments":[{"ply":<entier>,"text":"<commentaire>"}]}';

export const PROVIDERS = {
  gemini: {
    key: "gemini",
    label: "Gemini",
    free: true,
    keyUrl: "https://aistudio.google.com/apikey",
    // Free tier as of 2026, over the Interactions API. Flash writes better
    // French than Flash-Lite, and a game is two or three requests, so Flash is
    // the default and Flash-Lite is what to fall back to if the daily quota
    // ever bites.
    //
    // These names go stale on their own: Google closes a generation to new
    // keys rather than migrating it, and the failure is a 400 saying the model
    // "is no longer available to new users". `readCoachConfig` therefore drops
    // a stored model that is no longer listed here rather than sending it.
    models: ["gemini-3.7-flash", "gemini-3.5-flash-lite"],
    // The free tier's requests per minute, for the limiter. Guessing high
    // costs a 429, guessing low costs nothing at the volume one person
    // reviewing their own games produces.
    rpm: 10,
    note:
      "Clé gratuite sur aistudio.google.com, sans carte bancaire. Le quota du jour est " +
      "affiché là-bas ; une partie en consomme deux ou trois.",

    request({ apiKey, model, system, user, maxTokens }) {
      return {
        // The Interactions API, not `:generateContent`. The older endpoint
        // still answers, but Gemini 3.x is documented against this one and it
        // is where the model name lives in the body rather than in the path.
        url: "https://generativelanguage.googleapis.com/v1beta/interactions",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        data: {
          model,
          system_instruction: system,
          input: user,
          // Asking for JSON at the transport level rather than only in the
          // prompt: it is the difference between parsing an answer and
          // parsing an answer wrapped in ```json.
          response_format: { type: "text", mime_type: "application/json" },
          generation_config: {
            max_output_tokens: maxTokens,
            // 3.x thinks by default and the thinking is spent out of the same
            // output budget. Stockfish already did the analysis; what is left
            // here is writing it down in French.
            thinking_level: "low",
            // No temperature, top_p or top_k: 3.x rejects the sampling
            // parameters outright.
          },
        },
      };
    },

    /**
     * The answer is a timeline of steps, not one candidate.
     *
     * Only the model's output is wanted — a thinking step carries text too,
     * and concatenating it produces a JSON parse failure rather than a
     * comment. The fallback to every step exists because the shape of this
     * timeline has already changed once.
     */
    text(body) {
      const steps = body?.steps ?? [];
      const output = steps.filter((step) => step.type === "model_output");
      return (output.length ? output : steps)
        .flatMap((step) => step.content ?? [])
        .filter((part) => part.type === undefined || part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    },

    error(body) {
      return body?.error?.message ?? null;
    },
  },

  openrouter: {
    key: "openrouter",
    label: "OpenRouter",
    free: true,
    keyUrl: "https://openrouter.ai/keys",
    // The `:free` suffix is OpenRouter's own marker for a model served at no
    // cost. Which ones exist changes; these are only the defaults offered.
    models: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "deepseek/deepseek-chat-v3-0324:free",
    ],
    rpm: 20,
    note:
      "Les modèles suffixés « :free » sont gratuits, avec une limite de requêtes " +
      "par jour. Utile pour comparer plusieurs modèles avec une seule clé.",

    request({ apiKey, model, system, user, maxTokens }) {
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data: {
          model,
          temperature: 0.4,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
      };
    },

    text(body) {
      return (body?.choices?.[0]?.message?.content ?? "").trim();
    },

    error(body) {
      return body?.error?.message ?? null;
    },
  },

  anthropic: {
    key: "anthropic",
    label: "Claude",
    free: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    // Paid, and priced per million tokens, so the models carry their rates
    // and `cost.js` turns them into a figure per game. No free tier: the key
    // is bought with a card, which is the reason this is not the default.
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    pricing: {
      // $ per million tokens, input / output. From the published API rates.
      "claude-opus-5": { input: 5, output: 25 },
      "claude-sonnet-5": { input: 2, output: 10 },
      "claude-haiku-4-5": { input: 1, output: 5 },
    },
    // `output_config.effort` is rejected by Haiku 4.5, and this whole request
    // is one short French paragraph per move over facts that are already
    // computed - so where it is accepted it is set as low as it goes.
    effort: ["claude-opus-5", "claude-sonnet-5"],
    // Thinking is on by default on these models and is spent out of the same
    // output budget, so the cap has to leave room for it or the answer is
    // truncated into something unparseable.
    maxOutputTokens: 8000,
    // Well under the 50/min of the first paid tier.
    rpm: 30,
    note:
      "Palier payant, sans quota gratuit : la clé se crée sur console.anthropic.com " +
      "avec une carte. Rien n’est utilisé pour entraîner les modèles. Le coût par " +
      "partie est affiché sous le modèle.",

    request({ apiKey, model, system, user, maxTokens }) {
      const adapter = PROVIDERS.anthropic;
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        data: {
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          ...(adapter.effort.includes(model)
            ? { output_config: { effort: "low" } }
            : {}),
        },
      };
    },

    /** Text blocks only: a thinking block carries text too, and is not it. */
    text(body) {
      return (body?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
    },

    error(body) {
      return body?.error?.message ?? null;
    },
  },
};

export const DEFAULT_PROVIDER = "gemini";

export function providerFor(key) {
  return PROVIDERS[key] ?? PROVIDERS[DEFAULT_PROVIDER];
}

/** The providers, in the order the settings screen offers them. */
export const PROVIDER_KEYS = Object.keys(PROVIDERS);
