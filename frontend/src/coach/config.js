/**
 * Where the coach's settings live, and how they are read.
 *
 * Three rows in the same key/value table that already holds the Chess.com
 * username. There is no server and no account, so there is nowhere else for
 * them to be — and no key is compiled into the APK: an API key baked into a
 * sideloaded binary is a key anyone with the file can extract and spend.
 *
 * A note on the key itself. It sits in plain text in the app's private SQLite
 * database, which Android keeps inside the app sandbox, unreadable by other
 * apps on an unrooted phone and covered by the device's own disk encryption.
 * That is the same protection the game archive gets. It is *not* protection
 * against someone holding the unlocked phone, and it is not encryption at
 * rest with a separate secret — if a paid key ever goes in here, that is the
 * moment to move it behind the Android keystore.
 */

import { DEFAULT_PROVIDER, providerFor } from "./providers.js";

export const SETTING_COACH_PROVIDER = "coach_provider";
export const SETTING_COACH_MODEL = "coach_model";
export const SETTING_COACH_KEY = "coach_api_key";

/**
 * The settings as the network layer needs them, key included.
 *
 * Only `api.coach` calls this. Everything that renders reads `publicConfig`
 * instead, which has no key in it.
 */
export async function readCoachConfig(repo) {
  const provider = await repo.getSetting(SETTING_COACH_PROVIDER, DEFAULT_PROVIDER);
  const adapter = providerFor(provider);
  const stored = await repo.getSetting(SETTING_COACH_MODEL, "");
  return {
    provider: adapter.key,
    // A stored name the adapter no longer offers is dropped rather than sent.
    // Providers retire a model generation by closing it to new keys, so the
    // phone that picked `gemini-2.5-flash` a month ago would otherwise keep
    // asking for it and keep getting a 400 that reads like a broken app.
    model: adapter.models.includes(stored) ? stored : adapter.models[0],
    apiKey: (await repo.getSetting(SETTING_COACH_KEY, "")) || "",
  };
}

/**
 * The same settings, safe to hand to a screen.
 *
 * `coach_key_set` rather than the key: the settings screen needs to know
 * whether one is stored so it can say so, and it never needs to display it.
 * A secret that is never read back cannot be read off a screenshot, out of a
 * React tree, or out of a crash report.
 */
export async function publicCoachConfig(repo) {
  const { apiKey, ...rest } = await readCoachConfig(repo);
  return { ...rest, key_set: Boolean(apiKey) };
}

/**
 * Apply a patch from the settings screen.
 *
 * Changing provider drops the stored model, because a model name belongs to
 * one provider: `gemini-2.5-flash` sent to OpenRouter is a 404 with a
 * confusing message, and silently keeping it is how a working screen produces
 * an unexplainable failure two taps later.
 *
 * An empty string for the key means "forget it"; `undefined` means "leave it
 * alone", which is what the screen sends when the user edits anything else.
 */
export async function writeCoachConfig(repo, patch) {
  if (patch.provider !== undefined) {
    const adapter = providerFor(patch.provider);
    await repo.setSetting(SETTING_COACH_PROVIDER, adapter.key);
    if (patch.model === undefined) await repo.setSetting(SETTING_COACH_MODEL, "");
  }
  if (patch.model !== undefined) await repo.setSetting(SETTING_COACH_MODEL, patch.model);
  if (patch.apiKey !== undefined) await repo.setSetting(SETTING_COACH_KEY, patch.apiKey.trim());
}
