/**
 * Public dashboard — editorial live view at tracker.clutch.game/public/<shortName>.
 *
 * Automatically switches between:
 *   - PublicLive: when the series has any broadcast day with status === 'live'
 *   - PublicRecap: when the series is completed (all days done)
 *
 * Ported from design_handoff_clutch_tracker/reference/src/public.jsx
 * (PublicLive + PublicPostEvent / PublicRecap).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { readScopeFromUrl, writeScopeToUrl } from '@/utils/publicScopeUrl';
import { useParams } from 'react-router-dom';
import {
  Row,
  Col,
  ClutchWordmark,
  Pill,
  PlatformPip,
  ChannelNameWithLink,
  TierBadge,
  AreaChart,
  VBarChart,
  Section,
  InteractiveMainChart,
  HeroKPIs,
  ScopeScrubber,
  ThemeToggle,
} from '@/components/design';
import { fmtCompact, fmtN, fmtDateLong } from '@/design/format';
import { PLATFORMS, getPlatform } from '@/design/platforms';
import { useDashboardModel, type ChannelRow } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { languageFullName } from '@/utils/formatters';
import { usePublicPollingData } from '@/hooks/usePublicPollingData';
import { usePollingApi } from '@/hooks/useApi';
import { useViewportBelow } from '@/hooks/useViewport';
import { PublicMobile } from './PublicMobile';
import { Spinner } from '@/components/common/Loader';
import * as api from '@/services/api';
import type { PublicSeriesInfo } from '@/services/api';
import type {
  SeriesWithStages,
  ViewGroup,
  MetricsResponse,
  LiveCCVResponse,
} from '@/types/api';

const REGION_LABELS: Record<string, { label: string; desc: string }> = {
  global: { label: 'Global', desc: 'Official multi-region feeds' },
  west: { label: 'West', desc: 'EN / DE / FR / ES / PT' },
  east: { label: 'East', desc: 'RU / TR / PL' },
  apac: { label: 'APAC', desc: 'KO / JA / ZH / TH / VI' },
  emea: { label: 'EMEA', desc: 'Europe, Middle East, Africa' },
  americas: { label: 'Americas', desc: 'NA / SA' },
};

export function PublicPage() {
  const { shortName } = useParams<{ shortName: string }>();
  const isMobile = useViewportBelow(900);

  const [seriesInfo, setSeriesInfo] = useState<PublicSeriesInfo | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useEffect(() => {
    if (!shortName) return;
    setSeriesLoading(true);
    setSeriesError(null);
    api
      .getPublicSeries(shortName)
      .then((info) => {
        setSeriesInfo(info);
        setSeriesLoading(false);
      })
      .catch((err) => {
        setSeriesError(err instanceof Error ? err.message : 'Failed to load series');
        setSeriesLoading(false);
      });
  }, [shortName]);

  useEffect(() => {
    if (seriesInfo && shortName) {
      window.umami?.track('public-dashboard-view', {
        series: seriesInfo.name,
        shortName,
      });
    }

  }, [seriesInfo?.id]);

  const seriesId = seriesInfo?.id;
  const pollingData = usePublicPollingData(shortName, seriesId);

  // Is any broadcast day live? → PublicLive. Otherwise if series completed → PublicRecap.
  const liveDay = useMemo(() => {
    if (!seriesInfo) return null;
    for (const s of seriesInfo.stages) {
      for (const d of s.broadcast_days) {
        if (d.status === 'live') return d;
      }
    }
    return null;
  }, [seriesInfo]);

  // Construct a SeriesWithStages-shaped object for useDashboardModel.
  // NOTE: must run BEFORE any early returns to obey React's rules-of-hooks.
  const seriesDetail: SeriesWithStages | null = useMemo(() => {
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
      discovery_interval_ms: null,
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

  // Early-return states — ALL hooks above this line must be called on every render.
  if (seriesLoading) {
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

  if (seriesError || !seriesInfo || !shortName || !seriesDetail) {
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
            {seriesError ?? 'This series does not exist or is not publicly available.'}
          </p>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <PublicMobile
        seriesInfo={seriesInfo}
        seriesDetail={seriesDetail}
        pollingData={pollingData}
        shortName={shortName}
        mode={liveDay ? 'live' : 'recap'}
      />
    );
  }

  if (liveDay) {
    return <PublicLive seriesInfo={seriesInfo} seriesDetail={seriesDetail} pollingData={pollingData} shortName={shortName} />;
  }

  return <PublicRecap seriesInfo={seriesInfo} seriesDetail={seriesDetail} pollingData={pollingData} shortName={shortName} />;
}

// ── PublicLive ────────────────────────────────────────────────────────────

function PublicLive({
  seriesInfo,
  seriesDetail,
  pollingData,
  shortName,
}: {
  seriesInfo: PublicSeriesInfo;
  seriesDetail: SeriesWithStages;
  pollingData: ReturnType<typeof usePublicPollingData>;
  shortName: string;
}) {
  // Baseline series-level model — used only to detect the initial live day
  // (which seeds the scrubber's default). The final scope-aware model is
  // built further down once scope is resolved.
  const baseModel = useDashboardModel({
    seriesDetail,
    metrics: pollingData.metrics,
    liveCCV: pollingData.liveCCV,
  });
  void baseModel;

  // Scope scrubber state (v6) — defaults to Day scope on the currently-live day.
  const liveDayInitial = useMemo(() => {
    for (const s of seriesInfo.stages) {
      for (const d of s.broadcast_days) {
        if (d.status === 'live') return { stageId: s.id, dayId: d.id };
      }
    }
    return null;
  }, [seriesInfo]);

  // Deep links — ?day=YYYY-MM-DD / ?stage=slug / ?scope=series / &group=Name
  // seed the scrubber, and the URL is kept in sync as the viewer clicks
  // around, so the address bar (and the Share button) is always a link to
  // exactly this view.
  const urlInit = useMemo(() => readScopeFromUrl(seriesInfo), [seriesInfo]);
  const [scopeLevel, setScopeLevel] = useState<'series' | 'stage' | 'day'>(
    urlInit.scopeLevel ?? (liveDayInitial ? 'day' : 'series'),
  );
  const [selectedStageId, setSelectedStageId] = useState<string | null>(
    urlInit.stageId ?? liveDayInitial?.stageId ?? null,
  );
  const [selectedDayId, setSelectedDayId] = useState<string | null>(
    urlInit.dayId ?? liveDayInitial?.dayId ?? null,
  );
  const [viewGroup, setViewGroup] = useState<string>(urlInit.viewGroup ?? 'all');
  useEffect(() => {
    writeScopeToUrl(
      seriesInfo,
      { scopeLevel, stageId: selectedStageId, dayId: selectedDayId, viewGroup },
      { defaultDayId: liveDayInitial?.dayId ?? null },
    );
  }, [seriesInfo, scopeLevel, selectedStageId, selectedDayId, viewGroup, liveDayInitial]);

  const activeStage = useMemo(() => {
    if (selectedStageId) return seriesInfo.stages.find((s) => s.id === selectedStageId) ?? null;
    return (
      seriesInfo.stages.find((s) => s.broadcast_days.some((d) => d.status === 'live')) ??
      seriesInfo.stages[seriesInfo.stages.length - 1] ??
      null
    );
  }, [seriesInfo, selectedStageId]);

  const allDaysFlat = useMemo(
    () => seriesInfo.stages.flatMap((s) => s.broadcast_days),
    [seriesInfo],
  );

  const activeDay = useMemo(() => {
    if (selectedDayId) return allDaysFlat.find((d) => d.id === selectedDayId) ?? null;
    // Preferred default: LIVE right now → most recent completed day →
    // next upcoming scheduled day → last item. The old fallback ("last in
    // array") landed multi-week events on a future day with no data.
    const live = allDaysFlat.find((d) => d.status === 'live');
    if (live) return live;
    const completed = allDaysFlat
      .filter((d) => d.status === 'completed')
      .sort((a, b) => b.date.localeCompare(a.date));
    if (completed[0]) return completed[0];
    const upcoming = allDaysFlat
      .filter((d) => d.status === 'scheduled')
      .sort((a, b) => a.date.localeCompare(b.date));
    if (upcoming[0]) return upcoming[0];
    return allDaysFlat[allDaysFlat.length - 1] ?? null;
  }, [selectedDayId, allDaysFlat]);

  const stageOptions = useMemo(
    () =>
      seriesInfo.stages.map((s) => {
        const dates = s.broadcast_days.map((d) => d.date).sort();
        const first = dates[0];
        const last = dates[dates.length - 1];
        const isLive = s.broadcast_days.some((d) => d.status === 'live');
        return {
          id: s.id,
          label: s.name,
          sub:
            first === last
              ? fmtDateLong(first)
              : first && last
                ? `${fmtDateLong(first)} – ${fmtDateLong(last)}`
                : undefined,
          live: isLive,
        };
      }),
    [seriesInfo],
  );

  const dayOptions = useMemo(() => {
    const days = scopeLevel === 'stage' && activeStage ? activeStage.broadcast_days : allDaysFlat;
    return [...days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        id: d.id,
        label: d.label,
        sub: fmtDateLong(d.date),
        live: d.status === 'live',
      }));
  }, [scopeLevel, activeStage, allDaysFlat]);

  const viewGroups = useMemo<ViewGroup[]>(
    () => ((seriesInfo.viewGroups ?? []) as ViewGroup[]),
    [seriesInfo],
  );

  // Resolve the active view group's filter (languages + platforms) into
  // arrays the API helpers accept. When viewGroup === 'all' (default) both
  // arrays are undefined and the API sees no filter (returns the full set).
  const viewFilter = useMemo<{ languages?: string[]; platforms?: string[] }>(() => {
    if (viewGroup === 'all') return {};
    const vg = viewGroups.find((g) => g.name === viewGroup);
    if (!vg) return {};
    return {
      ...(vg.languages?.length ? { languages: vg.languages } : {}),
      ...(vg.platforms?.length ? { platforms: vg.platforms } : {}),
    };
  }, [viewGroup, viewGroups]);

  // Stable cache key including the filter so polling-api refetches when
  // the user changes the dropdown.
  const filterKey = `${viewFilter.languages?.join(',') ?? ''}|${viewFilter.platforms?.join(',') ?? ''}`;

  const scope = useMemo(() => {
    if (scopeLevel === 'series') return { level: 'series' as const, id: seriesInfo.id };
    if (scopeLevel === 'stage' && activeStage) return { level: 'stage' as const, id: activeStage.id };
    if (scopeLevel === 'day' && activeDay) return { level: 'day' as const, id: activeDay.id };
    return { level: 'series' as const, id: seriesInfo.id };
  }, [scopeLevel, activeStage, activeDay, seriesInfo.id]);

  const timeline = useTimelineSeries({
    scope,
    interval: 60,
    publicShortName: shortName,
    languages: viewFilter.languages,
    platforms: viewFilter.platforms,
  });

  // ── Scope-aware metrics + liveCCV ─────────────────────────────────────
  // usePublicPollingData only fetches series-level (and is unfiltered).
  // We need a scoped fetch whenever:
  //   (a) scope is narrower than series (Day / Stage) — otherwise the KPIs
  //       print the whole-series numbers, OR
  //   (b) a view-group filter is active — pollingData has no filter wired in.
  const hasViewFilter = Boolean(
    (viewFilter.languages?.length ?? 0) > 0 || (viewFilter.platforms?.length ?? 0) > 0,
  );
  const needsScopedFetch = scope.level !== 'series' || hasViewFilter;
  const scopeCacheKey = `${scope.level}:${scope.id}`;

  const { data: scopedMetrics } = usePollingApi<MetricsResponse>(
    () =>
      needsScopedFetch && shortName
        ? api.getPublicMetrics(shortName, scope.level, scope.id, viewFilter.languages, viewFilter.platforms)
        : Promise.resolve(null as unknown as MetricsResponse),
    [shortName, scopeCacheKey, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!shortName },
  );

  const { data: scopedLiveCCV } = usePollingApi<LiveCCVResponse>(
    () =>
      needsScopedFetch && shortName
        ? api.getPublicLiveCCV(shortName, scope.level, scope.id, viewFilter.languages, viewFilter.platforms)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [shortName, scopeCacheKey, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!shortName },
  );

  // Final model — scoped when the scrubber has narrowed, series-level else.
  const model = useDashboardModel({
    seriesDetail,
    metrics: needsScopedFetch ? scopedMetrics : pollingData.metrics,
    liveCCV: needsScopedFetch ? scopedLiveCCV : pollingData.liveCCV,
  });

  // Raw live response for the theater — needs channelIdentifier/streamId,
  // which the dashboard model doesn't carry through.
  const liveResponse = needsScopedFetch ? scopedLiveCCV : pollingData.liveCCV;

  // Theater state lives here (not in the component) because its three
  // surfaces sit in different layout slots: the toggle chip in the scrubber
  // row, standard mode in the hero's chart column, theatre mode full-width.
  const [theaterOpen, setTheaterOpen] = useState<boolean>(
    () => localStorage.getItem(THEATER_STORAGE_KEY) === '1',
  );
  const [theaterMode, setTheaterMode] = useState<'standard' | 'theatre'>(() =>
    localStorage.getItem(THEATER_MODE_KEY) === 'theatre' ? 'theatre' : 'standard',
  );
  const [theaterPick, setTheaterPick] = useState<string>('');
  useEffect(() => {
    localStorage.setItem(THEATER_STORAGE_KEY, theaterOpen ? '1' : '0');
  }, [theaterOpen]);
  useEffect(() => {
    localStorage.setItem(THEATER_MODE_KEY, theaterMode);
  }, [theaterMode]);

  const theaterChannels = useMemo(() => {
    const chans = (liveResponse?.channels ?? []).filter(
      (c) => c.concurrentViewers > 0 && theaterEmbedSrc(c) !== null,
    );
    // Picker order: by viewers. (Officials-first ordering buried a 44K watch
    // party under twenty official entries.) The DEFAULT pick still prefers
    // the biggest official broadcast — see theaterSelected.
    return chans.sort((a, b) => b.concurrentViewers - a.concurrentViewers);
  }, [liveResponse]);
  const theaterSelected =
    theaterChannels.find((c) => c.channelId === theaterPick) ??
    theaterChannels.find((c) => c.tier === 'official') ??
    theaterChannels[0] ??
    null;
  const theaterShowing = theaterOpen && theaterSelected !== null && liveResponse != null;

  // Same bug-fix we applied to the report: per-tier peak in tierRows is
  // Math.max() of per-channel peaks, which under-counts whenever several
  // channels peak at the same minute. The timeline hook already has the
  // authoritative "highest simultaneous CCV" in its series.sum, so use
  // that to override tier peaks (falls back to the old heuristic if the
  // timeline hasn't loaded yet).
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

  const liveCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.filter((d) => d.status === 'live').length,
    0,
  );
  const totalDayCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.length,
    0,
  );
  const completedDayCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.filter((d) => d.status === 'completed').length,
    0,
  );
  const currentDayNumber = completedDayCount + (liveCount > 0 ? 1 : 0);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ width: '100%', maxWidth: PUBLIC_MAX_WIDTH, margin: '0 auto', display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Header */}
      <header
        style={{
          padding: '20px 32px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Row gap={18}>
          <ClutchWordmark size={18} />
          <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
          <Col gap={1}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{seriesInfo.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
              {seriesInfo.game ? `${seriesInfo.game} · ` : ''}Live viewership
            </div>
          </Col>
        </Row>
        <Row gap={10}>
          <Pill tone="live">
            ● Live
            {totalDayCount > 0 ? ` · Day ${currentDayNumber} of ${totalDayCount}` : ''}
          </Pill>
          <ThemeToggle />
        </Row>
      </header>

      {/* Scope scrubber — Series / Stage / Day + View Group (v6), with the
          theater toggle in the leftover room beside the View Group. */}
      <div
        style={{
          padding: '14px 32px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-raised)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <ScopeScrubber
            level={scopeLevel}
            onLevelChange={(l) => setScopeLevel(l as 'series' | 'stage' | 'day')}
            stages={stageOptions}
            stageId={activeStage?.id}
            onStageChange={(id) => {
              setSelectedStageId(id);
              setSelectedDayId(null);
            }}
            days={dayOptions}
            dayId={activeDay?.id}
            onDayChange={(id) => setSelectedDayId(id)}
            viewGroup={viewGroup}
            onViewGroupChange={setViewGroup}
            viewGroups={viewGroups}
          />
        </div>
        {theaterSelected && (
          <button
            type="button"
            className="btn"
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={() => setTheaterOpen((o) => !o)}
          >
            {theaterOpen ? (
              '✕ Close player'
            ) : (
              <>
                <span style={{ color: 'var(--live)', marginRight: 6 }}>●</span>
                {/* The scoped TOTAL — same number as the hero and the player
                    overlay. Showing the preselected channel's own CCV here
                    read as "the event has 2.7K viewers" from the outside. */}
                Watch live · {fmtCompact(liveResponse?.totalCCV ?? theaterSelected.concurrentViewers)}
              </>
            )}
          </button>
        )}
      </div>

      {/* Live theater, theatre mode — full-bleed row above the hero */}
      {theaterShowing && theaterMode === 'theatre' && (
        <div style={{ padding: '18px 32px 0' }}>
          <TheaterPlayer
            variant="theatre"
            live={liveResponse!}
            channels={theaterChannels}
            selected={theaterSelected!}
            onPick={setTheaterPick}
            onMode={() => setTheaterMode('standard')}
            onClose={() => setTheaterOpen(false)}
          />
        </div>
      )}

      {/* Hero row */}
      <div
        style={{
          padding: '40px 32px 24px',
          display: 'grid',
          gridTemplateColumns: '1.3fr 1fr',
          gap: 32,
          alignItems: 'end',
        }}
      >
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Right now · {model.liveChannelCount} channels across {model.platformRows.length} platforms
          </div>
          <div
            className="tabular"
            style={{
              fontSize: 'clamp(72px, 11vw, 150px)',
              lineHeight: 0.9,
              letterSpacing: '-0.05em',
              fontWeight: 600,
            }}
          >
            {fmtN(model.liveTotal)}
          </div>
          <Row gap={32} style={{ marginTop: 16, flexWrap: 'wrap' }}>
            <Col gap={2}>
              <div className="eyebrow">Peak today</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {fmtCompact(model.peakTotal)}
              </div>
            </Col>
            <Col gap={2}>
              <div className="eyebrow">Avg today</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {fmtCompact(model.avgTotal)}
              </div>
            </Col>
            <Col gap={2}>
              <div className="eyebrow">Viewed Hours</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {fmtCompact(model.viewedHours)}
              </div>
            </Col>
            <Col gap={2}>
              <div className="eyebrow">Languages</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {model.languageBreakdown.length}
              </div>
            </Col>
          </Row>
        </div>
        {theaterShowing && theaterMode === 'standard' ? (
          /* Standard mode: the player takes the timeline's slot beside the
             live number. Theatre mode gets its own full-width row above. */
          <TheaterPlayer
            variant="standard"
            live={liveResponse!}
            channels={theaterChannels}
            selected={theaterSelected!}
            onPick={setTheaterPick}
            onMode={() => setTheaterMode('theatre')}
            onClose={() => setTheaterOpen(false)}
          />
        ) : (
          <div style={{ height: 180 }}>
            {timeline.total.length > 0 ? (
              <>
                <AreaChart data={timeline.total} width={500} height={180} color="var(--red)" />
                <div className="eyebrow" style={{ textAlign: 'right', marginTop: 4 }}>
                  Series timeline
                </div>
              </>
            ) : (
              <div className="placeholder" style={{ height: 180 }}>
                Collecting data…
              </div>
            )}
          </div>
        )}
      </div>

      {/* By category (tier breakdown) — hide tiers with no live streams. */}
      {(() => {
        const visibleTiers = tierRowsCorrected.filter((t) => (t.ccv ?? 0) > 0);
        if (visibleTiers.length === 0) return null;
        return (
          <div style={{ padding: '0 32px 16px' }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              By category
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${visibleTiers.length}, 1fr)`,
                gap: 10,
              }}
            >
              {visibleTiers.map((t) => (
                <div
                  key={t.key}
                  className="card"
                  style={{
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <Row justify="space-between">
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{t.label}</span>
                    <span
                      className="tabular"
                      style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}
                    >
                      {(t.share * 100).toFixed(0)}%
                    </span>
                  </Row>
                  <div
                    className="tabular"
                    style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}
                  >
                    {fmtCompact(t.ccv)}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                    Live CCV
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
          </div>
        );
      })()}

      {/* Platform tiles */}
      <div style={{ padding: '8px 32px 0' }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          By platform
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(140px, 1fr))`,
            gap: 8,
          }}
        >
          {model.platformRows.map((p) => (
            <div
              key={p.id}
              className="card"
              style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <Row gap={6}>
                <PlatformPip id={p.id} size={12} />
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)' }}>
                  {p.name}
                </span>
              </Row>
              <div
                className="tabular"
                style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}
              >
                {fmtCompact(p.ccv)}
              </div>
              <Row style={{ alignItems: 'center' }}>
                <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                  {(p.share * 100).toFixed(1)}%
                </span>
                <div
                  style={{
                    flex: 1,
                    marginLeft: 8,
                    height: 3,
                    background: 'var(--bg-sunken)',
                    borderRadius: 2,
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
              </Row>
            </div>
          ))}
        </div>
      </div>

      {/* Main interactive chart */}
      <div style={{ padding: '28px 32px 24px' }}>
        <Section eyebrow="Viewership over time" title="Today · per minute">
          {timeline.total.length > 0 ? (
            <InteractiveMainChart
              height={260}
              width={1250}
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
            <div className="placeholder" style={{ height: 260 }}>
              {timeline.loading ? 'Loading time series…' : 'No time-series data yet'}
            </div>
          )}
        </Section>
      </div>

      {/* Sortable channel table */}
      <div style={{ padding: '0 32px 40px' }}>
        <Section eyebrow="Live now" title={`All ${model.leaderboard.length} tracked channels`}>
          <SortableChannelTable channels={model.leaderboard} live />
        </Section>
      </div>

      <footer
        style={{
          padding: '24px 32px',
          borderTop: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--fg-dim)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <ClutchWordmark size={14} muted />
        <span>tracker.clutch.game/public/{shortName} · Updated every 30s</span>
      </footer>
      </div>
    </div>
  );
}

// ── PublicRecap ────────────────────────────────────────────────────────────

function PublicRecap({
  seriesInfo,
  seriesDetail,
  pollingData,
  shortName,
}: {
  seriesInfo: PublicSeriesInfo;
  seriesDetail: SeriesWithStages;
  pollingData: ReturnType<typeof usePublicPollingData>;
  shortName: string;
}) {
  const hasMultipleStages = seriesInfo.stages.length > 1;

  const allDaysFlat = useMemo(
    () => seriesInfo.stages.flatMap((s) => s.broadcast_days),
    [seriesInfo],
  );

  // Deep links (see the live component) — recap has no live default.
  const urlInit = useMemo(() => readScopeFromUrl(seriesInfo), [seriesInfo]);
  const [scopeLevel, setScopeLevel] = useState<'series' | 'stage' | 'day'>(
    urlInit.scopeLevel ?? 'series',
  );
  const [selectedStageId, setSelectedStageId] = useState<string | null>(urlInit.stageId ?? null);
  const [selectedDayId, setSelectedDayId] = useState<string | null>(urlInit.dayId ?? null);
  const [viewGroup, setViewGroup] = useState<string>(urlInit.viewGroup ?? 'all');
  useEffect(() => {
    writeScopeToUrl(
      seriesInfo,
      { scopeLevel, stageId: selectedStageId, dayId: selectedDayId, viewGroup },
      { defaultDayId: null },
    );
  }, [seriesInfo, scopeLevel, selectedStageId, selectedDayId, viewGroup]);

  const viewGroups = useMemo<ViewGroup[]>(
    () => ((seriesInfo.viewGroups ?? []) as ViewGroup[]),
    [seriesInfo],
  );

  const activeStage = useMemo(() => {
    if (selectedStageId) return seriesInfo.stages.find((s) => s.id === selectedStageId) ?? null;
    return seriesInfo.stages[seriesInfo.stages.length - 1] ?? null;
  }, [seriesInfo, selectedStageId]);

  const activeDay = useMemo(() => {
    if (selectedDayId) return allDaysFlat.find((d) => d.id === selectedDayId) ?? null;
    const completed = allDaysFlat
      .filter((d) => d.status === 'completed')
      .sort((a, b) => b.date.localeCompare(a.date));
    return completed[0] ?? allDaysFlat[allDaysFlat.length - 1] ?? null;
  }, [selectedDayId, allDaysFlat]);

  const stageOptions = useMemo(
    () =>
      seriesInfo.stages.map((s) => {
        const dates = s.broadcast_days.map((d) => d.date).sort();
        const first = dates[0];
        const last = dates[dates.length - 1];
        return {
          id: s.id,
          label: s.name,
          sub:
            first === last
              ? fmtDateLong(first)
              : first && last
                ? `${fmtDateLong(first)} – ${fmtDateLong(last)}`
                : undefined,
        };
      }),
    [seriesInfo],
  );

  const dayOptions = useMemo(() => {
    const days = scopeLevel === 'stage' && activeStage ? activeStage.broadcast_days : allDaysFlat;
    return [...days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ id: d.id, label: d.label, sub: fmtDateLong(d.date) }));
  }, [scopeLevel, activeStage, allDaysFlat]);

  // Resolve the active view group's filter (languages + platforms)
  const viewFilter = useMemo<{ languages?: string[]; platforms?: string[] }>(() => {
    if (viewGroup === 'all') return {};
    const vg = viewGroups.find((g) => g.name === viewGroup);
    if (!vg) return {};
    return {
      ...(vg.languages?.length ? { languages: vg.languages } : {}),
      ...(vg.platforms?.length ? { platforms: vg.platforms } : {}),
    };
  }, [viewGroup, viewGroups]);
  const filterKey = `${viewFilter.languages?.join(',') ?? ''}|${viewFilter.platforms?.join(',') ?? ''}`;

  const scope = useMemo(() => {
    if (scopeLevel === 'series') return { level: 'series' as const, id: seriesInfo.id };
    if (scopeLevel === 'stage' && activeStage) return { level: 'stage' as const, id: activeStage.id };
    if (scopeLevel === 'day' && activeDay) return { level: 'day' as const, id: activeDay.id };
    return { level: 'series' as const, id: seriesInfo.id };
  }, [scopeLevel, activeStage, activeDay, seriesInfo.id]);

  // Scoped fetch when scope < series OR when a view-filter is active
  // (pollingData has no filter wired in).
  const hasViewFilter = Boolean(
    (viewFilter.languages?.length ?? 0) > 0 || (viewFilter.platforms?.length ?? 0) > 0,
  );
  const needsScopedFetch = scope.level !== 'series' || hasViewFilter;
  const scopeCacheKey = `${scope.level}:${scope.id}`;

  const { data: scopedMetrics } = usePollingApi<MetricsResponse>(
    () =>
      needsScopedFetch && shortName
        ? api.getPublicMetrics(shortName, scope.level, scope.id, viewFilter.languages, viewFilter.platforms)
        : Promise.resolve(null as unknown as MetricsResponse),
    [shortName, scopeCacheKey, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!shortName },
  );

  const { data: scopedLiveCCV } = usePollingApi<LiveCCVResponse>(
    () =>
      needsScopedFetch && shortName
        ? api.getPublicLiveCCV(shortName, scope.level, scope.id, viewFilter.languages, viewFilter.platforms)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [shortName, scopeCacheKey, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!shortName },
  );

  const model = useDashboardModel({
    seriesDetail,
    metrics: needsScopedFetch ? scopedMetrics : pollingData.metrics,
    liveCCV: needsScopedFetch ? scopedLiveCCV : pollingData.liveCCV,
  });

  const timeline = useTimelineSeries({
    scope,
    // Per-minute, matching PublicLive + the reports. (Was 300, but pre-rollup
    // bucketing always collapsed to 1-min so it never mattered; the rollup
    // fixed bucketing and surfaced the real 5-min interval. 60 restores the
    // expected per-minute resolution on the completed/recap view.)
    interval: 60,
    publicShortName: shortName,
    languages: viewFilter.languages,
    platforms: viewFilter.platforms,
  });

  const tierRowsVisible = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of timeline.region) {
      const id = (s.id ?? '').toLowerCase();
      if (!id) continue;
      m.set(id, s.sum ?? (s.data.length ? Math.max(...s.data) : 0));
    }
    return model.tierRows
      .map((t) => {
        const tp = m.get(t.key);
        return tp != null && tp > 0 ? { ...t, peak: tp } : t;
      })
      .filter((t) => (t.peak ?? 0) > 0 || (t.viewedHours ?? 0) > 0 || (t.ccv ?? 0) > 0);
  }, [model.tierRows, timeline.region]);

  const totalDayCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.length,
    0,
  );

  const scopeTitle =
    scope.level === 'series'
      ? seriesInfo.name
      : scope.level === 'stage' && activeStage
        ? `${seriesInfo.name} · ${activeStage.name}`
        : scope.level === 'day' && activeDay
          ? `${seriesInfo.name} · ${activeDay.label}`
          : seriesInfo.name;

  // ── Trend vs previous broadcast (day → previous day in stage; stage →
  // previous stage in series). Powers the +/-% chip on HeroKPIs.
  const previousScope = useMemo<
    { level: 'day' | 'stage'; id: string; label: string } | null
  >(() => {
    if (scope.level === 'day') {
      // Match the legacy report (computeDayTrend): only compare with the
      // previous broadcast day in the SAME stage. No cross-stage fallback.
      const allDaysWithStage = seriesInfo.stages.flatMap((s) =>
        s.broadcast_days.map((d) => ({ ...d, stage_id: s.id })),
      );
      const cur = allDaysWithStage.find((d) => d.id === scope.id);
      if (!cur) return null;
      const prev = allDaysWithStage
        .filter((d) =>
          d.stage_id === cur.stage_id && d.date < cur.date && (d.status === 'completed' || d.status === 'live'),
        )
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      return prev ? { level: 'day', id: prev.id, label: prev.label } : null;
    }
    if (scope.level === 'stage') {
      const cur = seriesInfo.stages.find((s) => s.id === scope.id);
      if (!cur) return null;
      const prev = [...seriesInfo.stages]
        .filter((s) => s.order < cur.order)
        .sort((a, b) => b.order - a.order)[0];
      return prev ? { level: 'stage', id: prev.id, label: prev.name } : null;
    }
    return null;
  }, [seriesInfo, scope.level, scope.id]);

  const { data: prevMetrics } = usePollingApi<MetricsResponse>(
    () =>
      previousScope && shortName
        ? api.getPublicMetrics(shortName, previousScope.level, previousScope.id)
        : Promise.resolve(null as unknown as MetricsResponse),
    [shortName, previousScope?.id ?? ''],
    { intervalMs: 60_000, enabled: !!previousScope && !!shortName },
  );

  // Match the legacy HTML report's TrendData rules — drop the whole trend
  // when the previous scope has no usable data (both peak and avg ≤ 0).
  const trend = useMemo(() => {
    if (!prevMetrics || !previousScope) return null;
    const prevPeak = Number(prevMetrics.peakCCV?.totalCCV ?? 0);
    const prevAvg = Number(prevMetrics.avgCCV ?? 0);
    const prevHours = Number(prevMetrics.totalViewedHours ?? 0);
    if (prevPeak <= 0 && prevAvg <= 0) return null;
    const delta = (cur: number | null | undefined, prev: number) => {
      if (prev <= 0) return null;
      return (Number(cur ?? 0) - prev) / prev;
    };
    return {
      label: previousScope.label,
      peak: delta(model.peakTotal, prevPeak),
      avg: delta(model.avgTotal, prevAvg),
      hours: delta(model.viewedHours, prevHours),
    };
  }, [prevMetrics, previousScope, model.peakTotal, model.avgTotal, model.viewedHours]);

  const palette = [
    'var(--red)', 'var(--info)', 'var(--warn)', 'var(--live)',
    'var(--twitch)', 'var(--tiktok)', 'var(--youtube)', 'var(--kick)',
  ];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: PUBLIC_MAX_WIDTH, margin: '0 auto', display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Header */}
      <header style={{ padding: '28px 40px 8px', borderBottom: '1px solid var(--border)' }}>
        <Row justify="space-between">
          <Row gap={18}>
            <ClutchWordmark size={18} />
            <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
            <Col gap={1}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{seriesInfo.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
                Final recap
                {seriesInfo.startDate && seriesInfo.endDate
                  ? ` · ${fmtDateLong(seriesInfo.startDate)} – ${fmtDateLong(seriesInfo.endDate)}`
                  : seriesInfo.startDate
                    ? ` · ${fmtDateLong(seriesInfo.startDate)}`
                    : ''}
              </div>
            </Col>
          </Row>
          <Row gap={8}>
            <Pill>Completed</Pill>
            <ThemeToggle />
          </Row>
        </Row>
      </header>

      {/* Scope scrubber — Series / Stage / Day */}
      <div
        style={{
          padding: '14px 40px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-raised)',
        }}
      >
        <ScopeScrubber
          level={scopeLevel}
          onLevelChange={(l) => setScopeLevel(l as 'series' | 'stage' | 'day')}
          stages={hasMultipleStages ? stageOptions : undefined}
          stageId={activeStage?.id}
          onStageChange={(id) => {
            setSelectedStageId(id);
            setSelectedDayId(null);
          }}
          days={dayOptions}
          dayId={activeDay?.id}
          onDayChange={(id) => setSelectedDayId(id)}
          viewGroup={viewGroup}
          onViewGroupChange={setViewGroup}
          viewGroups={viewGroups}
        />
      </div>

      {/* Headline */}
      <section style={{ padding: '40px 40px 24px' }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          Event recap
        </div>
        <h1
          style={{
            fontSize: 'clamp(36px, 5vw, 56px)',
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
            fontWeight: 600,
            margin: 0,
            maxWidth: 1000,
          }}
        >
          {scopeTitle}
        </h1>
        <div style={{ fontSize: 15, color: 'var(--fg-muted)', marginTop: 8 }}>
          {totalDayCount} broadcast day{totalDayCount === 1 ? '' : 's'} ·{' '}
          {model.trackedChannelCount} tracked channels · {model.platformRows.length} platforms ·{' '}
          {model.languageBreakdown.length} languages
        </div>
      </section>

      {/* HeroKPIs — 3-cell strip with micro visualizations (v6) */}
      <section style={{ padding: '0 40px 32px' }}>
        <HeroKPIs
          variant="xl"
          peak={model.peakTotal}
          avg={model.avgTotal}
          hours={model.viewedHours}
          days={totalDayCount}
          timeSeries={timeline.total}
          showBroadcastTime
          yoyPeak={trend?.peak ?? null}
          yoyAvg={trend?.avg ?? null}
          yoyHours={trend?.hours ?? null}
          yoyLabel={trend?.label}
        />
      </section>

      {/* By category (tier breakdown) — hide tiers with no activity in scope. */}
      {tierRowsVisible.length > 0 && (
      <section style={{ padding: '0 40px 32px' }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          By category
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${tierRowsVisible.length}, 1fr)`,
            gap: 10,
          }}
        >
          {tierRowsVisible.map((t) => (
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
                  letterSpacing: '-0.02em',
                  marginTop: 6,
                }}
              >
                {fmtCompact(t.peak || t.ccv)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Peak concurrent</div>
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
      </section>
      )}

      {/* Timeline */}
      <section style={{ padding: '0 40px 32px' }}>
        <Section eyebrow="Viewership over time" title="How audience shifted across the event">
          {timeline.total.length > 0 ? (
            <InteractiveMainChart
              height={280}
              width={1160}
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
              {timeline.loading ? 'Loading time series…' : 'No time-series data'}
            </div>
          )}
        </Section>
      </section>

      {/* Languages bar chart */}
      {model.languageBreakdown.length > 0 && (
        <section style={{ padding: '0 40px 32px' }}>
          <Section
            eyebrow="Languages"
            title={`Peak CCV by language · ${model.languageBreakdown.length} tracked`}
          >
            <div style={{ height: 240 }}>
              <VBarChart
                width={1160}
                height={240}
                items={model.languageBreakdown.slice(0, 8).map((l, i) => ({
                  label: languageFullName(l.language ?? l.key),
                  value: l.peakCCV ?? Number(l.peak_ccv ?? 0) ?? l.totalCCV ?? 0,
                  sub: '',
                  color: palette[i % palette.length]!,
                }))}
              />
            </div>
          </Section>
        </section>
      )}

      {/* All channels */}
      <section style={{ padding: '0 40px 48px' }}>
        <Section
          eyebrow="Channel breakdown"
          title={`All ${model.leaderboard.length} tracked channels`}
        >
          <SortableChannelTable channels={model.leaderboard} live={false} />
        </Section>
      </section>

      <footer
        style={{
          padding: '24px 40px',
          borderTop: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--fg-dim)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <ClutchWordmark size={14} muted />
        <span>
          Generated {new Date().toLocaleDateString()} · tracker.clutch.game/public/{shortName}
        </span>
      </footer>
      </div>
    </div>
  );
}

// ── Sortable channel table (shared between Live + Recap) ─────────────────

function SortableChannelTable({
  channels,
  live,
}: {
  channels: ChannelRow[];
  live: boolean;
}) {
  const [sort, setSort] = useState<keyof ChannelRow>(live ? 'live' : 'peak');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [platform, setPlatform] = useState<string>('all');
  // Titles are all-or-none: only some platforms carry one (TikTok mostly),
  // so per-row rendering made the table look broken. Default off.
  const [showTitles, setShowTitles] = useState(false);

  const filtered = channels.filter((c) =>
    platform === 'all' ? true : c.platform === platform,
  );

  const sorted = [...filtered].sort((a, b) => {
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

  // Column order per design v6: tier gets fixed 110px so the badge doesn't wrap.
  const cols = live
    ? '28px 1.4fr 100px 110px 60px 90px 90px 90px 100px'
    : '28px 1.4fr 100px 110px 60px 90px 90px 100px';
  return (
    <div>
      {(
        <Row gap={8} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 4,
            }}
          >
            <option value="all">All platforms</option>
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--fg-muted)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '5px 10px',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showTitles}
              onChange={(e) => setShowTitles(e.target.checked)}
              style={{ accentColor: 'var(--red)', margin: 0 }}
            />
            Show titles
          </label>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {sorted.length} channels · sort any column
          </div>
        </Row>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          gap: 0,
          padding: '0 6px 8px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div />
        <H k="name">Channel</H>
        <H k="platform">Platform</H>
        <H k="tier">Category</H>
        <H k="language">Language</H>
        {live && <H k="live" align="right">Live</H>}
        <H k="peak" align="right">Peak</H>
        <H k="avg" align="right">Avg</H>
        <H k="hours" align="right">Viewed Hours</H>
      </div>
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        {sorted.map((c, i) => (
          <div
            key={c.id}
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              padding: '9px 6px',
              borderBottom: '1px solid var(--border-faint)',
              fontSize: 13,
              alignItems: 'center',
            }}
          >
            <div className="tabular" style={{ color: 'var(--fg-dim)', fontSize: 11 }}>
              {i + 1}
            </div>
            <Row gap={8} style={{ minWidth: 0 }}>
              <PlatformPip id={c.platform} />
              <div style={{ minWidth: 0 }}>
                <ChannelNameWithLink
                  name={c.name}
                  platform={c.platform}
                  channelIdentifier={c.channelIdentifier}
                />
                {/* YouTube excluded: the /live-page scrape's title extraction
                    is unreliable (variant pages bleed one foreign video's
                    title across many channels) — hidden until root-caused.
                    CCV extraction is separate and unaffected. */}
                {showTitles && c.title && c.platform !== 'youtube' && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.title}
                  </div>
                )}
              </div>
            </Row>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              {PLATFORMS.find((p) => p.id === c.platform)?.name ?? c.platform}
            </div>
            <div>
              <TierBadge tier={c.tier} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {languageFullName(c.language)}
            </div>
            {live && (
              <div
                className="tabular"
                style={{
                  textAlign: 'right',
                  color: c.live ? 'var(--fg)' : 'var(--fg-dim)',
                  fontWeight: c.live ? 500 : 400,
                }}
              >
                {c.live ? fmtN(c.live) : <span style={{ fontSize: 11 }}>offline</span>}
              </div>
            )}
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtN(c.peak)}
            </div>
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtN(c.avg)}
            </div>
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtN(c.hours)}
            </div>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="placeholder" style={{ margin: 12, height: 80 }}>
            No channels match the filters
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live theater ──────────────────────────────────────────────────────────
// Embedded stream player with the live total overlaid. Toggled from the
// scrubber-row chip; open state and mode persist per browser. Standard mode
// sits in the hero beside the live number, theatre mode runs full-width.
// Only platforms with an official embed player are offered (Twitch, Kick,
// YouTube — YouTube via the exact live video id we track per snapshot).

type LiveTheaterChannel = NonNullable<LiveCCVResponse['channels']>[number];

/** Cap the public canvas — full-bleed on 4K turned the hero into a billboard. */
const PUBLIC_MAX_WIDTH = 1600;

const THEATER_STORAGE_KEY = 'clutch_public_theater';
const THEATER_MODE_KEY = 'clutch_public_theater_mode';

function theaterEmbedSrc(c: LiveTheaterChannel): string | null {
  const host = window.location.hostname;
  if (c.platform === 'twitch') {
    return `https://player.twitch.tv/?channel=${encodeURIComponent(c.channelIdentifier)}&parent=${encodeURIComponent(host)}&muted=true&autoplay=true`;
  }
  if (c.platform === 'kick') {
    return `https://player.kick.com/${encodeURIComponent(c.channelIdentifier)}?muted=true&autoplay=true`;
  }
  if (c.platform === 'youtube') {
    // Embed by our stored stream_id ONLY when the backend marks it
    // ownership-verified (ytApiStream: the API multi-stream path checks
    // every video against snippet.channelId). That covers channels running
    // several simultaneous lives — the by-channel live_stream embed shows
    // "video unavailable" for those — including their :stream-N children.
    // enablejsapi + origin let the page post player commands into the
    // iframe — needed for the visible Unmute chip (YouTube's own volume
    // control hides in the auto-hiding hover bar, so a muted autoplay
    // embed offers no obvious way to get sound).
    const ytParams = `autoplay=1&mute=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;
    if (c.channelIdentifier.startsWith('yt-video:')) {
      // Manually pinned video — the identifier IS the video id.
      return `https://www.youtube.com/embed/${encodeURIComponent(c.channelIdentifier.slice('yt-video:'.length))}?${ytParams}`;
    }
    if (c.ytApiStream && c.streamId) {
      return `https://www.youtube.com/embed/${encodeURIComponent(c.streamId)}?${ytParams}`;
    }
    // Everyone else: never trust scrape-sourced stream_ids (they can carry
    // redirect-roulette garbage — foreign streams — even when the CCV is
    // fine). YouTube's live_stream embed resolves the channel's current
    // live by UC id at embed time; ownership guaranteed by YouTube.
    if (/^UC[A-Za-z0-9_-]{22}$/.test(c.channelIdentifier)) {
      return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(c.channelIdentifier)}&${ytParams}`;
    }
    // Unverified child rows and non-UC identifiers have no trustworthy
    // embed target — leave them out of the picker.
    return null;
  }
  return null;
}

function TheaterPlayer({
  variant,
  live,
  channels,
  selected,
  onPick,
  onMode,
  onClose,
}: {
  variant: 'standard' | 'theatre';
  live: LiveCCVResponse;
  channels: LiveTheaterChannel[];
  selected: LiveTheaterChannel;
  onPick: (channelId: string) => void;
  onMode: () => void;
  onClose: () => void;
}) {
  const theatre = variant === 'theatre';
  const src = theaterEmbedSrc(selected)!;

  // YouTube sound — embeds must start muted (autoplay policy), and
  // YouTube's own volume button hides in the auto-hiding hover bar. This
  // chip posts the official IFrame-API commands into the embed instead.
  // Twitch/Kick players have workable native mute controls — no chip.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ytMuted, setYtMuted] = useState(true);
  useEffect(() => {
    setYtMuted(true); // every src change remounts the iframe muted
  }, [src]);
  const ytCommand = (func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      'https://www.youtube.com',
    );
  };
  const toggleYtMute = () => {
    if (ytMuted) {
      ytCommand('unMute');
      ytCommand('setVolume', [100]);
      setYtMuted(false);
    } else {
      ytCommand('mute');
      setYtMuted(true);
    }
  };

  // Fullscreen — on OUR container (video + overlay together), not the
  // iframe: the player's own fullscreen button fullscreens only the iframe,
  // which is why the counter used to disappear. This way it stays on top.
  //
  // Two layers: native element-fullscreen where the environment completes
  // it, and a fixed full-viewport fallback where it doesn't (iOS Safari has
  // no element-fullscreen; some embedded webviews accept the call but never
  // finish the transition). The overlay behaves identically in both.
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const [nativeFs, setNativeFs] = useState(false);
  const [fallbackFs, setFallbackFs] = useState(false);
  const isFullscreen = nativeFs || fallbackFs;
  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const sync = () => {
      const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setNativeFs(fsEl === videoBoxRef.current && fsEl !== null);
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);
  // Esc exits the fallback layer (native fullscreen handles Esc itself).
  useEffect(() => {
    if (!fallbackFs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFallbackFs(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fallbackFs]);
  const enterFullscreen = () => {
    const el = videoBoxRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null;
    if (!el) return;
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fsEngaged = () =>
      (document.fullscreenElement ?? doc.webkitFullscreenElement ?? null) === el;
    const engageFallback = () => {
      if (!fsEngaged()) setFallbackFs(true);
    };
    try {
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(engageFallback);
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else {
        engageFallback();
        return;
      }
      // Some environments neither resolve nor reject — check shortly after.
      window.setTimeout(engageFallback, 700);
    } catch {
      engageFallback();
    }
  };
  const exitFullscreen = () => {
    setFallbackFs(false);
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header row: picker + mode + close. Kept outside the video so the
          overlay never has to fight the player's own controls. */}
      <Row
        gap={8}
        style={{
          padding: theatre ? '10px 14px' : '7px 10px',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: 'var(--live)', fontSize: 10 }}>●</span>
        {theatre && <span style={{ fontSize: 13, fontWeight: 600 }}>Live theater</span>}
        <select
          value={selected.channelId}
          onChange={(e) => onPick(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontSize: theatre ? 12 : 11,
            padding: theatre ? '5px 10px' : '4px 8px',
            borderRadius: 4,
            maxWidth: theatre ? 340 : 230,
            minWidth: 0,
          }}
        >
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.displayName} · {PLATFORMS.find((p) => p.id === c.platform)?.name ?? c.platform} · {fmtN(c.concurrentViewers)}
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        {theatre && (
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            Starts muted · numbers refresh with the tracker
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onMode}
          title={theatre ? 'Shrink next to the live number' : 'Expand to full width'}
        >
          {theatre ? '❐ Standard' : '▭ Theatre'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={enterFullscreen}
          title="Fullscreen with the live counter on top"
        >
          ⛶ Fullscreen
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} title="Close player">
          ✕
        </button>
      </Row>

      <div
        ref={videoBoxRef}
        style={{
          position: fallbackFs ? 'fixed' : 'relative',
          background: '#000',
          ...(fallbackFs ? { inset: 0, zIndex: 9999 } : {}),
          ...(isFullscreen
            ? { width: '100vw', height: '100vh' }
            : theatre
              ? { height: 'min(56vh, 560px)' }
              : { aspectRatio: '16 / 9' }),
        }}
      >
        <iframe
          key={src}
          ref={iframeRef}
          src={src}
          title={`Live: ${selected.displayName}`}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block', position: 'absolute', inset: 0 }}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
        />
        {/* Unmute chip — YouTube only; sits above the player's bottom
            control bar so it never covers YouTube's own controls. */}
        {selected.platform === 'youtube' && (
          <button
            type="button"
            onClick={toggleYtMute}
            style={{
              position: 'absolute',
              left: 12,
              bottom: 56,
              zIndex: 2,
              background: 'rgba(8, 10, 16, 0.68)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              borderRadius: 999,
              padding: ytMuted ? '8px 16px' : '8px 12px',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {ytMuted ? '🔇 Tap for sound' : '🔊'}
          </button>
        )}
        {/* Fullscreen controls — the header row with the regular controls is
            outside the fullscreened element, so exit + channel picker get
            their own top-left cluster here. Esc works too, natively. */}
        {isFullscreen && (
          <div
            style={{
              position: 'absolute',
              top: 16,
              left: 16,
              zIndex: 2,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              maxWidth: '52%',
            }}
          >
            <button
              type="button"
              onClick={exitFullscreen}
              style={{
                background: 'rgba(8, 10, 16, 0.68)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#fff',
                borderRadius: 6,
                padding: '7px 14px',
                fontSize: 12.5,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              ✕ Exit fullscreen
            </button>
            <select
              value={selected.channelId}
              onChange={(e) => onPick(e.target.value)}
              style={{
                background: 'rgba(8, 10, 16, 0.68)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#fff',
                borderRadius: 6,
                padding: '7px 10px',
                fontSize: 12.5,
                maxWidth: 300,
                cursor: 'pointer',
              }}
            >
              {channels.map((c) => (
                <option key={c.channelId} value={c.channelId} style={{ color: '#000' }}>
                  {c.displayName} · {PLATFORMS.find((p) => p.id === c.platform)?.name ?? c.platform} · {fmtN(c.concurrentViewers)}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* The live-count overlay. pointer-events: none — clicks fall
            through to the player, so controls under it keep working. In
            standard mode the giant hero number sits right beside the video,
            so the overlay slims down to a corner chip; in fullscreen it
            scales up to broadcast size. */}
        <div
          style={{
            position: 'absolute',
            top: isFullscreen ? 20 : theatre ? 12 : 8,
            right: isFullscreen ? 24 : theatre ? 12 : 8,
            pointerEvents: 'none',
            background: 'rgba(8, 10, 16, 0.68)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.14)',
            color: '#fff',
            borderRadius: isFullscreen ? 12 : 8,
            padding: isFullscreen ? '18px 28px' : theatre ? '10px 16px' : '6px 10px',
            textAlign: 'right',
            maxWidth: '46%',
          }}
        >
          <div
            className="tabular"
            style={{
              fontSize: isFullscreen ? 64 : theatre ? 26 : 17,
              fontWeight: 650,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
            }}
          >
            {fmtN(live.totalCCV)}
          </div>
          <div
            style={{
              fontSize: isFullscreen ? 14 : theatre ? 9.5 : 8.5,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              opacity: 0.82,
              marginTop: isFullscreen ? 8 : theatre ? 3 : 2,
            }}
          >
            <span style={{ color: 'var(--live)' }}>●</span> watching now · {live.liveChannels} channels
          </div>
        </div>
      </div>
    </div>
  );
}
