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
  HeroKPIs,
  ThemeToggle,
} from '@/components/design';
import { fmtCompact, fmtN, fmtDateLong } from '@/design/format';
import { getPlatform } from '@/design/platforms';
import { useDashboardModel, type ChannelRow } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { getStreamUrl, languageFullName } from '@/utils/formatters';
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
  const { shortName, scopeSlug } = useParams<{ shortName: string; scopeSlug?: string }>();
  const [searchParams] = useSearchParams();
  // Legacy query params (backwards-compat for shared links that used UUIDs):
  //   ?day=<uuid>, ?stage=<uuid>
  // New friendly path segment lives at /report/:variant/:scopeSlug, where
  // scopeSlug is YYYY-MM-DD (day), stage-<order> (stage), or a raw UUID.
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
  //   - /report/:variant/:scopeSlug path segment wins (YYYY-MM-DD → day,
  //     stage-<order> → stage, UUID → day or stage)
  //   - legacy ?stage=<id> / ?day=<id> query params still resolve
  //   - otherwise auto-pick the latest stage where every broadcast day is
  //     marked completed (so the preview always lands on real post-event data)
  //   - else fall back to series-level scope
  const resolvedScope: { level: ScopeLevel; id: string; label: string } | null = useMemo(() => {
    if (!seriesInfo) return null;

    const allDays = seriesInfo.stages.flatMap((s) => s.broadcast_days);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const STAGE_RE = /^stage-(\d+)$/i;

    if (scopeSlug) {
      if (DATE_RE.test(scopeSlug)) {
        const d = allDays.find((x) => String(x.date).startsWith(scopeSlug));
        if (d) return { level: 'day', id: d.id, label: d.label };
      }
      const stageMatch = scopeSlug.match(STAGE_RE);
      if (stageMatch) {
        const order = parseInt(stageMatch[1]!, 10);
        const s = seriesInfo.stages.find((x) => x.order === order);
        if (s) return { level: 'stage', id: s.id, label: s.name };
      }
      if (UUID_RE.test(scopeSlug)) {
        const d = allDays.find((x) => x.id === scopeSlug);
        if (d) return { level: 'day', id: d.id, label: d.label };
        const s = seriesInfo.stages.find((x) => x.id === scopeSlug);
        if (s) return { level: 'stage', id: s.id, label: s.name };
      }
    }

    if (dayIdFromUrl) {
      for (const s of seriesInfo.stages) {
        const d = s.broadcast_days.find((x) => x.id === dayIdFromUrl);
        // For day-level reports, the stage name is contextually redundant
        // in the title. Use just the day label so the headline reads
        // "PUBG EMEA Championship — Day 3" rather than triple-nesting.
        if (d) return { level: 'day', id: d.id, label: d.label };
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
  }, [seriesInfo, scopeSlug, stageIdFromUrl, dayIdFromUrl]);

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

  // Compute the scope-appropriate date range — the report shouldn't claim
  // "6 Mar – 10 May" when it's only covering a stage inside that window.
  // MUST run before any early-return below to preserve the hook order
  // (React error #310 if this moves below the loading/error guards).
  const { scopeStart, scopeEnd } = useMemo(() => {
    if (!seriesInfo) {
      return { scopeStart: null as string | null, scopeEnd: null as string | null };
    }
    if (!resolvedScope) {
      return {
        scopeStart: seriesInfo.startDate ?? null,
        scopeEnd: seriesInfo.endDate ?? null,
      };
    }
    if (resolvedScope.level === 'day') {
      for (const s of seriesInfo.stages) {
        const d = s.broadcast_days.find((x) => x.id === resolvedScope.id);
        if (d) return { scopeStart: d.date, scopeEnd: d.date };
      }
    }
    if (resolvedScope.level === 'stage') {
      const s = seriesInfo.stages.find((x) => x.id === resolvedScope.id);
      if (s) {
        // Prefer explicit stage start/end dates; fall back to derived
        // min/max from broadcast_days (covers the common case where
        // stage.start_date / end_date aren't set).
        const dayDates = s.broadcast_days
          .map((d) => d.date)
          .filter((x): x is string => !!x)
          .sort();
        return {
          scopeStart: s.start_date ?? dayDates[0] ?? null,
          scopeEnd: s.end_date ?? dayDates[dayDates.length - 1] ?? null,
        };
      }
    }
    return {
      scopeStart: seriesInfo.startDate ?? null,
      scopeEnd: seriesInfo.endDate ?? null,
    };
  }, [resolvedScope, seriesInfo]);

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
        scopeStart={scopeStart}
        scopeEnd={scopeEnd}
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
      scopeStart={scopeStart}
      scopeEnd={scopeEnd}
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
  scopeStart,
  scopeEnd,
}: {
  seriesInfo: PublicSeriesInfo;
  model: ReturnType<typeof useDashboardModel>;
  timeline: ReturnType<typeof useTimelineSeries>;
  shortName: string;
  scopeLabel: string;
  scopeLevel: ScopeLevel;
  scopeStart: string | null;
  scopeEnd: string | null;
}) {
  const totalDayCount = useMemo(() => {
    if (scopeLevel === 'day') return 1;
    if (scopeLevel === 'stage') {
      const stage = seriesInfo.stages.find((s) => s.name === scopeLabel);
      return stage?.broadcast_days.length ?? 0;
    }
    return seriesInfo.stages.reduce((acc, s) => acc + s.broadcast_days.length, 0);
  }, [seriesInfo, scopeLabel, scopeLevel]);

  // Correct tier peaks from the timeline (see DetailedReport for context).
  const tierRowsCorrected = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of timeline.region) {
      const id = (s.id ?? '').toLowerCase();
      if (!id) continue;
      m.set(id, s.sum ?? (s.data.length ? Math.max(...s.data) : 0));
    }
    return model.tierRows.map((t) => {
      const tp = m.get(t.key);
      return tp != null && tp > 0 ? { ...t, peak: tp } : t;
    });
  }, [model.tierRows, timeline.region]);

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
        {formatScopeDateRange(scopeStart, scopeEnd)}
        {model.trackedChannelCount} channels · {model.platformRows.length} platforms ·{' '}
        {model.languageBreakdown.length} languages · {totalDayCount} broadcast{' '}
        {totalDayCount === 1 ? 'day' : 'days'}
      </div>

      {/* KPIs */}
      <div style={{ marginBottom: 28 }}>
        <HeroKPIs
          variant="md"
          peak={model.peakTotal}
          avg={model.avgTotal}
          hours={model.viewedHours}
          days={totalDayCount}
          timeSeries={timeline.total}
          peakAt={model.peakTotalAt}
          timezone={seriesInfo.timezone}
          peakIncludeDate={scopeLevel !== 'day'}
        />
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
            timestamps={timeline.timestamps}
            timezone={seriesInfo.timezone}
          />
        ) : (
          <div className="placeholder" style={{ height: 180 }}>
            {timeline.loading ? 'Loading…' : 'No time-series data'}
          </div>
        )}
      </div>

      {(() => {
        const visibleTiers = tierRowsCorrected.filter(
          (t) => (t.peak ?? 0) > 0 || (t.viewedHours ?? 0) > 0 || (t.ccv ?? 0) > 0,
        );
        if (visibleTiers.length === 0) return null;
        return (
          <>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              By category
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${visibleTiers.length}, 1fr)`,
                gap: 10,
                marginBottom: 28,
              }}
            >
              {visibleTiers.map((t) => (
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
                  <div
                    className="tabular"
                    style={{ fontSize: 24, fontWeight: 500, marginTop: 4 }}
                  >
                    {fmtCompact(t.peak || t.ccv)}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                    Peak CCV
                  </div>
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
          </>
        );
      })()}

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
  scopeStart,
  scopeEnd,
}: {
  seriesInfo: PublicSeriesInfo;
  model: ReturnType<typeof useDashboardModel>;
  timeline: ReturnType<typeof useTimelineSeries>;
  shortName: string;
  scopeLabel: string;
  scopeLevel: ScopeLevel;
  scopeStart: string | null;
  scopeEnd: string | null;
}) {
  const totalDayCount = useMemo(() => {
    if (scopeLevel === 'day') return 1;
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

  // Leaders — sort authoritatively by peak from the timeline where we can.
  // metrics.languageBreakdown is returned in whatever order the API chose
  // (often by total hours, not peak), so picking [0] was giving us the
  // wrong "top language" whenever a language peaked higher but shorter.
  const topChannel = [...model.leaderboard].sort((a, b) => b.peak - a.peak)[0];
  const topPlatform = [...model.platformRows].sort((a, b) => b.ccv - a.ccv)[0];
  const topLang = useMemo(() => {
    // Prefer timeline peaks — same trick we use for the tier cards.
    const byPeak = new Map<string, number>();
    for (const s of timeline.language) {
      const id = (s.id ?? '').toLowerCase();
      if (!id) continue;
      byPeak.set(id, s.sum ?? (s.data.length ? Math.max(...s.data) : 0));
    }
    const enriched = model.languageBreakdown
      .map((l) => {
        const key = (l.language ?? l.key ?? '').toLowerCase();
        const timelinePeak = byPeak.get(key);
        const peak =
          timelinePeak != null && timelinePeak > 0
            ? timelinePeak
            : l.peakCCV ?? Number(l.peak_ccv ?? 0) ?? 0;
        return { ...l, _peak: peak, _key: key };
      })
      .sort((a, b) => b._peak - a._peak);
    return enriched[0];
  }, [model.languageBreakdown, timeline.language]);
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

  // ── Per-dimension stats: peak CCV + viewed hours ───────────────────────
  // Peak CCV for platforms/languages comes straight from the server's
  // breakdown — that's the authoritative "highest simultaneous viewers"
  // number, which isn't reconstructible from per-channel peaks. Viewed
  // hours isn't in the breakdown response, so we aggregate it from the
  // channel leaderboard (which has hours per channel).

  const platformStats = useMemo(() => {
    const hoursByPlatform = new Map<string, number>();
    for (const c of model.leaderboard) {
      if (!c.platform) continue;
      hoursByPlatform.set(
        c.platform,
        (hoursByPlatform.get(c.platform) ?? 0) + (c.hours ?? 0),
      );
    }
    const totalHours = Array.from(hoursByPlatform.values()).reduce(
      (a, b) => a + b,
      0,
    );
    // Seed from model.platformRows (already filters to tracked platforms
    // and brings in the peak CCV from the breakdown).
    return model.platformRows
      .map((p) => {
        const hours = hoursByPlatform.get(p.id) ?? 0;
        // In post-event mode, model.platformRows.ccv is set to peak CCV;
        // in live mode, ccv is live CCV, so we prefer that for the peak
        // display. Either way it's the biggest per-platform number we have.
        const peak = p.ccv;
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          peak,
          hours,
          peakShare: p.share,
          hoursShare: totalHours > 0 ? hours / totalHours : 0,
        };
      })
      .filter((p) => p.peak > 0 || p.hours > 0);
  }, [model.leaderboard, model.platformRows]);

  const languageStats = useMemo(() => {
    // Hours come from the leaderboard (no per-language viewed-hours on the
    // breakdown endpoint). Peaks come from the timeline — same trick as
    // the tier cards — because metrics.languageBreakdown.peakCCV can lag
    // or under-report for stages where channels peaked at the same minute.
    const hoursByLang = new Map<string, number>();
    for (const c of model.leaderboard) {
      const lang = (c.language ?? '').toLowerCase();
      if (!lang) continue;
      hoursByLang.set(lang, (hoursByLang.get(lang) ?? 0) + (c.hours ?? 0));
    }
    const peakByLang = new Map<string, number>();
    for (const s of timeline.language) {
      const id = (s.id ?? '').toLowerCase();
      if (!id) continue;
      peakByLang.set(id, s.sum ?? (s.data.length ? Math.max(...s.data) : 0));
    }
    // Union of keys across the breakdown, timeline, and leaderboard so we
    // don't miss a language that only shows up in one signal.
    const allKeys = new Set<string>();
    for (const l of model.languageBreakdown) {
      const k = (l.language ?? l.key ?? '').toLowerCase();
      if (k) allKeys.add(k);
    }
    for (const k of peakByLang.keys()) allKeys.add(k);
    for (const k of hoursByLang.keys()) allKeys.add(k);

    const totalHours = Array.from(hoursByLang.values()).reduce(
      (a, b) => a + b,
      0,
    );
    const rows = Array.from(allKeys).map((key) => {
      const breakdown = model.languageBreakdown.find(
        (l) => (l.language ?? l.key ?? '').toLowerCase() === key,
      );
      const timelinePeak = peakByLang.get(key) ?? 0;
      const breakdownPeak =
        breakdown?.peakCCV ?? Number(breakdown?.peak_ccv ?? 0) ?? 0;
      const peak = timelinePeak > 0 ? timelinePeak : breakdownPeak;
      const hours = hoursByLang.get(key) ?? 0;
      return { key, label: key.toUpperCase() || '—', peak, hours };
    });
    const totalPeak = rows.reduce((a, r) => a + r.peak, 0);
    return rows
      .map((r) => ({
        ...r,
        peakShare: totalPeak > 0 ? r.peak / totalPeak : 0,
        hoursShare: totalHours > 0 ? r.hours / totalHours : 0,
      }))
      .filter((r) => r.peak > 0 || r.hours > 0);
  }, [model.leaderboard, model.languageBreakdown, timeline.language]);

  // ── Correct tier peaks from the timeline ────────────────────────────
  // The tier peak in model.tierRows is Math.max() of per-channel peaks,
  // which underestimates the true "highest simultaneous CCV in that
  // tier" when multiple channels peak at the same minute. The timeline
  // hook fetches a grouped-by-tier time series whose per-tier max IS
  // that authoritative number — use it to override tierRows[].peak so
  // the cards agree with the chart legend at the top of the page.
  const tierPeakFromTimeline = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of timeline.region) {
      const id = (s.id ?? '').toLowerCase();
      if (!id) continue;
      const peak = s.sum ?? (s.data.length ? Math.max(...s.data) : 0);
      m.set(id, peak);
    }
    return m;
  }, [timeline.region]);

  const tierRowsCorrected = useMemo(
    () =>
      model.tierRows.map((t) => {
        const timelinePeak = tierPeakFromTimeline.get(t.key);
        return timelinePeak != null && timelinePeak > 0
          ? { ...t, peak: timelinePeak }
          : t;
      }),
    [model.tierRows, tierPeakFromTimeline],
  );

  // ── Per-section metric toggles (Peak CCV vs Viewed Hours) ─────────────
  const [tierMetric, setTierMetric] = useState<'peak' | 'hours'>('peak');
  const [platformMetric, setPlatformMetric] = useState<'peak' | 'hours'>('hours');
  const [languageMetric, setLanguageMetric] = useState<'peak' | 'hours'>('hours');

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
        {formatScopeDateRange(scopeStart, scopeEnd)}
        {model.trackedChannelCount} tracked channels · {model.platformRows.length} platforms ·{' '}
        {model.languageBreakdown.length} languages · {fmtN(model.peakTotal)} peak concurrent.
      </div>

      {/* HeroKPIs — 3-cell strip with micro visualizations (v6) */}
      <div style={{ marginBottom: 32 }}>
        <HeroKPIs
          variant="xl"
          peak={model.peakTotal}
          avg={model.avgTotal}
          hours={model.viewedHours}
          days={totalDayCount}
          timeSeries={timeline.total}
          peakAt={model.peakTotalAt}
          timezone={seriesInfo.timezone}
          peakIncludeDate={scopeLevel !== 'day'}
        />
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
            timestamps={timeline.timestamps}
            timezone={seriesInfo.timezone}
          />
        ) : (
          <div className="placeholder" style={{ height: 280 }}>
            {timeline.loading ? 'Loading…' : 'No time-series data'}
          </div>
        )}
      </Section>

      <div style={{ height: 24 }} />

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
            sub: `${fmtCompact(topChannel.peak)} peak · ${languageFullName(topChannel.language)}`,
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
            value: languageFullName(topLang._key),
            // _peak is timeline-derived and is what sorted this entry to
            // the top — display it here so the number agrees with the chart.
            sub: `${fmtCompact(topLang._peak)} peak CCV`,
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

      {/* Section 02 — By category (tier breakdown) */}
      {(() => {
        // Filter out tiers with zero data so empty buckets (e.g. no Partner
        // streams on this day) don't clutter the grid with "0" cards.
        const visibleTiers = tierRowsCorrected.filter(
          (t) => (t.peak ?? 0) > 0 || (t.viewedHours ?? 0) > 0 || (t.ccv ?? 0) > 0,
        );
        if (visibleTiers.length === 0) return null;
        // Recompute share based on the selected metric within visible tiers
        // so the percentages sum to ~100% against what's shown.
        const denom =
          tierMetric === 'hours'
            ? visibleTiers.reduce((a, t) => a + (t.viewedHours ?? 0), 0)
            : visibleTiers.reduce((a, t) => a + (t.peak || t.ccv || 0), 0);
        return (
          <>
            <Section
              eyebrow="02 · By category"
              title={
                tierMetric === 'hours'
                  ? 'Viewed hours by category'
                  : 'Peak concurrent by category'
              }
              right={
                <MetricToggle value={tierMetric} onChange={setTierMetric} />
              }
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${visibleTiers.length}, 1fr)`,
                  gap: 10,
                }}
              >
                {visibleTiers.map((t) => {
                  const val =
                    tierMetric === 'hours' ? t.viewedHours ?? 0 : t.peak || t.ccv || 0;
                  const share = denom > 0 ? val / denom : 0;
                  return (
                    <div key={t.key} className="card" style={{ padding: 16 }}>
                      <Row justify="space-between">
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {t.label}
                        </span>
                        <span
                          className="tabular"
                          style={{ fontSize: 11, color: 'var(--fg-dim)' }}
                        >
                          {(share * 100).toFixed(0)}%
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
                        {fmtCompact(val)}
                      </div>
                      <div
                        style={{ fontSize: 11, color: 'var(--fg-muted)' }}
                      >
                        {tierMetric === 'hours' ? 'Viewed hours' : 'Peak CCV'}
                      </div>
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
                            width: share * 100 + '%',
                            height: '100%',
                            background: t.color,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
            <div style={{ height: 24 }} />
          </>
        );
      })()}

      {/* Section 03 + 04 — platforms + languages side-by-side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Section
          eyebrow="03 · Platforms"
          title={
            platformMetric === 'hours'
              ? 'Share of viewed hours'
              : 'Share of peak CCV'
          }
          right={
            <MetricToggle value={platformMetric} onChange={setPlatformMetric} />
          }
        >
          <Col gap={10}>
            {platformStats.map((p) => {
              const share =
                platformMetric === 'hours' ? p.hoursShare : p.peakShare;
              const val = platformMetric === 'hours' ? p.hours : p.peak;
              return (
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
                        width: share * 100 + '%',
                        height: '100%',
                        background: p.color,
                      }}
                    />
                  </div>
                  <span
                    className="tabular"
                    style={{
                      width: 70,
                      textAlign: 'right',
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                    }}
                    title={
                      platformMetric === 'hours'
                        ? `${fmtN(val)} viewed hours`
                        : `${fmtN(val)} peak CCV`
                    }
                  >
                    {fmtCompact(val)}
                  </span>
                  <span
                    className="tabular"
                    style={{ width: 44, textAlign: 'right', fontSize: 12 }}
                  >
                    {(share * 100).toFixed(0)}%
                  </span>
                </Row>
              );
            })}
          </Col>
        </Section>
        {languageStats.length > 0 && (
          <Section
            eyebrow="04 · Languages"
            title={
              languageMetric === 'hours'
                ? `Viewed hours by language · ${languageStats.length} tracked`
                : `Peak CCV by language · ${languageStats.length} tracked`
            }
            right={
              <MetricToggle value={languageMetric} onChange={setLanguageMetric} />
            }
          >
            <div style={{ height: 220 }}>
              <VBarChart
                width={540}
                height={220}
                items={[...languageStats]
                  .sort((a, b) =>
                    languageMetric === 'hours' ? b.hours - a.hours : b.peak - a.peak,
                  )
                  .slice(0, 8)
                  .map((l, i) => ({
                    label: l.label,
                    value: languageMetric === 'hours' ? l.hours : l.peak,
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
      {(() => {
        // For post-event scopes there are no live channels, so "Live coverage"
        // would always render "0% · 0 of N live now" which just looks broken.
        // Swap it for the peak:avg concurrency ratio, which is a real signal
        // about how bursty viewership was over the event.
        const hasLive = model.liveChannelCount > 0;
        const cells: Array<[string, string, string]> = [
          ['Avg CCV / channel', fmtCompact(avgPerChannel), 'across tracked streams'],
          ['Hours / channel', fmtCompact(hoursPerChannel), 'mean airtime watched'],
          hasLive
            ? [
                'Live coverage',
                liveChannelsShare + '%',
                `${model.liveChannelCount} of ${model.trackedChannelCount} live now`,
              ]
            : [
                'Peak : avg',
                concurrency,
                'peak-to-average concurrency ratio',
              ],
          ['Avg broadcast / day', fmtCompact(hoursPerDay), 'hours watched daily'],
        ];
        return (
          <Section
            eyebrow="05 · Operational breakdown"
            title="Per-channel & airtime stats"
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 0,
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
              }}
            >
              {cells.map(([l, v, sub], i, a) => (
                <div
                  key={l}
                  style={{
                    padding: '16px 18px',
                    borderRight:
                      i < a.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <Kpi size="sm" label={l} value={v} sub={sub} />
                </div>
              ))}
            </div>
          </Section>
        );
      })()}

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

  const cols = '28px 1.4fr 95px 110px 100px 90px 90px 110px';

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
        <H k="platform">Platform</H>
        <H k="tier">Category</H>
        <H k="language">Language</H>
        <H k="peak" align="right">
          Peak
        </H>
        <H k="avg" align="right">
          Avg
        </H>
        <H k="hours" align="right">
          Viewed Hours
        </H>
      </div>
      {sorted.map((c, i) => {
        const url = c.channelIdentifier
          ? getStreamUrl(c.platform, c.channelIdentifier)
          : null;
        const nameStyle = {
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        } as const;
        return (
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
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...nameStyle, color: 'inherit', textDecoration: 'none', display: 'block', minWidth: 0 }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {c.name}
                </a>
              ) : (
                <span style={nameStyle}>{c.name}</span>
              )}
            </Row>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {getPlatform(c.platform ?? '')?.name ?? c.platform ?? '—'}
            </div>
            <div>
              <TierBadge tier={c.tier} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {languageFullName(c.language)}
            </div>
            <div className="tabular" style={{ textAlign: 'right' }}>
              {fmtN(c.peak)}
            </div>
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtN(c.avg)}
            </div>
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtN(c.hours)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Scope-appropriate date range formatter ────────────────────────────────
// Renders "Apr 11, 2026 · " for a single day, "Apr 8 – Apr 13, 2026 · "
// for a stage, and the full series range when no scope is active. Returns
// an empty string if both dates are missing.
function formatScopeDateRange(
  start: string | null,
  end: string | null,
): string {
  if (!start && !end) return '';
  if (start && end && start === end) return `${fmtDateLong(start)} · `;
  if (start && end) return `${fmtDateLong(start)} – ${fmtDateLong(end)} · `;
  if (start) return `From ${fmtDateLong(start)} · `;
  return `Until ${fmtDateLong(end!)} · `;
}

// ── Peak / Viewed Hours segmented toggle ───────────────────────────────────

function MetricToggle({
  value,
  onChange,
}: {
  value: 'peak' | 'hours';
  onChange: (v: 'peak' | 'hours') => void;
}) {
  const opts: Array<{ id: 'peak' | 'hours'; label: string }> = [
    { id: 'peak', label: 'Peak' },
    { id: 'hours', label: 'Viewed Hours' },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 2,
      }}
    >
      {opts.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              fontSize: 10.5,
              fontWeight: active ? 600 : 500,
              background: active ? 'var(--red)' : 'transparent',
              color: active ? 'white' : 'var(--fg-muted)',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.02em',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
