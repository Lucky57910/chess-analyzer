import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api } from "../utils/api";

/**
 * The app's settings, which is what is left of the user.
 *
 * There is no account any more - the database is on the phone and belongs to
 * whoever unlocked it - so what used to be `useAuth` is now one row in a
 * key/value table holding a Chess.com username. Screens still need to know
 * whether that has been filled in, and that is the whole of it.
 */

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .settings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch((err) => {
        // Opening the database is the first native thing the app does. If it
        // fails, saying so beats a blank screen that looks like a slow load.
        if (!cancelled) setError(String(err.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch) => {
    const next = await api.updateSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const value = useMemo(
    () => ({ settings, loading, error, update, username: settings?.chess_com_username || "" }),
    [settings, loading, error, update],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}
