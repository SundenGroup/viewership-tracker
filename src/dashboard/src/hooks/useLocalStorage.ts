import { useState, useEffect, useCallback } from 'react';

/**
 * A drop-in replacement for useState that persists the value in localStorage.
 * Reads from localStorage on mount; writes on every state change.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      return item !== null ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  // Write to localStorage whenever the value changes
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // Storage full or unavailable — silently ignore
    }
  }, [key, storedValue]);

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue(value);
    },
    [],
  );

  return [storedValue, setValue];
}
