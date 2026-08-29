/**
 * Where the coach's words come from.
 *
 * The app is free and sideloaded, so the default has to be a model with a free
 * tier and a key anyone can get without a card: Google's AI Studio key, which
 * allows about a thousand requests a day on Gemini Flash. A game costs two or
 * three of them.
 *
 * Two adapters rather than one, because the choice is the part most likely to
 * change: a free tier can be withdrawn, and a paid key may later be worth it.
 * Each adapter is a request shape and a way to find the text in the answer —
 * everything above them (the digest, the prompt, the validation, the storage)
 * is provider-agnostic, so adding Claude or OpenAI later is a third entry
 * here and nothing else.
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
    label: "Google Gemini",
    free: true,
    keyUrl: "https://aistudio.google.com/apikey",
    // Free tier as of 2026: ~15 requests a minute and ~1000 a day on
    // Flash-Lite, fewer on Flash. Flash writes noticeably better French, and a
    // game is two or three requests, so Flash is the default and Flash-Lite is
    // the one to fall back to if the daily quota ever bites.
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    // The free tier's requests per minute, for the limiter. The lower of the
    // two models is used for both: guessing high costs a 429, guessing low
    // costs nothing at the volume one person reviewing games produces.
    rpm: 10,
    note:
      "Clé gratuite sur aistudio.google.com, sans carte bancaire. Environ 1000 requêtes " +
      "par jour ; une partie en consomme deux ou trois.",

    request({ apiKey, model, system, user, maxTokens }) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        data: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: maxTokens,
            // Asking for JSON at the transport level rather than only in the
            // prompt: it is the difference between parsing an answer and
            // parsing an answer wrapped in ```json.
            responseMimeType: "application/json",
          },
        },
      };
    },

    text(body) {
      const parts = body?.candidates?.[0]?.content?.parts ?? [];
      return parts
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
      "google/gemini-2.0-flash-exp:free",
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
};

export const DEFAULT_PROVIDER = "gemini";

export function providerFor(key) {
  return PROVIDERS[key] ?? PROVIDERS[DEFAULT_PROVIDER];
}
