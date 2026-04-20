/** Number formatters used throughout the design. */

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return String(n);
}

export function fmtN(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtRelative(isoOrMs: string | number | Date | null | undefined): string {
  if (isoOrMs == null) return '—';
  const ts = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
