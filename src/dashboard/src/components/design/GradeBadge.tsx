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

/**
 * Why an ENDED session carries no grade, from its own numbers. The rules
 * mirror the scorer's eligibility gates (stream-health.ts): 50+ avg CCV,
 * 30+ minutes, chat watched for at least half the stream.
 */
export function noGradeReason(
  avgCcv?: number | null,
  minutesLive?: number | null,
): string {
  if (avgCcv != null && avgCcv < 50) {
    return `Not scored: averaged ${Math.round(avgCcv)} viewers (scoring starts at 50)`;
  }
  if (minutesLive != null && minutesLive < 30) {
    return `Not scored: ${Math.round(minutesLive)} min live (scoring starts at 30)`;
  }
  return 'Not scored: chat was not watched for enough of this stream (the collector follows the top ~600 live channels)';
}

export function GradeBadge({
  grade,
  score,
  size = 20,
  noGradeTitle,
}: {
  grade: string | null | undefined;
  score?: number | null;
  size?: number;
  /** Overrides the default "not scored yet" tooltip with a precise reason. */
  noGradeTitle?: string;
}) {
  if (!grade) {
    return (
      <span
        title={noGradeTitle ?? 'Not scored yet: health is computed after each broadcast'}
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
