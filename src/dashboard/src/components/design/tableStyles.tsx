/**
 * Shared Discover table primitives — one header/cell style (previously
 * three diverged copies) and a horizontal-scroll wrapper so wide tables
 * scroll inside their card instead of forcing whole-page overflow on
 * phones.
 */

import type { CSSProperties, ReactNode } from 'react';

export const thStyle: CSSProperties = {
  padding: '8px 6px',
  textAlign: 'left',
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

export const tdStyle: CSSProperties = {
  padding: '12px 6px',
};

export const numTdStyle: CSSProperties = {
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
};

/** Wrap any wide <table> so it scrolls inside its own card on phones. */
export function TableScroll({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', ...style }}>{children}</div>;
}

/**
 * Keyboard/a11y props for a clickable table row: focusable, announced as
 * a link, Enter/Space activates. Spread onto the <tr> next to onClick.
 */
export function rowLinkProps(label: string, onActivate: () => void) {
  return {
    role: 'link' as const,
    tabIndex: 0,
    'aria-label': label,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
