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
  player: 'Player',
  community: 'Community',
  watch_party: 'Watch Party',
};

export function TierBadge({ tier }: { tier: string }) {
  return <Pill>{TIER_LABELS[tier] ?? tier}</Pill>;
}
