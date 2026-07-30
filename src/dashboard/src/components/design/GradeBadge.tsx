/**
 * GradeBadge — the A–F health chip, exactly to the Analyze handoff spec.
 *
 * Color ramp: A ok-green → B between → C muted → D warn → F danger.
 * A missing grade renders a dim em-dash with the honest tooltip — health
 * is computed only after a broadcast ends, so "not scored" must never
 * read as "suspicious".
 */
export const GRADE_COLORS: Record<string, string> = {
  A: 'var(--ok, var(--live))',
  B: 'color-mix(in oklab, var(--ok, var(--live)) 55%, var(--fg-muted))',
  C: 'var(--fg-muted)',
  D: 'var(--warn)',
  F: 'var(--danger)',
};

export function GradeBadge({
  grade,
  score,
  size = 20,
}: {
  grade: string | null | undefined;
  score?: number | null;
  size?: number;
}) {
  if (!grade) {
    return (
      <span
        title="Not scored yet — health is computed after each broadcast"
        style={{ fontSize: 11, color: 'var(--fg-dim)' }}
      >
        —
      </span>
    );
  }
  const c = GRADE_COLORS[grade] ?? 'var(--fg-muted)';
  return (
    <span
      title={
        score != null
          ? `Health ${score}/100 · computed after the broadcast`
          : `Health grade ${grade} · from the last completed broadcast`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 5,
        fontSize: size * 0.55,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        color: c,
        background: `color-mix(in oklab, ${c} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${c} 36%, transparent)`,
      }}
    >
      {grade}
    </span>
  );
}

/** ▲/▼ percentage chip — green up, red down, mono. */
export function DeltaChip({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: up ? 'var(--ok, var(--live))' : 'var(--danger)',
        whiteSpace: 'nowrap',
      }}
    >
      {up ? '▲' : '▼'} {Math.abs(pct * 100).toFixed(0)}%
    </span>
  );
}
