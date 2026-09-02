import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { getApi } from "../utils/api";

/**
 * Drives the analysis queue while the app is open.
 *
 * The server ran this as a background job every five seconds. Android will not
 * allow that without a foreground service, so the work happens here, in front
 * of the user, with progress on screen - which is also the honest version: the
 * phone is doing something expensive and the battery will show it.
 *
 * There is exactly one runner. Stockfish has one search state, and two screens
 * each draining the queue would interleave into nonsense, so this lives in a
 * provider rather than in each page that wants it.
 */

const QueueContext = createContext(null);

const IDLE = { running: false, processed: 0, current: null, progress: null, error: null };

export function QueueProvider({ children }) {
  const [state, setState] = useState(IDLE);
  const [status, setStatus] = useState(null);
  const abortRef = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const { api } = await getApi();
      const next = await api.syncStatus();
      if (mounted.current) setStatus(next);
      return next;
    } catch (error) {
      if (mounted.current) setState((s) => ({ ...s, error: String(error.message ?? error) }));
      return null;
    }
  }, []);

  // Once, on opening: a pass interrupted by the app closing leaves its game
  // marked running, and nothing else would ever hand it back. Doing it before
  // the first status read is what keeps the badge honest - otherwise the
  // screen says "en analyse" about a runner that no longer exists.
  useEffect(() => {
    (async () => {
      try {
        const { api } = await getApi();
        await api.reclaimStuck();
      } catch {
        // A database that will not answer here will say so on the next call;
        // failing to tidy up is not a reason to refuse to show the queue.
      }
      refreshStatus();
    })();
  }, [refreshStatus]);

  const start = useCallback(async () => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...IDLE, running: true });

    try {
      const { sync } = await getApi();
      await sync.runQueue({
        signal: controller.signal,
        onProgress: (done, total) => {
          if (mounted.current) setState((s) => ({ ...s, progress: { done, total } }));
        },
        onGame: (outcome, processed) => {
          if (mounted.current) {
            setState((s) => ({ ...s, processed, current: outcome.gameId, progress: null }));
          }
          refreshStatus();
        },
      });
    } catch (error) {
      if (mounted.current) setState((s) => ({ ...s, error: String(error.message ?? error) }));
    } finally {
      abortRef.current = null;
      if (mounted.current) setState((s) => ({ ...s, running: false, progress: null }));
      refreshStatus();
    }
  }, [refreshStatus]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const value = useMemo(
    () => ({ ...state, status, start, stop, refreshStatus }),
    [state, status, start, stop, refreshStatus],
  );
  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue() {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error("useQueue must be used inside QueueProvider");
  return ctx;
}
