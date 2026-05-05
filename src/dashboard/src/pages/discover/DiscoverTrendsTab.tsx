import { useEffect, useMemo, useState } from 'react';
import * as api from '@/services/api';
import type {
  GameTrackerRangeBucket,
  GameTrackerLeaderboardRow,
  GameTrackerRangeLeaderboardRow,
  GameTrackerPlatformBreakdown,
} from '@/services/api';
import { DiscoverTimelineChart } from './DiscoverTimelineChart';

type RangePreset = '1h' | '6h' | '24h' | '7d' | '30d';

interface RangeOption {
  key: RangePreset;
  label: string;
  hours: number;
  bucketSeconds: number;
}

const RANGE_OPTIONS: RangeOption[] = [
  { key: '1h', label: '1h', hours: 1, bucketSeconds: 60 },
  { key: '6h', label: '6h', hours: 6, bucketSeconds: 60 },
  { key: '24h', label: '24h', hours: 24, bucketSeconds: 300 },
  { key: '7d', label: '7d', hours: 24 * 7, bucketSeconds: 1800 },
  { key: '30d', label: '30d', hours: 24 * 30, bucketSeconds: 3600 },
];

interface Selection {
  fromIso: string;
  toIso: string | null;
}

export function DiscoverTrendsTab({ slug }: { slug: string }) {
  const [rangeKey, setRangeKey] = useState<RangePreset>('24h');
  const [buckets, setBuckets] = useState<GameTrackerRangeBucket[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pointSnapshot, setPointSnapshot] = useState<GameTrackerLeaderboardRow[] | null>(null);
  const [rangeRows, setRangeRows] = useState<GameTrackerRangeLeaderboardRow[] | null>(null);
  const [breakdown, setBreakdown] = useState<{
    platform: GameTrackerPlatformBreakdown[];
    language: api.GameTrackerLanguageBreakdown[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = RANGE_OPTIONS.find((r) => r.key === rangeKey)!;

  // Load timeline + breakdown when range changes.
  useEffect(() => {
    let cancelled = false;
    const from = new Date(Date.now() - range.hours * 60 * 60_000);
    const to = new Date();
    setLoading(true);
    setError(null);
    setSelection(null);
    setPointSnapshot(null);
    setRangeRows(null);

    Promise.all([
      api.getGameTrackerRange(slug, from, to, range.bucketSeconds),
      api.getGameTrackerBreakdown(slug, from, to),
    ])
      .then(([rangeRes, breakdownRes]) => {
        if (cancelled) return;
        setBuckets(rangeRes.buckets);
        setBreakdown({ platform: breakdownRes.platform, language: breakdownRes.language });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, range.hours, range.bucketSeconds]);

  // Load side-panel content when selection changes.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    const at = new Date(selection.fromIso);
    if (selection.toIso === null) {
      // Single-timestamp click → top streams at that moment.
      api
        .getGameTrackerLeaderboard(slug, at, 25)
        .then((rows) => {
          if (!cancelled) setPointSnapshot(rows);
        })
        .catch(() => {});
    } else {
      // Range → range leaderboard.
      const to = new Date(selection.toIso);
      api
        .getGameTrackerRangeLeaderboard(slug, at, to, 25)
        .then((res) => {
          if (!cancelled) setRangeRows(res.rows);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [slug, selection]);

  const totalAvgCcv = useMemo(() => {
    if (buckets.length === 0) return 0;
    const sum = buckets.reduce((acc, b) => acc + b.total_ccv, 0);
    return Math.round(sum / buckets.length);
  }, [buckets]);

  const peakCcv = useMemo(
    () => buckets.reduce((max, b) => (b.total_ccv > max ? b.total_ccv : max), 0),
    [buckets],
  );

  const peakBucket = useMemo(
    () => buckets.find((b) => b.total_ccv === peakCcv) ?? null,
    [buckets, peakCcv],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Range picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Range
        </span>
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setRangeKey(opt.key)}
              className="btn"
              style={{
                fontSize: 12,
                padding: '4px 12px',
                background: rangeKey === opt.key ? 'var(--red)' : 'transparent',
                color: rangeKey === opt.key ? '#fff' : 'var(--fg-muted)',
                borderColor: rangeKey === opt.key ? 'var(--red)' : 'var(--border)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="placeholder" style={{ color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {/* Aggregate metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <ReportKpi label={`Avg CCV (${range.label})`} value={totalAvgCcv.toLocaleString()} />
        <ReportKpi
          label="Peak"
          value={peakCcv.toLocaleString()}
          sub={
            peakBucket ? new Date(peakBucket.ts).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }) : undefined
          }
        />
        <ReportKpi
          label="Buckets"
          value={loading ? '—' : `${buckets.length}`}
          sub={`${range.bucketSeconds < 60 ? `${range.bucketSeconds}s` : `${range.bucketSeconds / 60}m`} resolution`}
        />
      </div>

      {/* Drag-to-select chart */}
      <div className="card" style={{ padding: 20, paddingBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            Total concurrent viewers
          </h3>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            click a point or drag to inspect
          </span>
        </div>
        <DiscoverTimelineChart buckets={buckets} selection={selection} onPick={setSelection} height={300} />
      </div>

      {/* Side-panel: details for the selected point or range */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SelectedPanel
          selection={selection}
          pointSnapshot={pointSnapshot}
          rangeRows={rangeRows}
          onClear={() => setSelection(null)}
        />
        <BreakdownPanel breakdown={breakdown} />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function ReportKpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="card"
      style={{
        padding: '20px 22px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: 'var(--red)',
        }}
      />
      <div
        style={{
          fontSize: 10,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 30,
          fontWeight: 700,
          color: 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-dim)' }}>{sub}</div>
      )}
    </div>
  );
}

function SelectedPanel({
  selection,
  pointSnapshot,
  rangeRows,
  onClear,
}: {
  selection: Selection | null;
  pointSnapshot: GameTrackerLeaderboardRow[] | null;
  rangeRows: GameTrackerRangeLeaderboardRow[] | null;
  onClear: () => void;
}) {
  if (!selection) {
    return (
      <div className="card" style={{ padding: 20, color: 'var(--fg-muted)', fontSize: 13 }}>
        Click a point on the chart to see top streams at that moment, or drag to inspect a range.
      </div>
    );
  }

  const isRange = selection.toIso !== null;
  const fromDate = new Date(selection.fromIso);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 2,
            }}
          >
            {isRange ? 'Range' : 'At'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 500 }}>
            {fromDate.toLocaleString()}
            {isRange && selection.toIso && ` → ${new Date(selection.toIso).toLocaleString()}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          style={{
            background: 'transparent',
            color: 'var(--fg-muted)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          clear
        </button>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {isRange ? (
          <RangeRowsTable rows={rangeRows} />
        ) : (
          <PointSnapshotTable rows={pointSnapshot} />
        )}
      </div>
    </div>
  );
}

function PointSnapshotTable({ rows }: { rows: GameTrackerLeaderboardRow[] | null }) {
  if (rows === null) {
    return <div style={{ padding: 20, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return <div style={{ padding: 20, color: 'var(--fg-muted)', fontSize: 12 }}>No streams in this minute.</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: 'var(--bg-sunken)' }}>
          <th style={miniTh}>#</th>
          <th style={miniTh}>Channel</th>
          <th style={{ ...miniTh, textAlign: 'right' }}>CCV</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.channel_id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
            <td style={{ ...miniTd, color: 'var(--fg-dim)', width: 30 }}>{i + 1}</td>
            <td style={miniTd}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-sunken)', color: 'var(--fg-muted)' }}>
                  {r.platform}
                </span>
                <span style={{ color: 'var(--fg)', fontWeight: 500 }}>
                  {r.channel?.display_name ?? r.channel_id.slice(0, 8)}
                </span>
              </div>
            </td>
            <td style={{ ...miniTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {r.concurrent_viewers.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RangeRowsTable({ rows }: { rows: GameTrackerRangeLeaderboardRow[] | null }) {
  if (rows === null) {
    return <div style={{ padding: 20, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return <div style={{ padding: 20, color: 'var(--fg-muted)', fontSize: 12 }}>No streams in this range.</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: 'var(--bg-sunken)' }}>
          <th style={miniTh}>#</th>
          <th style={miniTh}>Channel</th>
          <th style={{ ...miniTh, textAlign: 'right' }}>Peak</th>
          <th style={{ ...miniTh, textAlign: 'right' }}>Avg</th>
          <th style={{ ...miniTh, textAlign: 'right' }}>Min</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.channel_id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
            <td style={{ ...miniTd, color: 'var(--fg-dim)', width: 30 }}>{i + 1}</td>
            <td style={miniTd}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-sunken)', color: 'var(--fg-muted)' }}>
                  {r.platform}
                </span>
                <span style={{ color: 'var(--fg)', fontWeight: 500 }}>
                  {r.channel?.display_name ?? r.channel_id.slice(0, 8)}
                </span>
              </div>
            </td>
            <td style={{ ...miniTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
              {r.peak_ccv.toLocaleString()}
            </td>
            <td style={{ ...miniTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' }}>
              {r.avg_ccv.toLocaleString()}
            </td>
            <td style={{ ...miniTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--fg-dim)' }}>
              {r.minutes_live}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BreakdownPanel({
  breakdown,
}: {
  breakdown: { platform: GameTrackerPlatformBreakdown[]; language: api.GameTrackerLanguageBreakdown[] } | null;
}) {
  if (!breakdown) {
    return <div className="card" style={{ padding: 20, color: 'var(--fg-muted)', fontSize: 13 }}>Loading…</div>;
  }

  const platformTotal = breakdown.platform.reduce((sum, p) => sum + p.total_ccv_minutes, 0);
  const languageTotal = breakdown.language.reduce((sum, p) => sum + p.total_ccv_minutes, 0);

  return (
    <div className="card" style={{ padding: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0, marginBottom: 14 }}>
        Breakdown
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <SimpleBreakdownList
          title="Platform"
          rows={breakdown.platform.map((p) => ({
            key: p.platform,
            label: p.platform,
            value: p.total_ccv_minutes,
            peak: p.peak,
            share: platformTotal > 0 ? p.total_ccv_minutes / platformTotal : 0,
          }))}
        />
        <SimpleBreakdownList
          title="Language"
          rows={breakdown.language.slice(0, 6).map((p) => ({
            key: p.language ?? 'unknown',
            label: p.language ?? '—',
            value: p.total_ccv_minutes,
            peak: p.peak,
            share: languageTotal > 0 ? p.total_ccv_minutes / languageTotal : 0,
          }))}
        />
      </div>
    </div>
  );
}

function SimpleBreakdownList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: number; peak: number; share: number }>;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>No data</div>
      )}
      {rows.map((r) => (
        <div key={r.key} style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
            <span style={{ color: 'var(--fg)', fontWeight: 500, textTransform: 'capitalize' }}>{r.label}</span>
            <span style={{ color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
              {(r.share * 100).toFixed(1)}%
            </span>
          </div>
          <div
            style={{
              marginTop: 2,
              height: 4,
              background: 'var(--bg-sunken)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${r.share * 100}%`,
                height: '100%',
                background: 'var(--red)',
                opacity: 0.8,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const miniTh: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const miniTd: React.CSSProperties = {
  padding: '8px 12px',
};
