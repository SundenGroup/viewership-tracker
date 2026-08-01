import { useState, useEffect, useCallback, useRef } from 'react';
import { ApiError } from '@/services/api';

// ── Generic fetch hook ───────────────────────────────────────────────────

export interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export interface UseApiOptions {
  /**
   * Clear `data` to null whenever the deps change (NOT on manual refetch
   * or interval refresh). Turn this on when showing the previous keys'
   * data under the new key's header would be misleading — e.g. the series
   * editor, where a stale schedule under a new series name reads as "the
   * switch didn't work".
   */
  resetOnDepsChange?: boolean;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: UseApiOptions = {},
): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Response-race guard. Without it, an in-flight request for the OLD
  // deps (slow: cold cache can take 20s+) resolves after the new one and
  // clobbers the state — the visible bug was "switching series shows the
  // old schedule under the new name, forever". Only the latest request
  // may write; stale resolutions are dropped on the floor.
  const seqRef = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (mountedRef.current && seq === seqRef.current) {
        setData(result);
      }
    } catch (err) {
      if (mountedRef.current && seq === seqRef.current) {
        if (err instanceof ApiError) {
          setError(`${err.status}: ${err.message}`);
        } else {
          setError((err as Error).message);
        }
      }
    } finally {
      if (mountedRef.current && seq === seqRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    // seq > 0 means this is a deps CHANGE, not the initial mount.
    if (options.resetOnDepsChange && seqRef.current > 0) {
      setData(null);
    }
    fetchData();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

// ── Polling data hook (auto-refresh on interval) ─────────────────────────

export interface UsePollingOptions {
  intervalMs?: number;
  enabled?: boolean;
}

export function usePollingApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: UsePollingOptions = {},
): UseApiState<T> {
  const { intervalMs = 10_000, enabled = true } = options;
  const state = useApi(fetcher, deps);

  // Keep a ref to always call the latest refetch (avoids stale closure in setInterval)
  const refetchRef = useRef(state.refetch);
  refetchRef.current = state.refetch;

  useEffect(() => {
    if (!enabled) return;

    const handle = setInterval(() => {
      refetchRef.current();
    }, intervalMs);

    return () => clearInterval(handle);
  }, [enabled, intervalMs]);

  return state;
}
