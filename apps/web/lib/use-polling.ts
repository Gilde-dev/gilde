'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Polling<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Calls `fn` on mount and every `intervalMs`. Ticks are skipped while the tab is hidden and
 * a fetch runs as soon as it becomes visible again. Only the latest request may update state.
 * Pass a stable `fn` (useCallback): a new identity restarts polling and clears the data.
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number): Polling<T> {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });
  const latest = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async () => {
    const id = ++latest.current;
    try {
      const data = await fnRef.current();
      if (id === latest.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (id === latest.current) {
        setState((s) => ({ ...s, error: e instanceof Error ? e : new Error(String(e)), loading: false }));
      }
    }
  }, []);

  useEffect(() => {
    setState((s) => (s.data === undefined && s.loading ? s : { data: undefined, error: null, loading: true }));
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      latest.current++; // drop anything still in flight
    };
  }, [fn, intervalMs, refresh]);

  return { ...state, refresh };
}
