import { useState, useCallback, useRef, useEffect } from 'react';
import { ApiError } from '@/services/api';

export interface UseMutationReturn<TData, TArgs extends unknown[]> {
  mutate: (...args: TArgs) => Promise<TData | undefined>;
  loading: boolean;
  error: string | null;
  data: TData | null;
  reset: () => void;
}

export function useMutation<TData, TArgs extends unknown[]>(
  mutator: (...args: TArgs) => Promise<TData>,
): UseMutationReturn<TData, TArgs> {
  const [data, setData] = useState<TData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (...args: TArgs): Promise<TData | undefined> => {
      setLoading(true);
      setError(null);
      try {
        const result = await mutator(...args);
        if (mountedRef.current) {
          setData(result);
          setLoading(false);
        }
        return result;
      } catch (err) {
        if (mountedRef.current) {
          if (err instanceof ApiError) {
            setError(`${err.status}: ${err.message}`);
          } else {
            setError((err as Error).message);
          }
          setLoading(false);
        }
        return undefined;
      }
    },
    [mutator],
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { mutate, loading, error, data, reset };
}
