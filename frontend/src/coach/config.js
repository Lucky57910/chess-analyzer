/**
 * Where the coach's settings live, and how they are read.
 *
 * Rows in the same key/value table that already holds the Chess.com username.
 * There is no server and no account, so there is nowhere else for them to be —
 * and no key is compiled into the APK: an API key baked into a sideloaded
 * binary is a key anyone with the file can extract and spend.
 *
 * A key per provider rather than one key. The default provider is a free tier
 * that answers "modèle surchargé" often enough to lose a commentary, and the
 * answer to that is a second key somewhere else — which only works if storing
 * one does not overwrite the other. The provider row says which is asked
 * first; `fallbacks` is every other provider that has a key, and `client.js`
 * walks that list when a provider will not answer.
 *
 * A note on the keys themselves. They sit in plain text in the app's private
 * SQLite database, which Android keeps inside the app sandbox, unreadable by
 * other apps on an unrooted phone and covered by the device's own disk
 * encryption. That is the same protection the game archive gets. It is *not*
 * protection against someone holding the unlocked phone, and it is not
 * encryption at rest with a separate secret. With a paid key now storable
 * here, that is worth saying twice — the settings screen says it too.
 */

import { DEFAULT_PROVIDER, PROVIDER_KEYS, providerFor } from "./providers.js";

export const SETTING_COACH_PROVIDER = "coach_provider";
export const SETTING_COACH_MODEL = "coach_model";
export const SETTING_COACH_FALLBACK = "coach_fallback";

/**
 * The one key row that predates per-provider storage.
 *
 * Read as the active provider's key when it has no row of its own, and never
 * written again. It is deliberately not migrated and deleted: the row costs
 * nothing, and an app that is sideloaded gets downgraded, which would
 * otherwise mean a user losing their key to an update they then rolled back.
 */
export const SETTING_COACH_KEY = "coach_api_key";

/** Where one provider's key lives. */
export const keySetting = (provider) => `${SETTING_COACH_KEY}_${provider}`;

/**
 * And where its model does.
 *
 * A model per provider for the same reason as a key per provider: a spare that
 * silently ran the most expensive model on the list would be a bill nobody
 * chose. `coach_model` remains as the pre-split row, read for the primary when
 * it has none of its own.
 */
export const modelSetting = (provider) => `${SETTING_COACH_MODEL}_${provider}`;

/** The stored model for a provider, or its default when the name went stale. */
function modelFor(adapter, stored) {
  // A stored name the adapter no longer offers is dropped rather than sent.
  // Providers retire a model generation by closing it to new keys, so the
  // phone that picked `gemini-2.5-flash` a month ago would otherwise keep
  // asking for it and keep getting a 400 that reads like a broken app.
  return adapter.models.includes(stored) ? stored : adapter.models[0];
}

/**
 * The settings as the network layer needs them, keys included.
 *
 * Only `api.coachGame` calls this. Everything that renders reads
 * `publicCoachConfig` instead, which has no key in it.
 */
export async function readCoachConfig(repo) {
  const provider = await repo.getSetting(SETTING_COACH_PROVIDER, DEFAULT_PROVIDER);
  const adapter = providerFor(provider);

  const keyFor = async (key) => {
    const own = await repo.getSetting(keySetting(key), "");
    if (own) return own;
    // The pre-split row belongs to whichever provider was active when it was
    // written, which is the one still selected.
    return key === adapter.key ? (await repo.getSetting(SETTING_COACH_KEY, "")) || "" : "";
  };

  const modelOf = async (key) => {
    const own = await repo.getSetting(modelSetting(key), "");
    const stored = own || (key === adapter.key ? await repo.getSetting(SETTING_COACH_MODEL, "") : "");
    return modelFor(providerFor(key), stored);
  };

  const fallbackOn = (await repo.getSetting(SETTING_COACH_FALLBACK, "1")) !== "0";

  const fallbacks = [];
  if (fallbackOn) {
    for (const key of PROVIDER_KEYS) {
      if (key === adapter.key) continue;
      const apiKey = await keyFor(key);
      if (apiKey) fallbacks.push({ provider: key, model: await modelOf(key), apiKey });
    }
  }

  return {
    provider: adapter.key,
    model: await modelOf(adapter.key),
    apiKey: await keyFor(adapter.key),
    fallback: fallbackOn,
    fallbacks,
  };
}

