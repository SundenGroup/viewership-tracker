import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '@/services/api';
import type {
  GameTrackerRangeBucket,
  GameTrackerLeaderboardRow,
  GameTrackerRangeLeaderboardRow,
  GameTrackerPlatformBreakdown,
  GameTrackerTrendingRow,
} from '@/services/api';
import {
  Row,
  Col,
  Section,
  Pill,
  Kpi,
  PlatformPip,
  ChannelNameWithLink,
  IconCalendar,
  IconBolt,
  IconTrophy,
  IconX,
  IconDownload,
} from '@/components/design';
import { fmtCompact, fmtN } from '@/design/format';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { Avatar } from './DiscoverDetailPage';
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
  // Range + chart selection are mirrored into URL search params (?range,
  // ?at / ?sel_from+?sel_to) so a pasted link reproduces the view. State
  // initializes from the URL on mount; the sync effect below writes back.
  const [searchParams, setSearchParams] = useSearchParams();
  const [rangeKey, setRangeKey] = useState<RangePreset>(() => {
    const r = searchParams.get('range');
    return RANGE_OPTIONS.some((o) => o.key === r) ? (r as RangePreset) : '24h';
  });
  const [buckets, setBuckets] = useState<GameTrackerRangeBucket[]>([]);
  const [selection, setSelection] = useState<Selection | null>(() => {
    const at = searchParams.get('at');
    if (at && !Number.isNaN(Date.parse(at))) return { fromIso: at, toIso: null };
    const selFrom = searchParams.get('sel_from');
    const selTo = searchParams.get('sel_to');
    if (selFrom && selTo && !Number.isNaN(Date.parse(selFrom)) && !Number.isNaN(Date.parse(selTo))) {
      return { fromIso: selFrom, toIso: selTo };
    }
    return null;
  });
  const [pointSnapshot, setPointSnapshot] = useState<GameTrackerLeaderboardRow[] | null>(null);
  const [rangeRows, setRangeRows] = useState<GameTrackerRangeLeaderboardRow[] | null>(null);
  const [breakdown, setBreakdown] = useState<{
    platform: GameTrackerPlatformBreakdown[];
    language: api.GameTrackerLanguageBreakdown[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const range = RANGE_OPTIONS.find((r) => r.key === rangeKey)!;

  // State → URL (replace, merged with unrelated keys like ?tab / ?q).
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (rangeKey === '24h') p.delete('range');
        else p.set('range', rangeKey);
        p.delete('at');
        p.delete('sel_from');
        p.delete('sel_to');
        if (selection) {
          if (selection.toIso === null) p.set('at', selection.fromIso);
          else {
            p.set('sel_from', selection.fromIso);
            p.set('sel_to', selection.toIso);
          }
        }
        return p;
      },
      { replace: true },
    );
    // setSearchParams intentionally omitted: re-running on param identity
    // changes would rewrite the URL in a loop for no state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, selection]);

  // Skip the selection reset on mount so a selection restored from the
  // URL isn't immediately clobbered by the initial data load.
  const skipResetOnMount = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const from = new Date(Date.now() - range.hours * 60 * 60_000);
    const to = new Date();
    setError(null);
    if (skipResetOnMount.current) {
      skipResetOnMount.current = false;
    } else {
      setSelection(null);
      setPointSnapshot(null);
      setRangeRows(null);
    }

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
      });

    return () => {
      cancelled = true;
    };
  }, [slug, range.hours, range.bucketSeconds]);

  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    const at = new Date(selection.fromIso);
    if (selection.toIso === null) {
      api
        .getGameTrackerLeaderboard(slug, at, 25)
        .then((rows) => {
          if (!cancelled) setPointSnapshot(rows);
        })
        .catch(() => {});
    } else {
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
    <Col gap={16}>
      {/* Risers & anomalies */}
      <TrendingSection slug={slug} />

      {/* Range picker */}
      <Row gap={8} align="center">
        <span
          className="eyebrow"
          style={{ fontSize: 10, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconCalendar size={11} /> Range
        </span>
        <Row gap={4}>
          {RANGE_OPTIONS.map((opt) => (
            <RangePill
              key={opt.key}
              active={rangeKey === opt.key}
              onClick={() => setRangeKey(opt.key)}
            >
              {opt.label}
            </RangePill>
          ))}
        </Row>
      </Row>

      {error && (
        <Section style={{ color: 'var(--red)' }}>{error}</Section>
      )}

      {/* Aggregate KPIs */}
      <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <TrendKpi
          icon={<IconBolt size={13} />}
          label={`Avg CCV (${range.label})`}
          value={fmtN(totalAvgCcv)}
        />
        <TrendKpi
          icon={<IconTrophy size={13} />}
          label="Peak"
          value={fmtN(peakCcv)}
          sub={
            peakBucket
              ? new Date(peakBucket.ts).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : null
          }
        />
        <TrendKpi
          label="Resolution"
          value={
            range.bucketSeconds < 60
              ? `${range.bucketSeconds}s`
              : `${range.bucketSeconds / 60}m`
          }
          sub={`${buckets.length} buckets`}
        />
      </Row>

      {/* Drag-to-select chart */}
      <Section
        title="Total concurrent viewers"
        eyebrow="TIMELINE"
        right={
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            click a point or drag to inspect
          </span>
        }
      >
        <DiscoverTimelineChart
          buckets={buckets}
          selection={selection}
          onPick={setSelection}
          height={300}
        />
      </Section>

      {/* Side-by-side: selected detail + breakdowns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SelectedPanel
          slug={slug}
          selection={selection}
          pointSnapshot={pointSnapshot}
          rangeRows={rangeRows}
          onClear={() => setSelection(null)}
        />
        <BreakdownPanel breakdown={breakdown} />
      </div>
    </Col>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function RangePill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 12px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
        background: active ? 'var(--red-wash, color-mix(in oklab, var(--red) 12%, transparent))' : 'transparent',
        color: active ? 'var(--red)' : 'var(--fg-muted)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const TRENDING_HOURS_OPTIONS = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
] as const;

/**
 * Risers & anomalies — peak CCV in the last N hours vs the N hours
 * before. NEW = channel had no snapshots in the prior window; the amber
 * ×N pill flags a ≥3× spike over the prior peak.
 */
function TrendingSection({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const [hours, setHours] = useState<number>(24);
  const [rows, setRows] = useState<GameTrackerTrendingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api
      .getGameTrackerTrending(slug, hours, 20)
      .then((res) => {
        if (!cancelled) setRows(res.rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, hours]);

  return (
    <Section
      title="Trending"
      eyebrow={`RISERS · LAST ${hours === 168 ? '7D' : `${hours}H`} VS PRIOR`}
      compact
      right={
        <Row gap={4} align="center">
          {TRENDING_HOURS_OPTIONS.map((opt) => (
            <RangePill
              key={opt.hours}
              active={hours === opt.hours}
              onClick={() => setHours(opt.hours)}
            >
              {opt.label}
            </RangePill>
          ))}
        </Row>
      }
    >
      {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
      {!error && rows === null && (
        <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>
      )}
      {rows !== null && rows.length === 0 && (
        <div style={{ color: 'var(--fg-muted)', fontSize: 12, padding: '4px 0' }}>
          No risers in this window.
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-faint)' }}>
              <th style={{ ...miniTh, width: 30 }}>#</th>
              <th style={miniTh}>Channel</th>
              <th style={{ ...miniTh, textAlign: 'right', width: 140 }}>Prev → Now</th>
              <th style={{ ...miniTh, textAlign: 'right', width: 80 }}>Δ</th>
              <th style={{ ...miniTh, width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const delta = r.cur_peak - r.prev_peak;
              const spike = !r.is_new && r.prev_peak > 0 && r.cur_peak >= 3 * r.prev_peak;
              const profilePic = r.channel?.metadata?.profile_image_url as string | undefined;
              return (
                <tr
                  key={r.channel_id}
                  onClick={() => navigate(`/discover/${slug}/channel/${r.channel_id}`)}
                  style={{ borderBottom: '1px solid var(--border-faint)', cursor: 'pointer' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-sunken)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <td style={{ ...miniTd, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>
                    {i + 1}
                  </td>
                  <td style={miniTd}>
                    <Row gap={8} align="center">
                      <Avatar
                        src={profilePic ?? null}
                        name={r.channel?.display_name ?? '?'}
                        size={24}
                      />
                      <PlatformPip id={r.channel?.platform ?? 'twitch'} size={11} />
                      <span style={{ fontWeight: 500, color: 'var(--fg)' }}>
                        {r.channel?.display_name ?? r.channel_id.slice(0, 8)}
                      </span>
                    </Row>
                  </td>
                  <td style={{ ...miniTd, ...numericTd, color: 'var(--fg-muted)' }}>
                    {fmtCompact(r.prev_peak)} →{' '}
                    <span style={{ color: 'var(--fg)', fontWeight: 600 }}>
                      {fmtCompact(r.cur_peak)}
                    </span>
                  </td>
                  <td
                    style={{
                      ...miniTd,
                      ...numericTd,
                      fontWeight: 600,
                      color: delta >= 0 ? 'var(--live)' : 'var(--red)',
                    }}
                  >
                    {delta >= 0 ? '+' : ''}
                    {fmtCompact(delta)}
                  </td>
                  <td style={{ ...miniTd, textAlign: 'right' }}>
                    {r.is_new ? (
                      <Pill tone="red">NEW</Pill>
                    ) : spike ? (
                      <Pill tone="warn">×{(r.cur_peak / r.prev_peak).toFixed(1)}</Pill>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function TrendKpi({
  icon,
  label,
  value,
  sub,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{
        padding: '22px 22px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--red)' }}
      />
      <Kpi
        size="md"
        label={
          <Row gap={5} align="center" style={{ color: 'var(--fg-muted)' }}>
            {icon}
            {label}
          </Row>
        }
        value={<span style={{ fontWeight: 600 }}>{value}</span>}
        sub={sub ? <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{sub}</span> : undefined}
      />
    </div>
  );
}

function SelectedPanel({
  slug,
  selection,
  pointSnapshot,
  rangeRows,
  onClear,
}: {
  slug: string;
  selection: Selection | null;
  pointSnapshot: GameTrackerLeaderboardRow[] | null;
  rangeRows: GameTrackerRangeLeaderboardRow[] | null;
  onClear: () => void;
}) {
  if (!selection) {
    return (
      <Section title="Selection" eyebrow="DETAIL">
        <div style={{ color: 'var(--fg-muted)', fontSize: 13, padding: '12px 0' }}>
          Click a point on the chart to see top streams at that moment, or drag to inspect a range.
        </div>
      </Section>
    );
  }

  const isRange = selection.toIso !== null;
  const fromDate = new Date(selection.fromIso);

  return (
    <Section
      title={
        <Row gap={6} align="baseline">
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {fromDate.toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {isRange && selection.toIso && (
            <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
              → {new Date(selection.toIso).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </Row>
      }
      eyebrow={isRange ? 'RANGE' : 'AT MOMENT'}
      right={
        <Row gap={6} align="center">
          {isRange && rangeRows && rangeRows.length > 0 && (
            <button
              type="button"
              className="btn btn-xs"
              style={{ cursor: 'pointer' }}
              onClick={() =>
                downloadCsv(
                  `${slug}-trends-range-${csvStamp()}.csv`,
                  ['rank', 'channel', 'platform', 'peak_ccv', 'avg_ccv', 'minutes_live'],
                  rangeRows.map((r, i) => [
                    i + 1,
                    r.channel?.display_name ?? r.channel_id,
                    r.platform,
                    r.peak_ccv,
                    r.avg_ccv,
                    r.minutes_live,
                  ]),
                )
              }
            >
              <IconDownload size={11} /> CSV
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              border: 'none',
              background: 'transparent',
              color: 'var(--fg-dim)',
              cursor: 'pointer',
            }}
          >
            <IconX size={14} />
          </button>
        </Row>
      }
      style={{ padding: 0 }}
    >
      <div style={{ maxHeight: 360, overflowY: 'auto', margin: -16, marginTop: 0 }}>
        {isRange ? <RangeRowsTable rows={rangeRows} /> : <PointSnapshotTable rows={pointSnapshot} />}
      </div>
    </Section>
  );
}

function PointSnapshotTable({ rows }: { rows: GameTrackerLeaderboardRow[] | null }) {
  if (rows === null) {
    return <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 12 }}>No streams in this minute.</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-faint)' }}>
          <th style={miniTh}>#</th>
          <th style={miniTh}>Channel</th>
          <th style={{ ...miniTh, textAlign: 'right' }}>CCV</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.channel_id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
            <td style={{ ...miniTd, color: 'var(--fg-dim)', width: 30, fontFamily: 'var(--font-mono)' }}>
              {i + 1}
            </td>
            <td style={miniTd}>
              <Row gap={8} align="center">
                <PlatformPip id={r.platform} size={11} />
                {r.channel ? (
                  <ChannelNameWithLink
                    name={r.channel.display_name}
                    platform={r.platform}
                    channelIdentifier={r.channel.channel_identifier}
                  />
                ) : (
                  <span style={{ color: 'var(--fg-muted)' }}>{r.channel_id.slice(0, 8)}</span>
                )}
              </Row>
            </td>
            <td
              style={{
                ...miniTd,
                textAlign: 'right',
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 500,
                color: 'var(--fg)',
              }}
            >
              {fmtCompact(r.concurrent_viewers)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RangeRowsTable({ rows }: { rows: GameTrackerRangeLeaderboardRow[] | null }) {
  if (rows === null) {
    return <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 12 }}>No streams in this range.</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-faint)' }}>
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
            <td style={{ ...miniTd, color: 'var(--fg-dim)', width: 30, fontFamily: 'var(--font-mono)' }}>
              {i + 1}
            </td>
            <td style={miniTd}>
              <Row gap={8} align="center">
                <PlatformPip id={r.platform} size={11} />
                {r.channel ? (
                  <ChannelNameWithLink
                    name={r.channel.display_name}
                    platform={r.platform}
                    channelIdentifier={r.channel.channel_identifier}
                  />
                ) : (
                  <span style={{ color: 'var(--fg-muted)' }}>{r.channel_id.slice(0, 8)}</span>
                )}
              </Row>
            </td>
            <td style={{ ...miniTd, ...numericTd, fontWeight: 600 }}>{fmtCompact(r.peak_ccv)}</td>
            <td style={{ ...miniTd, ...numericTd, color: 'var(--fg-muted)' }}>
              {fmtCompact(r.avg_ccv)}
            </td>
            <td style={{ ...miniTd, ...numericTd, color: 'var(--fg-dim)' }}>{r.minutes_live}</td>
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
    return (
      <Section title="Breakdown" eyebrow="DISTRIBUTION">
        <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Loading…</div>
      </Section>
    );
  }

  // Number() guard: older backends serialize pg SUM() results as strings,
  // which would string-concatenate here and zero out every share.
  const platformTotal = breakdown.platform.reduce((sum, p) => sum + Number(p.total_ccv_minutes), 0);
  const languageTotal = breakdown.language.reduce((sum, p) => sum + Number(p.total_ccv_minutes), 0);

  return (
    <Section title="Breakdown" eyebrow="DISTRIBUTION">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        <BreakdownGroup
          title="Platform"
          rows={breakdown.platform.map((p) => ({
            key: p.platform,
            label: <Row gap={6} align="center"><PlatformPip id={p.platform} size={11} /><span style={{ textTransform: 'capitalize' }}>{p.platform}</span></Row>,
            value: Number(p.total_ccv_minutes),
            share: platformTotal > 0 ? Number(p.total_ccv_minutes) / platformTotal : 0,
          }))}
        />
        <BreakdownGroup
          title="Language"
          rows={breakdown.language.slice(0, 6).map((p) => ({
            key: p.language ?? 'unknown',
            label: <span style={{ textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{p.language ?? '—'}</span>,
            value: Number(p.total_ccv_minutes),
            share: languageTotal > 0 ? Number(p.total_ccv_minutes) / languageTotal : 0,
          }))}
        />
      </div>
    </Section>
  );
}

function BreakdownGroup({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: React.ReactNode; value: number; share: number }>;
}) {
  return (
    <Col gap={8}>
      <div className="eyebrow" style={{ fontSize: 10 }}>
        {title}
      </div>
      {rows.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>No data</div>}
      {rows.map((r) => (
        <Col key={r.key} gap={3}>
          <Row justify="space-between" align="center" gap={8} style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{r.label}</span>
            <Pill>{(r.share * 100).toFixed(1)}%</Pill>
          </Row>
          <div
            style={{
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
                opacity: 0.85,
              }}
            />
          </div>
        </Col>
      ))}
    </Col>
  );
}

const miniTh: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: 9,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const miniTd: React.CSSProperties = {
  padding: '8px 12px',
};

const numericTd: React.CSSProperties = {
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
};
