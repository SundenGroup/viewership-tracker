/**
 * BackToTop — appears once the page has scrolled a screen or two (long
 * leaderboards, the review queue) and returns to the top in one tap.
 */
import { useEffect, useState } from 'react';
import { IconArrowUp } from './icons';

export function BackToTop({ threshold = 900 }: { threshold?: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  if (!show) return null;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <button
      type="button"
      className="btn"
      aria-label="Back to top"
      title="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })}
      style={{
        position: 'fixed',
        right: 18,
        bottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
        zIndex: 25,
        width: 36,
        height: 36,
        padding: 0,
        justifyContent: 'center',
        borderRadius: 999,
        boxShadow: 'var(--shadow-md, 0 6px 20px rgba(0,0,0,0.25))',
      }}
    >
      <IconArrowUp size={14} />
    </button>
  );
}
