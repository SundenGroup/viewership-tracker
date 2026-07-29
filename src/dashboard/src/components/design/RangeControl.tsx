/**
 * RangeControl — THE time-window picker for Discover (and anywhere else).
 *
 * Before this, the same question ("what window am I looking at?") had four
 * different vocabularies: Channels said Now/24h/7d/Custom, Trends said
 * 1h…30d, the channel page said 24H/7D/30D, search had a days dropdown.
 * One component, one label set, one URL param (`range`) — so the choice
 * follows the user across tabs instead of resetting on every switch.
 *
 * Values are plain strings so surfaces can offer subsets:
 *   'now'                     live view (only where a live view exists)
 *   '1h' '6h' '24h' '7d' '30d' rolling windows ending now
 *   'custom'                  explicit from/to dates (where supported)
 */
import { Row } from './Layout';
import { RangePill } from './RangePill';

export type RangeKey = 'now' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';

export const RANGE_HOURS: Record<Exclude<RangeKey, 'now' | 'custom'>, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

export const RANGE_LABELS: Record<RangeKey, string> = {
  now: 'Now',
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  custom: 'Custom',
};

/** Sensible chart bucket for a window length (mirrors the old per-page tables). */
export function bucketSecondsFor(hours: number): number {
  if (hours <= 6) return 60;
  if (hours <= 24) return 300;
  if (hours <= 24 * 7) return 1800;
  return 3600;
}

/**
 * Resolve a range key to [from, to]. Returns null for 'now' (caller shows
 * the live view) and for an incomplete/invalid custom selection.
 */
export function resolveRange(
  key: RangeKey,
  customFrom?: string,
  customTo?: string,
): { from: Date; to: Date } | null {
  if (key === 'now') return null;
  if (key === 'custom') {
    if (!customFrom || !customTo) return null;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
    return { from, to };
  }
  const now = new Date();
  return { from: new Date(now.getTime() - RANGE_HOURS[key] * 3600_000), to: now };
}

/** Parse a ?range= value, falling back when the surface doesn't offer it. */
export function parseRangeKey(
  raw: string | null,
  offered: RangeKey[],
  fallback: RangeKey,
): RangeKey {
  return offered.includes(raw as RangeKey) ? (raw as RangeKey) : fallback;
}

export function RangeControl({
  options,
  value,
  onChange,
  eyebrow = 'When',
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
}: {
  options: RangeKey[];
  value: RangeKey;
  onChange: (key: RangeKey) => void;
  /** Small label before the pills; pass null to hide. */
  eyebrow?: string | null;
  customFrom?: string;
  customTo?: string;
  onCustomFrom?: (v: string) => void;
  onCustomTo?: (v: string) => void;
}) {
  return (
    <Row gap={6} align="center" wrap>
      {eyebrow && (
        <span className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
          {eyebrow}
        </span>
      )}
      {options.map((k) => (
        <RangePill key={k} active={value === k} onClick={() => onChange(k)}>
          {RANGE_LABELS[k]}
        </RangePill>
      ))}
      {value === 'custom' && options.includes('custom') && (
        <Row gap={4} align="center">
          <input
            type="date"
            value={customFrom ?? ''}
            onChange={(e) => onCustomFrom?.(e.target.value)}
            aria-label="From date"
            style={rangeDateStyle}
          />
          <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>→</span>
          <input
            type="date"
            value={customTo ?? ''}
            onChange={(e) => onCustomTo?.(e.target.value)}
            aria-label="To date"
            style={rangeDateStyle}
          />
        </Row>
      )}
    </Row>
  );
}

const rangeDateStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-sunken)',
  color: 'var(--fg)',
};
