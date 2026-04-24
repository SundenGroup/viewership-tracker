import { useEffect, useState } from 'react';

/**
 * Re-renders the consumer every `intervalMs` and returns the current epoch
 * millis. Use for anything that ticks against Date.now() — e.g. the
 * broadcast-duration pill ("LIVE · 4H 11M") which needs to tick up every
 * minute without a page refresh.
 *
 * Defaults to 30s, which matches the polling cadence so there's at most
 * one extra render per poll cycle.
 */
export function useNow(intervalMs: number = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
