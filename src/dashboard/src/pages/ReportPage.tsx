/**
 * Exported HTML report — simple + detailed variants.
 * Ported from design_handoff_clutch_tracker/reference/src/report.jsx.
 *
 * Routes:
 *   /public/:shortName/report/simple
 *   /public/:shortName/report/detailed
 *
 * Uses only real DB fields (no invented narrative). Shares
 * InteractiveMainChart with Public / Editor Desktop.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { usePollingApi } from '@/hooks/useApi';
import type {
  LiveCCVResponse,
  MetricsResponse,
  ScopeLevel,
} from '@/types/api';
import {
  Row,
  Col,
  ClutchWordmark,
  Pill,
  PlatformPip,
  TierBadge,
  VBarChart,
  Section,
  InteractiveMainChart,
  Kpi,
  ThemeToggle,
} from '@/components/design';
import { fmtCompact, fmtN, fmtDateLong } from '@/design/format';
import { useDashboardModel, type ChannelRow } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { usePublicPollingData } from '@/hooks/usePublicPollingData';
import { Spinner } from '@/components/common/Loader';
import * as api from '@/services/api';
import type { PublicSeriesInfo } from '@/services/api';
import type { SeriesWithStages } from '@/types/api';

const REGION_LABELS: Record<string, { label: string; desc: string }> = {
  global: { label: 'Global', desc: 'Official multi-region feeds' },
  west: { label: 'West', desc: 'EN / DE / FR / ES / PT' },
  east: { label: 'East', desc: 'RU / TR / PL' },
  apac: { label: 'APAC', desc: 'KO / JA / ZH / TH / VI' },
  emea: { label: 'EMEA', desc: 'Europe, Middle East, Africa' },
  americas: { label: 'Americas', desc: 'NA / SA' },
};

export type ReportVariant = 'simple' | 'detailed';

export function ReportPage({ variant }: { variant: ReportVariant }) {
  const { shortName } = useParams<{ shortName: string }>();
  const [searchParams] = useSearchParams();
  const stageIdFromUrl = searchParams.get('stage') ?? undefined;
  const dayIdFromUrl = searchParams.get('day') ?? undefined;

  const [seriesInfo, setSeriesInfo] = useState<PublicSeriesInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shortName) return;
    setLoading(true);
    api
      .getPublicSeries(shortName)
      .then((info) => {
        setSeriesInfo(info);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load series');
        setLoading(false);
      });
  }, [shortName]);

  const seriesId = seriesInfo?.id;
  const pollingData = usePublicPollingData(shortName, seriesId);

  const seriesDetail = useMemo<SeriesWithStages | null>(() => {
    if (!seriesInfo) return null;
    return {
      id: seriesInfo.id,
      name: seriesInfo.name,
      short_name: seriesInfo.shortName,
      game: seriesInfo.game,
      partner: seriesInfo.partner,
      status: seriesInfo.status,
      timezone: seriesInfo.timezone,
      auto_start_polling: false,
      min_role: 'viewer',
      start_date: seriesInfo.startDate,
      end_date: seriesInfo.endDate,
      discovery_keywords: [],
      discovery_game_ids: {},
      discovery_default_tier: 'community',
      is_public: true,
      metadata: {},
      created_at: '',
      updated_at: '',
      stages: seriesInfo.stages.map((s) => ({
        id: s.id,
        series_id: seriesInfo.id,
        name: s.name,
        order: s.order,
        start_date: s.start_date,
        end_date: s.end_date,
        status: 'active',
        metadata: {},
        created_at: '',
        updated_at: '',
        broadcast_days: s.broadcast_days.map((d) => ({
          id: d.id,
          stage_id: s.id,
          series_id: seriesInfo.id,
          label: d.label,
          date: d.date,
          broadcast_start: d.broadcast_start,
          broadcast_end: d.broadcast_end,
          status: d.status,
          metadata: {},
          created_at: '',
          updated_at: '',
        })),
      })),
    };
  }, [seriesInfo]);

  // Pick the report's scope:
  //   - explicit ?stage=<id> or ?day=<id> URL param wins
  //   - otherwise auto-pick the latest stage where every broadcast day is
  //     marked completed (so the preview always lands on real post-event data)
  //   - else fall back to series-level scope
  const resolvedScope: { level: ScopeLevel; id: string; label: string } | null = useMemo(() => {
    if (!seriesInfo) return null;
    if (dayIdFromUrl) {
      for (const s of seriesInfo.stages) {
        const d = s.broadcast_days.find((x) => x.id === dayIdFromUrl);
        if (d) return { level: 'day', id: d.id, label: `${s.name} · ${d.label}` };
      }
    }
    if (stageIdFromUrl) {
      const s = seriesInfo.stages.find((x) => x.id === stageIdFromUrl);
      if (s) return { level: 'stage', id: s.id, label: s.name };
    }
    // Highest-order stage whose every broadcast day is completed.
    const completedStages = [...seriesInfo.stages]
      .filter(
        (s) => s.broadcast_days.length > 0 && s.broadcast_days.every((d) => d.status === 'completed'),
      )
      .sort((a, b) => b.order - a.order);
    const pick = completedStages[0];
    if (pick) return { level: 'stage', id: pick.id, label: pick.name };
    return { level: 'series', id: seriesInfo.id, label: seriesInfo.name };
  }, [seriesInfo, stageIdFromUrl, dayIdFromUrl]);

  // Scoped metrics — override pollingData.metrics when we have a sub-scope.
  const needsScopedFetch = !!resolvedScope && resolvedScope.level !== 'series';
  const scopeCacheKey = resolvedScope
    ? `${resolvedScope.level}:${resolvedScope.id}`
    : '';

  const { data: scopedMetrics } = usePollingApi<MetricsResponse>(
    () =>
      needsScopedFetch && shortName && resolvedScope
        ? api.getPublicMetrics(shortName, resolvedScope.level, resolvedScope.id)
        : Promise.resolve(null as unknown as MetricsResponse),
    [shortName, scopeCacheKey],
    { intervalMs: 60_000, enabled: needsScopedFetch && !!shortName },
  );

  const { data: scopedLiveCCV } = usePollingApi<LiveCCVResponse>(
    () =>
      needsScopedFetch && shortName && resolvedScope
        ? api.getPublicLiveCCV(shortName, resolvedScope.level, resolvedScope.id)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [shortName, scopeCacheKey],
    { intervalMs: 60_000, enabled: needsScopedFetch && !!shortName },
  );

  const model = useDashboardModel({
    seriesDetail,
    metrics: needsScopedFetch ? scopedMetrics : pollingData.metrics,
    liveCCV: needsScopedFetch ? scopedLiveCCV : pollingData.liveCCV,
  });

  const scope = resolvedScope
    ? { level: resolvedScope.level, id: resolvedScope.id }
    : null;
  const timeline = useTimelineSeries({
    scope,
    interval: 300,
    publicShortName: shortName,
    refreshMs: 60_000,
  });

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !seriesInfo) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>Series not found</h1>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 6 }}>
            {error ?? 'This series does not exist or is not publicly available.'}
          </p>
        </div>
      </div>
    );
  }

  if (variant === 'simple') {
    return (
      <SimpleReport
        seriesInfo={seriesInfo}
        model={model}
        timeline={timeline}
        shortName={shortName!}
        scopeLabel={resolvedScope?.label ?? seriesInfo.name}
        scopeLevel={resolvedScope?.level ?? 'series'}
      />
    );
  }
  return (
    <DetailedReport
      seriesInfo={seriesInfo}
      model={model}
      timeline={timeline}
      shortName={shortName!}
      scopeLabel={resolvedScope?.label ?? seriesInfo.name}
      scopeLevel={resolvedScope?.level ?? 'series'}
    />
  );
}

// ── Simple report ──────────────────────────────────────────────────────────

function SimpleReport({
  seriesInfo,
  model,
  timeline,
  shortName,
  scopeLabel,
  scopeLevel,
}: {
  seriesInfo: PublicSeriesInfo;
  model: ReturnType<typeof useDashboardModel>;
  timeline: ReturnType<typeof useTimelineSeries>;
  shortName: string;
  scopeLabel: string;
  scopeLevel: ScopeLevel;
}) {
  const totalDayCount = useMemo(() => {
    if (scopeLevel === 'stage') {
      const stage = seriesInfo.stages.find((s) => s.name === scopeLabel);
      return stage?.broadcast_days.length ?? 0;
    }
    return seriesInfo.stages.reduce((acc, s) => acc + s.broadcast_days.length, 0);
  }, [seriesInfo, scopeLabel, scopeLevel]);

  const eyebrow =
    scopeLevel === 'stage' ? 'Stage report' : scopeLevel === 'day' ? 'Broadcast day report' : 'Series report';
  const headline =
    scopeLevel === 'series'
      ? seriesInfo.name
      : `${seriesInfo.name} — ${scopeLabel}`;

  return (
    <div
      style={{
        padding: '48px 56px',
        maxWidth: 900,
        margin: '0 auto',
        background: 'var(--bg)',
        minHeight: '100vh',
      }}
    >
      <Row justify="space-between" style={{ marginBottom: 32 }}>
        <ClutchWordmark size={20} />
        <Row gap={8}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            Simple report · {new Date().toLocaleDateString()}
          </span>
          <ThemeToggle />
        </Row>
      </Row>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        {eyebrow}
      </div>
      <h1
        style={{
          fontSize: 42,
          lineHeight: 1.06,
          marginBottom: 6,
          fontWeight: 600,
          letterSpacing: '-0.025em',
        }}
      >
        {headline}
      </h1>
      <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: 28 }}>
        {seriesInfo.startDate && seriesInfo.endDate
          ? `${fmtDateLong(seriesInfo.startDate)} – ${fmtDateLong(seriesInfo.endDate)} · `
          : seriesInfo.startDate
            ? `From ${fmtDateLong(seriesInfo.startDate)} · `
            : ''}
        {model.trackedChannelCount} channels · {model.platformRows.length} platforms ·{' '}
        {model.languageBreakdown.length} languages · {totalDayCount} broadcast{' '}
        {totalDayCount === 1 ? 'day' : 'days'}
      </div>

      {/* KPIs */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 0,
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          marginBottom: 28,
        }}
      >
        {[
          ['Peak CCV', fmtN(model.peakTotal)],
          ['Avg CCV', fmtCompact(model.avgTotal)],
          ['Hours', fmtCompact(model.viewedHours)],
          ['Channels', fmtN(model.trackedChannelCount)],
        ].map(([l, v], i, a) => (
          <div
            key={l}
            style={{
              padding: '18px 16px',
              borderRight: i < a.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <div className="eyebrow" style={{ fontSize: 9 }}>
              {l}
            </div>
            <div
              className="tabular"
              style={{ fontSize: 26, fontWeight: 500, marginTop: 4 }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>

      <div className="eyebrow" style={{ marginBottom: 8 }}>
        Viewership over time · by platform
      </div>
      <div style={{ marginBottom: 28 }}>
        {timeline.total.length > 0 ? (
          <InteractiveMainChart
            height={180}
            width={820}
            series={{
              platform: timeline.platform,
              region: timeline.region,
              language: timeline.language,
              total: timeline.total,
            }}
            totalData={timeline.total}
          />
        ) : (
          <div className="placeholder" style={{ height: 180 }}>
            {timeline.loading ? 'Loading…' : 'No time-series data'}
          </div>
        )}
      </div>

      <div className="eyebrow" style={{ marginBottom: 8 }}>
        By category
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 10,
          marginBottom: 28,
        }}
      >
        {model.tierRows.map((t) => (
          <div key={t.key} className="card" style={{ padding: 14 }}>
            <Row justify="space-between">
              <div style={{ fontSize: 12, fontWeight: 600 }}>{t.label}</div>
              <span
                className="tabular"
                style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}
              >
                {(t.share * 100).toFixed(0)}%
              </span>
            </Row>
            <div className="tabular" style={{ fontSize: 24, fontWeight: 500, marginTop: 4 }}>
              {fmtCompact(t.peak || t.ccv)}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>Peak CCV</div>
            <div
              style={{
                marginTop: 8,
                height: 4,
                background: 'var(--bg-sunken)',
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: t.share * 100 + '%',
                  height: '100%',
                  background: t.color,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 40, fontSize: 10, color: 'var(--fg-dim)' }}>
        Clutch Viewership Tracker · tracker.clutch.game/public/{shortName}
      </div>
    </div>
  );
}

// ── Detailed report ─────────────────────────────────────────────────────────

function DetailedReport({
  seriesInfo,
  model,
  timeline,
  shortName,
  scopeLabel,
  scopeLevel,
}: {
  seriesInfo: PublicSeriesInfo;
  model: ReturnType<typeof useDashboardModel>;
  timeline: ReturnType<typeof useTimelineSeries>;
  shortName: string;
  scopeLabel: string;
  scopeLevel: ScopeLevel;
}) {
  const totalDayCount = useMemo(() => {
    if (scopeLevel === 'stage') {
      const stage = seriesInfo.stages.find((s) => s.name === scopeLabel);
      return stage?.broadcast_days.length ?? 0;
    }
    return seriesInfo.stages.reduce((acc, s) => acc + s.broadcast_days.length, 0);
  }, [seriesInfo, scopeLabel, scopeLevel]);

  const eyebrow =
    scopeLevel === 'stage' ? `Stage report · ${scopeLabel}` : scopeLevel === 'day' ? `Broadcast day · ${scopeLabel}` : 'Executive summary';
  const headline =
    scopeLevel === 'series' ? seriesInfo.name : `${seriesInfo.name} — ${scopeLabel}`;

  // Leaders
  const topChannel = [...model.leaderboard].sort((a, b) => b.peak - a.peak)[0];
  const topPlatform = model.platformRows[0];
  const topLang = model.languageBreakdown[0];
  const topRegion = model.regionBreakdown[0];

  const concurrency =
    model.peakTotal && model.avgTotal && model.avgTotal > 0
      ? (model.peakTotal / model.avgTotal).toFixed(2) + '×'
      : '—';

  const avgPerChannel =
    model.avgTotal && model.trackedChannelCount > 0
      ? Math.round(model.avgTotal / model.trackedChannelCount)
      : 0;

  const hoursPerChannel =
    model.viewedHours && model.trackedChannelCount > 0
      ? Math.round(model.viewedHours / model.trackedChannelCount)
      : 0;

  const hoursPerDay =
    model.viewedHours && totalDayCount > 0
      ? Math.round(model.viewedHours / totalDayCount)
      : 0;

  const liveChannelsShare =
    model.trackedChannelCount > 0
      ? Math.round((model.liveChannelCount / model.trackedChannelCount) * 100)
      : 0;

  const palette = [
    'var(--red)', 'var(--info)', 'var(--warn)', 'var(--live)',
    'var(--twitch)', 'var(--tiktok)', 'var(--youtube)', 'var(--kick)',
  ];

  return (
    <div
      style={{
        padding: '48px 56px',
        maxWidth: 1160,
        margin: '0 auto',
        background: 'var(--bg)',
        minHeight: '100vh',
      }}
    >
      <Row justify="space-between" style={{ marginBottom: 32 }}>
        <ClutchWordmark size={22} />
        <Row gap={6}>
          <Pill>Detailed report</Pill>
          <Pill>{totalDayCount} days</Pill>
          <ThemeToggle />
        </Row>
      </Row>

      <div className="eyebrow" style={{ marginBottom: 8 }}>
        {eyebrow}
      </div>
      <h1
        style={{
          fontSize: 46,
          lineHeight: 1.04,
          marginBottom: 8,
          letterSpacing: '-0.03em',
          fontWeight: 600,
        }}
      >
        {headline}
      </h1>
      <div style={{ fontSize: 15, color: 'var(--fg-muted)', marginBottom: 32, maxWidth: 760 }}>
        {seriesInfo.startDate && seriesInfo.endDate
          ? `${fmtDateLong(seriesInfo.startDate)} – ${fmtDateLong(seriesInfo.endDate)} · `
          : ''}
        {model.trackedChannelCount} tracked channels · {model.platformRows.length} platforms ·{' '}
        {model.languageBreakdown.length} languages · {fmtN(model.peakTotal)} peak concurrent.
      </div>

      {/* KPI grid — 3-up per v5 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 0,
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          marginBottom: 32,
        }}
      >
        {[
          ['Peak CCV', fmtN(model.peakTotal), 'single highest moment'],
          ['Avg CCV', fmtCompact(model.avgTotal), 'across broadcast hours'],
          ['Hours watched', fmtCompact(model.viewedHours), 'live viewing only'],
        ].map(([l, v, sub], i, a) => (
          <div
            key={l}
            style={{
              padding: '16px 18px',
              borderRight: i < a.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <Kpi size="sm" label={l} value={v} sub={sub} />
          </div>
        ))}
      </div>

      {/* Leaders strip — 3 cards per v5, with PlatformPip on relevant cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
          marginBottom: 32,
        }}
      >
        {[
          topChannel && {
            label: 'Top channel',
            value: topChannel.name,
            sub: `${fmtCompact(topChannel.peak)} peak · ${(topChannel.language ?? '').toUpperCase() || '—'}`,
            pip: topChannel.platform,
          },
          topPlatform && {
            label: 'Top platform',
            value: topPlatform.name,
            sub: `${fmtCompact(topPlatform.ccv)} · ${(topPlatform.share * 100).toFixed(0)}% share`,
            pip: topPlatform.id,
          },
          topLang && {
            label: 'Top language',
            value: (topLang.language ?? topLang.key ?? '').toUpperCase() || '—',
            sub: `${fmtCompact(topLang.peakCCV ?? Number(topLang.peak_ccv ?? 0) ?? topLang.totalCCV)} peak CCV`,
            pip: null,
          },
        ]
          .filter((e): e is { label: string; value: string; sub: string; pip: string | null } => Boolean(e))
          .map((entry) => {
            const { label: l, value: v, sub, pip } = entry;
            return (
              <div key={l} className="card" style={{ padding: '14px 16px' }}>
                <div className="eyebrow" style={{ fontSize: 9, marginBottom: 4 }}>
                  {l}
                </div>
                <Row gap={8}>
                  {pip && <PlatformPip id={pip} size={14} />}
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 600,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {v}
                  </div>
                </Row>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{sub}</div>
              </div>
            );
          })}
      </div>

      {/* Section 01 — timeline */}
      <Section
        eyebrow="01 · Timeline"
        title="Concurrent viewers — interactive"
        right={<Pill>{totalDayCount}-day span</Pill>}
      >
        {timeline.total.length > 0 ? (
          <InteractiveMainChart
            height={280}
            width={1040}
            series={{
              platform: timeline.platform,
              region: timeline.region,
              language: timeline.language,
              total: timeline.total,
            }}
            totalData={timeline.total}
          />
        ) : (
          <div className="placeholder" style={{ height: 280 }}>
            {timeline.loading ? 'Loading…' : 'No time-series data'}
          </div>
        )}
      </Section>

      <div style={{ height: 24 }} />

      {/* Section 02 — By category (tier breakdown) */}
      <Section eyebrow="02 · By category" title="Peak concurrent by tier">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 10,
          }}
        >
          {model.tierRows.map((t) => (
            <div key={t.key} className="card" style={{ padding: 16 }}>
              <Row justify="space-between">
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                <span
                  className="tabular"
                  style={{ fontSize: 11, color: 'var(--fg-dim)' }}
                >
                  {(t.share * 100).toFixed(0)}%
                </span>
              </Row>
              <div
                className="tabular"
                style={{
                  fontSize: 28,
                  fontWeight: 500,
                  marginTop: 6,
                  letterSpacing: '-0.02em',
                }}
              >
                {fmtCompact(t.peak || t.ccv)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Peak CCV</div>
              <div
                style={{
                  marginTop: 10,
                  height: 5,
                  background: 'var(--bg-sunken)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: t.share * 100 + '%',
                    height: '100%',
                    background: t.color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>
      <div style={{ height: 24 }} />

      {/* Section 03 + 04 — platforms + languages side-by-side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Section eyebrow="03 · Platforms" title="Share of peak CCV">
          <Col gap={10}>
            {model.platformRows.map((p) => (
              <Row key={p.id} gap={10}>
                <Row gap={6} style={{ width: 120 }}>
                  <PlatformPip id={p.id} />
                  <span style={{ fontSize: 12 }}>{p.name}</span>
                </Row>
                <div
                  style={{
                    flex: 1,
                    height: 14,
                    background: 'var(--bg-sunken)',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: p.share * 100 + '%',
                      height: '100%',
                      background: p.color,
                    }}
                  />
                </div>
                <span
                  className="tabular"
                  style={{ width: 56, textAlign: 'right', fontSize: 12 }}
                >
                  {(p.share * 100).toFixed(0)}%
                </span>
              </Row>
            ))}
          </Col>
        </Section>
        {model.languageBreakdown.length > 0 && (
          <Section
            eyebrow="04 · Languages"
            title={`Peak CCV by language · ${model.languageBreakdown.length} tracked`}
          >
            <div style={{ height: 220 }}>
              <VBarChart
                width={540}
                height={220}
                items={model.languageBreakdown.slice(0, 8).map((l, i) => ({
                  label: (l.language ?? l.key ?? '').toUpperCase() || '—',
                  value: l.peakCCV ?? Number(l.peak_ccv ?? 0) ?? l.totalCCV ?? 0,
                  sub: '',
                  color: palette[i % palette.length]!,
                }))}
              />
            </div>
          </Section>
        )}
      </div>

      <div style={{ height: 24 }} />

      {/* Section 05 — operational breakdown */}
      <Section eyebrow="05 · Operational breakdown" title="Per-channel & airtime stats">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 0,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
          }}
        >
          {[
            ['Avg CCV / channel', fmtCompact(avgPerChannel), 'across tracked streams'],
            ['Hours / channel', fmtCompact(hoursPerChannel), 'mean airtime watched'],
            ['Live coverage', liveChannelsShare + '%', `${model.liveChannelCount} of ${model.trackedChannelCount} live now`],
            ['Avg broadcast / day', fmtCompact(hoursPerDay), 'hours watched daily'],
          ].map(([l, v, sub], i, a) => (
            <div
              key={l}
              style={{
                padding: '16px 18px',
                borderRight: i < a.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <Kpi size="sm" label={l} value={v} sub={sub} />
            </div>
          ))}
        </div>
      </Section>

      <div style={{ height: 24 }} />

      {/* Section 06 — leaderboard */}
      <Section
        eyebrow="06 · Leaderboard"
        title={`All ${model.leaderboard.length} tracked channels — sort any column`}
      >
        <Leaderboard channels={model.leaderboard} />
      </Section>

      <div
        style={{
          marginTop: 40,
          paddingTop: 16,
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 11,
          color: 'var(--fg-dim)',
        }}
      >
        <ClutchWordmark size={14} muted />
        <span>tracker.clutch.game/public/{shortName}</span>
      </div>
    </div>
  );
}

// ── Detailed-report sortable leaderboard ───────────────────────────────────

function Leaderboard({ channels }: { channels: ChannelRow[] }) {
  const [sort, setSort] = useState<keyof ChannelRow>('peak');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const sorted = [...channels].sort((a, b) => {
    const av = a[sort] ?? 0;
    const bv = b[sort] ?? 0;
    if (typeof av === 'string' && typeof bv === 'string') {
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return dir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });

  const toggle = (k: keyof ChannelRow) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(k);
      setDir('desc');
    }
  };

  const H = ({
    k,
    children,
    align = 'left',
  }: {
    k: keyof ChannelRow;
    children: React.ReactNode;
    align?: 'left' | 'right' | 'center';
  }) => (
    <button
      type="button"
      onClick={() => toggle(k)}
      style={{
        background: 'none',
        border: 'none',
        textAlign: align,
        padding: 0,
        color: sort === k ? 'var(--fg)' : 'var(--fg-dim)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        width: '100%',
      }}
    >
      {children} {sort === k && <span>{dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );

  const cols = '28px 1.7fr 80px 90px 50px 80px 80px 80px';

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          padding: '0 4px 6px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div />
        <H k="name">Channel</H>
        <H k="region">Region</H>
        <H k="tier">Tier</H>
        <H k="language">Lang</H>
        <H k="peak" align="right">
          Peak
        </H>
        <H k="avg" align="right">
          Avg
        </H>
        <H k="hours" align="right">
          Hours
        </H>
      </div>
      {sorted.map((c, i) => (
        <div
          key={c.id}
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            padding: '8px 4px',
            borderBottom: '1px solid var(--border-faint)',
            fontSize: 12.5,
            alignItems: 'center',
          }}
        >
          <div className="tabular" style={{ color: 'var(--fg-dim)' }}>
            {i + 1}
          </div>
          <Row gap={8} style={{ minWidth: 0 }}>
            <PlatformPip id={c.platform} />
            <span
              style={{
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.name}
            </span>
          </Row>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {c.region
              ? REGION_LABELS[c.region.toLowerCase()]?.label ?? c.region.toUpperCase()
              : '—'}
          </div>
          <div>
            <TierBadge tier={c.tier} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {(c.language ?? '').toUpperCase() || '—'}
          </div>
          <div className="tabular" style={{ textAlign: 'right' }}>
            {fmtCompact(c.peak)}
          </div>
          <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
            {fmtCompact(c.avg)}
          </div>
          <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
            {fmtCompact(c.hours)}
          </div>
        </div>
      ))}
    </div>
  );
}
