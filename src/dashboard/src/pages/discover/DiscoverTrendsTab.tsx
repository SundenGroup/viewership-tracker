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
  PlatformPip,
  ChannelNameWithLink,
  RangePill,
  TableScroll,
  rowLinkProps,
  IconCalendar,
  IconBolt,
  IconTrophy,
  IconX,
  IconDownload,
  IconClock,
  RangeControl,
  SegmentedControl,
} from '@/components/design';
import { fmtCompact, fmtN, fmtRelative } from '@/design/format';
import { RetentionNote } from '@/components/discover/RetentionNote';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { Avatar } from './DiscoverDetailPage';
import { ChannelKpi } from './DiscoverChannelPage';
import { DiscoverTimelineChart } from './DiscoverTimelineChart';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

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
  { key: '24h', label: '24h', hours: 24, bucketSeconds: 600 }, // 10-min buckets: served from the rollup
  { key: '7d', label: '7d', hours: 24 * 7, bucketSeconds: 1800 },
  { key: '30d', label: '30d', hours: 24 * 30, bucketSeconds: 3600 },
];

interface Selection {
  fromIso: string;
  toIso: string | null;
}

export function DiscoverTrendsTab({
  slug,
  platform = 'all',
  retainRawDays,
}: {
  slug: string;
  /** Shared page-level platform filter. */
  platform?: string;
  /** Tracker's raw retention, for the note under long ranges. */
  retainRawDays?: number | null;
}) {
  // Range + chart selection are mirrored into URL search params (?range,
  // ?at / ?sel_from+?sel_to) so a pasted link reproduces the view. State
  // initializes from the URL on mount; the sync effect below writes back.
  const [searchParams, setSearchParams] = useSearchParams();
  const [rangeKey, setRangeKey] = useState<RangePreset>(() => {
    const r = searchParams.get('range');
    // 'now'/'custom' come from the Channels tab sharing ?range — this
    // surface has no live/custom mode, so land on the nearest window.
    if (r === 'now') return '24h';
    return RANGE_OPTIONS.some((o) => o.key === r) ? (r as RangePreset) : '24h';
  });
  const [events, setEvents] = useState<api.GameTrackerEventWindow[]>([]);
  /** Total line vs stacked per-platform areas ("who is the audience on?"). */
  const [chartMode, setChartMode] = useState<'total' | 'platform'>('total');
  const [platformSeries, setPlatformSeries] = useState<
    Array<{ platform: string; buckets: GameTrackerRangeBucket[] }> | null
  >(null);
  const [buckets, setBuckets] = useState<GameTrackerRangeBucket[]>([]);
  const [bucketsLoading, setBucketsLoading] = useState(true);
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

    setBucketsLoading(true);
    // Events are decorative — fetched separately so a failure never
    // blocks the chart itself.
    api
      .getGameTrackerEvents(slug, from, to)
      .then((r) => !cancelled && setEvents(r.events))
      .catch(() => !cancelled && setEvents([]));
    Promise.all([
      api.getGameTrackerRange(slug, from, to, range.bucketSeconds, platform),
      api.getGameTrackerBreakdown(slug, from, to, platform),
    ])
      .then(([rangeRes, breakdownRes]) => {
        if (cancelled) return;
        setBuckets(rangeRes.buckets);
        setBreakdown({ platform: breakdownRes.platform, language: breakdownRes.language });
        setBucketsLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setBucketsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [slug, range.hours, range.bucketSeconds, platform]);

  // Stacked mode fetches one series per platform. Only runs while the
  // mode is active — three extra range queries are not a default cost.
  useEffect(() => {
    if (chartMode !== 'platform') return;
    let cancelled = false;
    const from = new Date(Date.now() - range.hours * 3600_000);
    const to = new Date();
    const plats = ['twitch', 'kick', 'youtube', 'soop', 'tiktok', 'chzzk'];
    Promise.all(
      plats.map((pf) =>
        api
          .getGameTrackerRange(slug, from, to, range.bucketSeconds, pf)
          .then((r) => ({ platform: pf, buckets: r.buckets }))
          .catch(() => ({ platform: pf, buckets: [] as GameTrackerRangeBucket[] })),
      ),
    ).then((rows) => {
      if (!cancelled) setPlatformSeries(rows.filter((r) => r.buckets.some((b) => b.total_ccv > 0)));
    });
    return () => {
      cancelled = true;
    };
  }, [chartMode, slug, range.hours, range.bucketSeconds]);

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
  // Hours watched ≈ Σ(bucket avg CCV × bucket length). Same math the
  // Explore reports use, applied to the tracker total.
  const hoursWatched = useMemo(
    () => buckets.reduce((acc, b) => acc + b.total_ccv * range.bucketSeconds, 0) / 3600,
    [buckets, range.bucketSeconds],
  );

  return (
    <Col gap={16}>
      {/* Risers & anomalies */}
      <TrendingSection slug={slug} platform={platform} />

      {/* Range picker — same control + ?range vocabulary as Channels */}
      <Row gap={12} align="center" wrap>
        <RangeControl
          options={RANGE_OPTIONS.map((o) => o.key)}
          value={rangeKey}
          onChange={(k) => setRangeKey(k as RangePreset)}
        />
        <div style={{ marginLeft: 'auto' }}>
          <SegmentedControl
            ariaLabel="Chart mode"
            size="sm"
            value={chartMode}
            onChange={setChartMode}
            options={[
              { value: 'total', label: 'Total' },
              { value: 'platform', label: 'By platform' },
            ]}
          />
        </div>
      </Row>
      <RetentionNote retainRawDays={retainRawDays} hours={range.hours} />

      {error && (
        <Section style={{ color: 'var(--danger)' }}>{error}</Section>
      )}

      {/* Aggregate KPIs */}
      <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <ChannelKpi
          icon={<IconBolt size={13} />}
          label={`Avg viewers (${range.label.toUpperCase()})`}
          value={fmtN(totalAvgCcv)}
        />
        <ChannelKpi
          icon={<IconClock size={13} />}
          label={`Hours watched (${range.label})`}
          value={fmtCompact(Math.round(hoursWatched))}
        />
        <ChannelKpi
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
      </Row>

      {/* Drag-to-select chart */}
      <Section
        title="Concurrent viewers"
        eyebrow="TRACKED-EVENT WINDOWS SHADED"
        right={
          <span style={{ fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>
            click a point or drag to inspect ·{' '}
            {range.bucketSeconds < 60 ? `${range.bucketSeconds}s` : `${range.bucketSeconds / 60}m`}{' '}
            buckets · your local time (UTC{-new Date().getTimezoneOffset() / 60 >= 0 ? '+' : ''}
            {-new Date().getTimezoneOffset() / 60})
          </span>
        }
      >
        {chartMode === 'total' ? (
          <DiscoverTimelineChart
            buckets={buckets}
            loading={bucketsLoading}
            selection={selection}
            onPick={setSelection}
            height={300}
            events={events}
          />
        ) : (
          <StackedPlatformChart series={platformSeries} height={300} />
        )}
      </Section>

      {/* Side-by-side on wide screens, stacked on phones */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <SelectedPanel
          slug={slug}
          selection={selection}
          pointSnapshot={pointSnapshot}
          rangeRows={rangeRows}
          onClear={() => setSelection(null)}
        />
        <BreakdownPanel breakdown={breakdown} />
      </div>

      {range.hours >= 24 && <HourHeatStrip buckets={buckets} />}
    </Col>
  );
}

/**
 * Hour-of-day heat strip — 24 cells of average total CCV by local hour.
 * Answers "when is this game's prime window?" at a glance.
 */
function HourHeatStrip({ buckets }: { buckets: GameTrackerRangeBucket[] }) {
  const cells = useMemo(() => {
    const sum = new Array<number>(24).fill(0);
    const n = new Array<number>(24).fill(0);
    for (const b of buckets) {
      const h = new Date(b.ts).getHours();
      sum[h]! += b.total_ccv;
      n[h]! += 1;
    }
    const avg = sum.map((s, i) => (n[i]! > 0 ? s / n[i]! : 0));
    const max = Math.max(...avg, 1);
    return avg.map((v, h) => ({ h, v, pct: v / max }));
  }, [buckets]);

  const prime = useMemo(() => {
    let best = 0;
    for (let i = 1; i < cells.length; i++) if (cells[i]!.v > cells[best]!.v) best = i;
    return best;
  }, [cells]);

  if (buckets.length === 0) return null;
  return (
    <Section title="Hour of day" eyebrow="AVERAGE VIEWERS BY LOCAL HOUR" compact>
      <Col gap={6}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2 }}>
          {cells.map((c) => (
            <div
              key={c.h}
              title={`${String(c.h).padStart(2, '0')}:00 · avg ${fmtCompact(Math.round(c.v))}`}
              style={{
                height: 34,
                borderRadius: 3,
                background: `color-mix(in oklab, var(--red) ${Math.round(c.pct * 82)}%, var(--bg-sunken))`,
                outline: c.h === prime ? '1px solid var(--red)' : 'none',
              }}
            />
          ))}
        </div>
        <Row justify="space-between" style={{ fontSize: 9.5, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>
          {['00', '06', '12', '18', '23'].map((l) => (
            <span key={l}>{l}:00</span>
          ))}
        </Row>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Prime window peaks around {String(prime).padStart(2, '0')}:00 your time.
        </span>
      </Col>
    </Section>
  );
}

/** Stacked per-platform areas — platform brand colors, shared x-axis. */
function StackedPlatformChart({
  series,
  height,
}: {
  series: Array<{ platform: string; buckets: GameTrackerRangeBucket[] }> | null;
  height: number;
}) {
  const data = useMemo(() => {
    if (!series || series.length === 0) return [];
    const base = series.reduce((a, b) => (b.buckets.length > a.buckets.length ? b : a), series[0]!);
    return base.buckets.map((b, i) => {
      const row: Record<string, number | string> = { ts: b.ts };
      for (const s of series) row[s.platform] = s.buckets[i]?.total_ccv ?? 0;
      return row;
    });
  }, [series]);
  const PLATFORM_COLORS: Record<string, string> = {
    twitch: '#9146FF',
    youtube: '#FF3B3B',
    kick: '#53FC18',
    soop: '#2E6BFF',
  };
  if (!series) {
    return <div className="placeholder" style={{ height }}>Loading platform split…</div>;
  }
  if (data.length === 0) {
    return <div className="placeholder" style={{ height }}>No platform data in this range.</div>;
  }
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 20, bottom: 5, left: 5 }}>
          <CartesianGrid stroke="var(--border-faint)" strokeDasharray="3 3" />
          <XAxis
            dataKey="ts"
            tickFormatter={(v: string) => {
              const d = new Date(v);
              return data.length > 0 && (Date.parse(String(data[data.length - 1]!.ts)) - Date.parse(String(data[0]!.ts))) / 3600_000 >= 48
                ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }}
            stroke="var(--fg-dim)"
            fontSize={11}
            minTickGap={40}
          />
          <YAxis stroke="var(--fg-dim)" fontSize={11} width={50} tickFormatter={(v: number) => fmtCompact(v)} />
          <Tooltip
            contentStyle={{
              background: 'color-mix(in oklab, var(--bg-card) 95%, transparent)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              fontSize: 11.5,
              padding: '8px 10px',
            }}
            labelFormatter={(v: string) => new Date(v).toLocaleString()}
            formatter={(value: number, name: string) => [fmtN(value), name]}
          />
          {series.map((s) => (
            <Area
              key={s.platform}
              type="monotone"
              dataKey={s.platform}
              stackId="1"
              stroke={PLATFORM_COLORS[s.platform] ?? 'var(--fg-dim)'}
              fill={PLATFORM_COLORS[s.platform] ?? 'var(--fg-dim)'}
              fillOpacity={0.35}
              strokeWidth={1.4}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

const TRENDING_HOURS_OPTIONS = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
] as const;

/**
 * Trending — two lists, because they answer two different questions:
 *   Risers          who beat their own 7-day baseline (by 1.5× or more)
 *   New & returning who has no baseline at all this week
 * The old single list ranked absolute gain over the previous window, so
 * every channel that took a day off led it as "0 → 15K".
 */
function TrendingSection({ slug, platform }: { slug: string; platform: string }) {
  const [hours, setHours] = useState<number>(24);
  const [data, setData] = useState<api.GameTrackerTrendingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .getGameTrackerTrending(slug, hours, 20)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, hours]);

  const scoped = <T extends { channel: { platform: string } | null }>(rows: T[]): T[] =>
    platform === 'all' ? rows : rows.filter((r) => (r.channel?.platform ?? '') === platform);
  const risers = scoped(data?.risers ?? []);
  const newcomers = scoped(data?.newcomers ?? []);
  const windowLabel = hours === 168 ? '7 days' : `${hours} hours`;
  const scopeNote = platform === 'all' ? '' : ` on ${platform}`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <Section
        title="Risers"
        eyebrow={`Last ${windowLabel} vs their 7-day baseline`}
        compact
        right={
          <Row gap={4} align="center">
            {TRENDING_HOURS_OPTIONS.map((opt) => (
              <RangePill key={opt.hours} active={hours === opt.hours} onClick={() => setHours(opt.hours)}>
                {opt.label}
              </RangePill>
            ))}
          </Row>
        }
      >
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        {!error && data === null && <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>}
        {data !== null && risers.length === 0 && (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, padding: '4px 0' }}>
            No channel beat its own baseline by 1.5× in this window{scopeNote}.
          </div>
        )}
        {risers.length > 0 && <TrendTable rows={risers} kind="riser" slug={slug} />}
        <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          Baseline = best daily peak over the previous 7 days (at least 100 viewers). Ranked by how many
          times the baseline was beaten.
        </div>
      </Section>
      <Section title="New & returning" eyebrow="No baseline in the previous 7 days" compact>
        {!error && data === null && <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>}
        {data !== null && newcomers.length === 0 && (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, padding: '4px 0' }}>
            Nobody new above 50 viewers in this window{scopeNote}.
          </div>
        )}
        {newcomers.length > 0 && <TrendTable rows={newcomers} kind="newcomer" slug={slug} />}
        <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          New = first seen by this tracker; returning = has history, but nothing in the last week.
        </div>
      </Section>
    </div>
  );
}