/**
 * The same settings, safe to hand to a screen.
 *
 * `key_set` and `keys` rather than the keys: the settings screen needs to know
 * which providers it can reach so it can say so, and it never needs to display
 * a secret. One that is never read back cannot be read off a screenshot, out
 * of a React tree, or out of a crash report.
 */
export async function publicCoachConfig(repo) {
  const { apiKey, fallbacks, ...rest } = await readCoachConfig(repo);
  const keys = {};
  const models = {};
  for (const key of PROVIDER_KEYS) {
    keys[key] = false;
    models[key] = providerFor(key).models[0];
  }
  keys[rest.provider] = Boolean(apiKey);
  models[rest.provider] = rest.model;
  for (const entry of fallbacks) {
    keys[entry.provider] = true;
    models[entry.provider] = entry.model;
  }

  // With the chain switched off, the other providers' rows are still stored
  // and still worth showing - the screen says they exist and that nothing is
  // going to use them.
  if (!rest.fallback) {
    for (const key of PROVIDER_KEYS) {
      if (key === rest.provider) continue;
      keys[key] = Boolean(await repo.getSetting(keySetting(key), ""));
      models[key] = modelFor(providerFor(key), await repo.getSetting(modelSetting(key), ""));
    }
  }

  return { ...rest, key_set: Boolean(apiKey), keys, models };
}

/**
 * Apply a patch from the settings screen.
 *
 * Two different intentions, and keeping them apart is what stops a paid
 * provider from being turned on by accident:
 *
 *   - `provider` means **make this the one asked first**. It is a decision
 *     about where every request goes and, on a paid key, about money.
 *   - `keyProvider` means **store this key and this model under that
 *     provider**, changing nothing about who is asked first. Pasting a Claude
 *     key so it can stand in for Gemini must not silently move every game onto
 *     Claude, which is exactly what a single selector did.
 *
 * The model always follows the provider it was chosen for, because a model
 * name belongs to one provider: `gemini-3.7-flash` sent to Claude is a 404
 * with a confusing message.
 *
 * An empty string for the key means "forget it", for the provider being edited
 * only; `undefined` means "leave it alone", which is what the screen sends
 * when the user edits anything else.
 */
export async function writeCoachConfig(repo, patch) {
  const provider =
    patch.keyProvider ??
    patch.provider ??
    (await repo.getSetting(SETTING_COACH_PROVIDER, DEFAULT_PROVIDER));
  const adapter = providerFor(provider);

  if (patch.provider !== undefined) {
    const next = providerFor(patch.provider).key;
    // Moving away is the last moment the pre-split rows' owner is known: they
    // belong to the provider being left. Left where they are, they would stop
    // being readable as anyone's, and the chain would lose a provider it can
    // reach.
    const leaving = await repo.getSetting(SETTING_COACH_PROVIDER, DEFAULT_PROVIDER);
    if (leaving !== next) {
      const legacyKey = await repo.getSetting(SETTING_COACH_KEY, "");
      if (legacyKey && !(await repo.getSetting(keySetting(leaving), ""))) {
        await repo.setSetting(keySetting(leaving), legacyKey);
      }
      const legacyModel = await repo.getSetting(SETTING_COACH_MODEL, "");
      if (legacyModel && !(await repo.getSetting(modelSetting(leaving), ""))) {
        await repo.setSetting(modelSetting(leaving), legacyModel);
      }
    }
    await repo.setSetting(SETTING_COACH_PROVIDER, next);
  }
  if (patch.model !== undefined) await repo.setSetting(modelSetting(adapter.key), patch.model);
  if (patch.fallback !== undefined) {
    await repo.setSetting(SETTING_COACH_FALLBACK, patch.fallback ? "1" : "0");
  }
  if (patch.apiKey !== undefined) {
    const value = patch.apiKey.trim();
    await repo.setSetting(keySetting(adapter.key), value);
    // Forgetting a key has to forget the pre-split row too, or the next read
    // hands the deleted key straight back.
    if (!value) await repo.setSetting(SETTING_COACH_KEY, "");
  }
}
