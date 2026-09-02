/**
 * One line under a range control when the window reaches past the
 * tracker's raw retention: those days are served from the daily and
 * 10-minute rollups, which the UI otherwise never says.
 */
export function RetentionNote({ retainRawDays, hours }: { retainRawDays?: number | null; hours: number }) {
  if (!retainRawDays || hours <= retainRawDays * 24) return null;
  return (
    <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
      Minute-level data is kept {retainRawDays} days on this tracker; older days in this range come from the
      daily and 10-minute rollups (peaks, averages and airtime stay exact).
    </div>
  );
}
