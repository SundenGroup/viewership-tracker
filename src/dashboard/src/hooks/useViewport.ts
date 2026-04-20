import { useEffect, useState } from 'react';

/** Tracks viewport width and returns whether it's below the breakpoint. */
export function useViewportBelow(breakpoint = 768): boolean {
  const [below, setBelow] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setBelow(window.innerWidth < breakpoint);
    window.addEventListener('resize', update);
    update();
    return () => window.removeEventListener('resize', update);
  }, [breakpoint]);

  return below;
}
