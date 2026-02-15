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

  useEffect(() => {
    if (!enabled) return;

    const handle = setInterval(() => {
      state.refetch();
    }, intervalMs);

    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  return state;
}
