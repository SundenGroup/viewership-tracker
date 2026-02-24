import { useState, useEffect, useCallback, useRef } from 'react';
import { ApiError } from '@/services/api';

// ── Generic fetch hook ───────────────────────────────────────────────────

export interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (mountedRef.current) {
        setData(result);
      }
    } catch (err) {
      if (mountedRef.current) {
        if (err instanceof ApiError) {
          setError(`${err.status}: ${err.message}`);
        } else {
          setError((err as Error).message);
        }
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => {
      mountedRef.current = false;
    };
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