function TrendTable({
  rows,
  kind,
  slug,
}: {
  rows: api.GameTrackerTrendRow[];
  kind: 'riser' | 'newcomer';
  slug: string;
}) {
  const navigate = useNavigate();
  return (
    <TableScroll>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 320 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-faint)' }}>
            <th style={{ ...miniTh, width: 30 }}>#</th>
            <th style={miniTh}>Channel</th>
            {kind === 'riser' ? (
              <>
                <th style={{ ...miniTh, textAlign: 'right', width: 130 }}>Baseline → Now</th>
                <th style={{ ...miniTh, textAlign: 'right', width: 64 }}></th>
              </>
            ) : (
              <>
                <th style={{ ...miniTh, textAlign: 'right', width: 80 }}>Peak</th>
                <th style={{ ...miniTh, textAlign: 'right', width: 120 }}></th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const profilePic = r.channel?.metadata?.profile_image_url as string | undefined;
            const open = () => navigate(`/discover/${slug}/channel/${r.channel_id}`);
            return (
              <tr
                key={r.channel_id}
                onClick={open}
                {...rowLinkProps(`Open ${r.channel?.display_name ?? 'channel'} details`, open)}
                style={{ borderBottom: '1px solid var(--border-faint)', cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-sunken)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <td style={{ ...miniTd, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>{i + 1}</td>
                <td style={miniTd}>
                  <Row gap={8} align="center" style={{ minWidth: 0 }}>
                    <Avatar src={profilePic ?? null} name={r.channel?.display_name ?? '?'} size={24} />
                    <PlatformPip id={r.channel?.platform ?? 'twitch'} size={11} />
                    <span
                      style={{
                        fontWeight: 500,
                        color: 'var(--fg)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.channel?.display_name ?? r.channel_id.slice(0, 8)}
                    </span>
                  </Row>
                </td>
                {kind === 'riser' ? (
                  <>
                    <td style={{ ...miniTd, ...numericTd, color: 'var(--fg-muted)' }}>
                      {fmtCompact(r.baseline_peak ?? 0)} →{' '}
                      <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtCompact(r.cur_peak)}</span>
                    </td>
                    <td style={{ ...miniTd, textAlign: 'right' }}>
                      <span title={`Peak is ${(r.ratio ?? 0).toFixed(1)}× the 7-day baseline`}>
                        <Pill tone={(r.ratio ?? 0) >= 3 ? 'warn' : 'live'}>×{(r.ratio ?? 0).toFixed(1)}</Pill>
                      </span>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ ...miniTd, ...numericTd, fontWeight: 600 }}>{fmtCompact(r.cur_peak)}</td>
                    <td style={{ ...miniTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.cls === 'new' ? (
                        <span title={r.joined_at ? `First seen ${fmtRelative(r.joined_at)}` : 'First seen by this tracker'}>
                          <Pill tone="info">new</Pill>
                          {r.joined_at && (
                            <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--fg-dim)' }}>
                              {fmtRelative(r.joined_at)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span title="Has history on this tracker, but nothing in the previous 7 days">
                          <Pill>returning</Pill>
                        </span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
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
        {isRange ? (
          <RangeRowsTable rows={rangeRows} slug={slug} />
        ) : (
          <PointSnapshotTable rows={pointSnapshot} slug={slug} />
        )}
      </div>
    </Section>
  );
}

/** Clickable drill-in row shared by the two selection tables — the
 *  channel list you get from inspecting the chart used to be a dead end. */
function SnapshotRow({
  slug,
  channelId,
  channel,
  platform,
  cells,
  index,
}: {
  slug: string;
  channelId: string;
  channel: GameTrackerLeaderboardRow['channel'];
  platform: string;
  cells: React.ReactNode;
  index: number;
}) {
  const navigate = useNavigate();
  const to = `/discover/${slug}/channel/${channelId}`;
  const open = () => navigate(to);
  return (
    <tr
      onClick={open}
      {...rowLinkProps(`Open ${channel?.display_name ?? 'channel'} details`, open)}
      style={{ borderBottom: '1px solid var(--border-faint)', cursor: 'pointer' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-sunken)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <td style={{ ...miniTd, color: 'var(--fg-dim)', width: 30, fontFamily: 'var(--font-mono)' }}>
        {index + 1}
      </td>
      <td style={miniTd}>
        <Row gap={8} align="center">
          <PlatformPip id={platform} size={11} />
          {channel ? (
            <ChannelNameWithLink
              name={channel.display_name}
              platform={platform}
              channelIdentifier={channel.channel_identifier}
              to={to}
            />
          ) : (
            <span style={{ color: 'var(--fg-muted)' }}>{channelId.slice(0, 8)}</span>
          )}
        </Row>
      </td>
      {cells}
    </tr>
  );
}

function PointSnapshotTable({ rows, slug }: { rows: GameTrackerLeaderboardRow[] | null; slug: string }) {
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
          <th style={{ ...miniTh, textAlign: 'right' }}>Viewers</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <SnapshotRow
            key={r.channel_id}
            slug={slug}
            channelId={r.channel_id}
            channel={r.channel}
            platform={r.platform}
            index={i}
            cells={
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
            }
          />
        ))}
      </tbody>
    </table>
  );
}

function RangeRowsTable({ rows, slug }: { rows: GameTrackerRangeLeaderboardRow[] | null; slug: string }) {
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
          <th style={{ ...miniTh, textAlign: 'right' }}>Hours</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <SnapshotRow
            key={r.channel_id}
            slug={slug}
            channelId={r.channel_id}
            channel={r.channel}
            platform={r.platform}
            index={i}
            cells={
              <>
                <td style={{ ...miniTd, ...numericTd, fontWeight: 600 }}>{fmtCompact(r.peak_ccv)}</td>
                <td style={{ ...miniTd, ...numericTd, color: 'var(--fg-muted)' }}>
                  {fmtCompact(r.avg_ccv)}
                </td>
                <td style={{ ...miniTd, ...numericTd, color: 'var(--fg-dim)' }}>
                  {(r.minutes_live / 60).toFixed(1)}h
                </td>
              </>
            }
          />
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
      <Section title="Breakdown" eyebrow="SHARE OF WATCH TIME">
        <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Loading…</div>
      </Section>
    );
  }

  // Number() guard: older backends serialize pg SUM() results as strings,
  // which would string-concatenate here and zero out every share.
  const platformTotal = breakdown.platform.reduce((sum, p) => sum + Number(p.total_ccv_minutes), 0);
  const languageTotal = breakdown.language.reduce((sum, p) => sum + Number(p.total_ccv_minutes), 0);

  return (
    <Section title="Breakdown" eyebrow="SHARE OF WATCH TIME">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 22 }}>
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
            label: (
              <span style={{ textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {p.language ?? 'Unknown'}
              </span>
            ),
            value: Number(p.total_ccv_minutes),
            share: languageTotal > 0 ? Number(p.total_ccv_minutes) / languageTotal : 0,
          }))}
        />
      </div>
      {breakdown.language.slice(0, 6).some((l) => !l.language) && (
        <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          Unknown = streams without a language tag; TikTok's feed carries none.
        </div>
      )}
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
  fontSize: 10.5,
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
