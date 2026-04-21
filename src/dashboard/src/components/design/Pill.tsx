import type { ReactNode } from 'react';

export type PillTone = 'default' | 'live' | 'red' | 'warn' | 'info';

const TONES: Record<PillTone, { bg: string; br: string; fg: string }> = {
  default: { bg: 'var(--bg-sunken)', br: 'var(--border)', fg: 'var(--fg-muted)' },
  live: {
    bg: 'color-mix(in oklab, var(--live) 15%, transparent)',
    br: 'color-mix(in oklab, var(--live) 30%, transparent)',
    fg: 'var(--live)',
  },
  red: {
    bg: 'var(--red-wash)',
    br: 'color-mix(in oklab, var(--red) 30%, transparent)',
    fg: 'var(--red)',
  },
  warn: {
    bg: 'color-mix(in oklab, var(--warn) 15%, transparent)',
    br: 'color-mix(in oklab, var(--warn) 30%, transparent)',
    fg: 'var(--warn)',
  },
  info: {
    bg: 'color-mix(in oklab, var(--info) 15%, transparent)',
    br: 'color-mix(in oklab, var(--info) 30%, transparent)',
    fg: 'var(--info)',
  },
};

export function Pill({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: PillTone;
}) {
  const t = TONES[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        background: t.bg,
        border: `1px solid ${t.br}`,
        color: t.fg,
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

const TIER_LABELS: Record<string, string> = {
  official: 'Official',
  partner: 'Partner',
  player: 'Player POV',
  community: 'Community',
  watch_party: 'Watch Party',
  // Pass-through for callers that already supply the labeled form.
  Official: 'Official',
  Partner: 'Partner',
  'Player POV': 'Player POV',
  Community: 'Community',
  'Watch Party': 'Watch Party',
};

type TierTone = 'red' | 'info' | 'live' | 'default';

const TIER_TONES: Record<string, TierTone> = {
  official: 'red',
  Official: 'red',
  partner: 'info',
  Partner: 'info',
  player: 'default',
  'Player POV': 'default',
  community: 'default',
  Community: 'default',
  watch_party: 'live',
  'Watch Party': 'live',
};

/**
 * Compact mono chip with tone-coded colors (v6 spec):
 *   Official → red · Partner → info · Watch Party → live (green)
 *   Player POV / Community → default neutral
 *
 * Designed to sit in narrow table cells (~110px) without wrapping —
 * replaces the larger generic <Pill> wrapper used in v5.
 */
export function TierBadge({ tier }: { tier: string }) {
  const tone = TIER_TONES[tier] ?? 'default';
  const bg =
    tone === 'red'
      ? 'color-mix(in oklab, var(--red) 14%, transparent)'
      : tone === 'info'
        ? 'color-mix(in oklab, var(--info) 14%, transparent)'
        : tone === 'live'
          ? 'color-mix(in oklab, var(--live) 14%, transparent)'
          : 'var(--bg-sunken)';
  const fg =
    tone === 'red'
      ? 'var(--red)'
      : tone === 'info'
        ? 'var(--info)'
        : tone === 'live'
          ? 'var(--live)'
          : 'var(--fg-muted)';
  const border =
    tone === 'red'
      ? 'color-mix(in oklab, var(--red) 30%, transparent)'
      : tone === 'info'
        ? 'color-mix(in oklab, var(--info) 30%, transparent)'
        : tone === 'live'
          ? 'color-mix(in oklab, var(--live) 30%, transparent)'
          : 'var(--border)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 3,
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
      }}
    >
      {TIER_LABELS[tier] ?? tier}
    </span>
  );
}
