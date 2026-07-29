/**
 * RangePill — the ONE toggle-pill button for Discover range pickers,
 * filters and pagination. Previously four diverged copies lived in
 * ChannelPage / TrendsTab / ChannelsTab (different padding, tracking and
 * inactive backgrounds); every toggle now looks and behaves identically.
 */

import type { ReactNode } from 'react';

export function RangePill({
  children,
  active,
  onClick,
  title,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        minHeight: 28,
        padding: '4px 12px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
        background: active
          ? 'var(--red-wash, color-mix(in oklab, var(--red) 12%, transparent))'
          : 'transparent',
        color: active ? 'var(--red)' : 'var(--fg-muted)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}
