/**
 * Editor Desktop — primary operator view during a live broadcast.
 * Ported from design_handoff_clutch_tracker/reference/src/editor-desktop.jsx
 * and wired to the real Clutch Tracker API via usePollingData + useDashboardModel.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Row,
  Col,
  LogoMark,
  ClutchWordmark,
  Pill,
  PlatformPip,
  TierBadge,
  Donut,
  HBar,
  AreaChart,
  CollapsibleSection,
  RailCollapse,
  useSortable,
  SortHeader,
  ThemeToggle,
  ScopeScrubber,
  InteractiveMainChart,
  IconChev,
  IconChevDown,
  IconSearch,
  IconShare,
  IconDownload,
  IconPlus,
  IconBolt,
  IconPause,
  IconEdit,
} from '@/components/design';
import { PLATFORMS, getPlatform } from '@/design/platforms';
import {
  fmtCompact,
  fmtN,
  fmtDuration,
  fmtRelative,
  fmtPct,
  fmtDateMD,
  fmtDateLong,
} from '@/design/format';
import { useDashboardModel, type ChannelRow } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { useApi, usePollingApi } from '@/hooks/useApi';
import { useNow } from '@/hooks/useNow';
import * as api from '@/services/api';
import { ChannelsSection } from '@/components/editor/ChannelsSection';
import { DiscoveryFeedSection } from '@/components/editor/DiscoveryFeedSection';
import { ExportDialog } from '@/components/editor/ExportDialog';
import type {
  TournamentSeries,
  SeriesWithStages,
  OrchestratorStatus,
  DiscoveryStatus,
  Channel,
  BroadcastStatus,
  ViewGroup,
  MetricsResponse,
  LiveCCVResponse,
} from '@/types/api';
import type { PollingDataState } from '@/hooks/usePollingData';

export interface EditorDesktopProps {
  seriesId: string;
  seriesList: TournamentSeries[];
  seriesDetail: SeriesWithStages | null;
  pollingData: PollingDataState;
  pollingStatus: OrchestratorStatus | null;
  discoveryStatus: DiscoveryStatus | null;
  onSeriesChange: (id: string) => void;
  onExtendBroadcast: (dayId: string, minutes: number) => void;
  onBroadcastDayStatusChange: (dayId: string, status: BroadcastStatus) => void;
  onTriggerPoll: () => void;
  onStartPolling: () => void;
  onStopPolling: () => void;
  pollLoading?: boolean;
  onChannelAdded?: () => void;
}

export function EditorDesktop({
  seriesId,
  seriesList,
  seriesDetail,
  pollingData,
  pollingStatus,
  discoveryStatus,
  onSeriesChange,
  onExtendBroadcast,
  onBroadcastDayStatusChange,
  onTriggerPoll,
  onStartPolling,
  onStopPolling,
  pollLoading,
}: EditorDesktopProps) {
  const navigate = useNavigate();

  // Baseline series-level model — used only to detect liveDay (which
  // seeds the scope scrubber's default). The final scope-aware model is
  // built further down once we know what the user has picked.
  const baseModel = useDashboardModel({
    seriesDetail,
    metrics: pollingData.metrics,
    liveCCV: pollingData.liveCCV,
  });
  const { liveDay } = baseModel;

  // ── Scope state — single day (the one with status='live' by default) ────

  const allDays = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.flatMap((s) => s.broadcast_days);
  }, [seriesDetail]);

  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const activeDay = useMemo(() => {
    if (selectedDayId) return allDays.find((d) => d.id === selectedDayId) ?? null;
    // Preferred default: whatever's LIVE right now, else the most recent
    // day that was broadcast (status === 'completed' with the latest date),
    // else the next upcoming scheduled day, else fall back to the last
    // item in the array. Previously this just picked the last item, which
    // for multi-week events landed the user on a future day with no data.
    if (liveDay) return liveDay;
    const completed = allDays
      .filter((d) => d.status === 'completed')
      .sort((a, b) => b.date.localeCompare(a.date));
    if (completed[0]) return completed[0];
    const upcoming = allDays
      .filter((d) => d.status === 'scheduled')
      .sort((a, b) => a.date.localeCompare(b.date));
    if (upcoming[0]) return upcoming[0];
    return allDays[allDays.length - 1] ?? null;
  }, [selectedDayId, liveDay, allDays]);

  // ── ScopeScrubber state (series / stage / day + view group) ─────────

  const [scopeLevel, setScopeLevel] = useState<'series' | 'stage' | 'day'>(() =>
    liveDay ? 'day' : 'series',
  );
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [viewGroup, setViewGroup] = useState<string>('all');
  const [exportOpen, setExportOpen] = useState(false);

  const stageOptions = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.map((s) => {
      const isLive = s.broadcast_days.some((d) => d.status === 'live');
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
        live: isLive,
      };
    });
  }, [seriesDetail]);

  const activeStage = useMemo(() => {
    if (!seriesDetail) return null;
    if (selectedStageId) return seriesDetail.stages.find((s) => s.id === selectedStageId) ?? null;
    // If a specific day is active (via the sidebar or scrubber), the
    // semantically "current stage" is that day's parent stage — not the
    // last stage on the series. This keeps the Export dialog and any
    // stage-scoped UI coherent with what the user actually has selected.
    if (activeDay) {
      const parent = seriesDetail.stages.find((s) =>
        s.broadcast_days.some((d) => d.id === activeDay.id),
      );
      if (parent) return parent;
    }
    // Default: stage containing the live day, or the last stage.
    return (
      seriesDetail.stages.find((s) => s.broadcast_days.some((d) => d.status === 'live')) ??
      seriesDetail.stages[seriesDetail.stages.length - 1] ??
      null
    );
  }, [seriesDetail, selectedStageId, activeDay]);

  const dayOptions = useMemo(() => {
    const days = scopeLevel === 'stage' && activeStage ? activeStage.broadcast_days : allDays;
    return [...days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        id: d.id,
        label: d.label,
        sub: fmtDateMD(d.date),
        live: d.status === 'live',
      }));
  }, [scopeLevel, activeStage, allDays]);

  const viewGroups = useMemo(() => {
    const raw = (seriesDetail?.metadata as { viewGroups?: Array<{ name: string }> } | undefined)
      ?.viewGroups;
    return raw ?? [];
  }, [seriesDetail]);

  const scope = useMemo(() => {
    if (scopeLevel === 'series' && seriesId) {
      return { level: 'series' as const, id: seriesId, label: 'Full Series' };
    }
    if (scopeLevel === 'stage' && activeStage) {
      return { level: 'stage' as const, id: activeStage.id, label: activeStage.name };
    }
    if (scopeLevel === 'day' && activeDay) {
      return { level: 'day' as const, id: activeDay.id, label: activeDay.label };
    }
    // Fallbacks
    if (activeDay) return { level: 'day' as const, id: activeDay.id, label: activeDay.label };
    if (seriesId) return { level: 'series' as const, id: seriesId, label: 'Full Series' };
    return null;
  }, [scopeLevel, activeStage, activeDay, seriesId]);

  const timeline = useTimelineSeries({ scope, interval: 60 });

  // ── Scope-aware metrics + liveCCV ─────────────────────────────────────
  // usePollingData only fetches series-level. When the operator picks a
  // Day or Stage on the scrubber, the KPIs should narrow to that window —
  // otherwise "Peak today" prints the whole-series peak and "Hours
  // watched this scope" prints the whole-series hours. Fetch scoped
  // metrics on demand and union them into the dashboard model.
  const needsScopedFetch = !!scope && scope.level !== 'series';
  const scopeCacheKey = scope ? `${scope.level}:${scope.id}` : '';

  const { data: scopedMetrics } = usePollingApi<MetricsResponse>(
    () =>
      needsScopedFetch && scope
        ? api.getMetrics(scope.level, scope.id)
        : Promise.resolve(null as unknown as MetricsResponse),
    [seriesId, scopeCacheKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!seriesId },
  );

  const { data: scopedLiveCCV } = usePollingApi<LiveCCVResponse>(
    () =>
      needsScopedFetch && scope && seriesId
        ? api.getLiveCCV(seriesId, scope.level, scope.id)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [seriesId, scopeCacheKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!seriesId },
  );

  // Final model — scoped when the user has drilled in, series-level otherwise.
  const model = useDashboardModel({
    seriesDetail,
    metrics: needsScopedFetch ? scopedMetrics : pollingData.metrics,
    liveCCV: needsScopedFetch ? scopedLiveCCV : pollingData.liveCCV,
  });

  // Recent 48-minute slice for the hero mini chart
  const heroAreaData = useMemo(() => timeline.total.slice(-48), [timeline.total]);
  const heroAreaTimestamps = useMemo(
    () => timeline.timestamps.slice(-48),
    [timeline.timestamps],
  );

  // ── Rail collapse state (persisted) ───────────────────────────────────

  const [leftCollapsed, setLeftCollapsed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('ct-rail-left') === 'closed',
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('ct-rail-right') === 'closed',
  );

  const toggleLeft = () => {
    const n = !leftCollapsed;
    setLeftCollapsed(n);
    try {
      window.localStorage.setItem('ct-rail-left', n ? 'closed' : 'open');
    } catch {
      /* ignore */
    }
  };
  const toggleRight = () => {
    const n = !rightCollapsed;
    setRightCollapsed(n);
    try {
      window.localStorage.setItem('ct-rail-right', n ? 'closed' : 'open');
    } catch {
      /* ignore */
    }
  };

  // ── All channels (feeds both Channels section + Discovery feed) ──────

  const { data: allChannels, refetch: refetchChannels } = usePollingApi<Channel[]>(
    () => api.listChannels(seriesId),
    [seriesId, pollingData.lastDiscoveryResult?.timestamp],
    { intervalMs: 30_000 },
  );

  // ── Leaderboard: enrich with current channel tier + language ─────────
  // metrics.channelLeaderboard carries the tier that was in effect when
  // the aggregation ran — so a channel that's been re-promoted from
  // community to watch_party still reads "community" until the next
  // aggregation pass. allChannels is a live read of the channels table;
  // overlay its tier/language onto each leaderboard row so the Channels
  // section and the Leaderboard agree on what the channel is.
  const leaderboardEnriched = useMemo(() => {
    if (!allChannels || allChannels.length === 0) return model.leaderboard;
    const byId = new Map<string, Channel>();
    for (const c of allChannels) byId.set(c.id, c);
    return model.leaderboard.map((row) => {
      const fresh = byId.get(row.id);
      if (!fresh) return row;
      return {
        ...row,
        tier: fresh.tier ?? row.tier,
        language: fresh.language ?? row.language,
      };
    });
  }, [model.leaderboard, allChannels]);

  // ── Leaderboard sort state ────────────────────────────────────────────

  const lb = useSortable(leaderboardEnriched, 'live', 'desc');

  // ── YouTube quota (for adapter-health warnings) ───────────────────────

  const { data: ytQuota } = useApi(() => api.getYouTubeQuota(), []);

  // ── Series name fallback ──────────────────────────────────────────────

  const series = seriesList.find((s) => s.id === seriesId);
  const seriesName = series?.short_name ?? series?.name ?? 'Series';

  // ── Derived hero stats ────────────────────────────────────────────────

  const peakSub = useMemo(() => {
    if (!model.peakTotalAt) return undefined;
    const d = new Date(model.peakTotalAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }, [model.peakTotalAt]);

  // Tick every 30s so the LIVE · HH:MM pill advances without needing the
  // user to hard-refresh the page.
  const nowTick = useNow(30_000);
  const broadcastDuration = useMemo(() => {
    if (!activeDay?.broadcast_start) return null;
    return nowTick - new Date(activeDay.broadcast_start).getTime();
  }, [activeDay, nowTick]);

  const pollInterval = 30; // seconds, display only

  // Top platform by CCV
  const topPlatform = model.platformRows[0];

  // ── Schedule list grouping ────────────────────────────────────────────

  const scheduleItems = useMemo(() => {
    if (!seriesDetail) return [];
    const items: Array<{
      id: string;
      label: string;
      date: string;
      status: BroadcastStatus;
      broadcastStart: string | null;
    }> = [];
    for (const stage of seriesDetail.stages) {
      for (const d of stage.broadcast_days) {
        items.push({
          id: d.id,
          label: d.label,
          date: d.date,
          status: d.status,
          broadcastStart: d.broadcast_start,
        });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    return items;
  }, [seriesDetail]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${leftCollapsed ? '44px' : '240px'} 1fr ${rightCollapsed ? '44px' : '320px'}`,
        minHeight: '100vh',
        background: 'var(--bg)',
        transition: 'grid-template-columns 200ms ease',
      }}
    >
      {/* ── Left rail ─────────────────────────────────────────────────── */}
      <aside
        style={{
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-raised)',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          overflow: leftCollapsed ? 'visible' : 'hidden',
        }}
      >
        <button
          type="button"
          onClick={toggleLeft}
          title={leftCollapsed ? 'Expand' : 'Collapse'}
          style={{
            position: 'absolute',
            top: 14,
            right: -12,
            zIndex: 3,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: 'var(--fg-muted)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              transform: leftCollapsed ? 'rotate(0deg)' : 'rotate(180deg)',
              transition: 'transform 200ms',
            }}
          >
            <IconChev size={12} />
          </span>
        </button>

        {leftCollapsed ? (
          <Col gap={14} style={{ padding: '16px 0', alignItems: 'center' }}>
            <LogoMark size={22} />
            <div style={{ width: 28, height: 1, background: 'var(--border)' }} />
            {scheduleItems.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setSelectedDayId(d.id)}
                title={`${d.label} · ${fmtDateLong(d.date)}`}
                style={{
                  position: 'relative',
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  display: 'grid',
                  placeItems: 'center',
                  background: activeDay?.id === d.id ? 'var(--bg-hover)' : 'transparent',
                  border:
                    activeDay?.id === d.id
                      ? '1px solid var(--border)'
                      : '1px solid transparent',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                }}
              >
                {d.status === 'live' && (
                  <span
                    className="dot dot-red"
                    style={{ position: 'absolute', transform: 'translate(10px,-10px)' }}
                  />
                )}
                {shortenLabel(d.label)}
              </button>
            ))}
          </Col>
        ) : (
          <div
            style={{
              padding: '16px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              flex: 1,
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: '0 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <LogoMark size={18} withWordmark />
              {pollingStatus?.state === 'running' && <Pill tone="live">● Live</Pill>}
            </div>

            <div style={{ padding: '0 12px' }}>
              <SeriesSelect
                value={seriesId}
                options={seriesList}
                onChange={onSeriesChange}
                onEdit={() => navigate(`/${seriesId}/edit`)}
                onNew={() => navigate('/new')}
              />
            </div>

            <div>
              <div className="eyebrow" style={{ padding: '0 16px 6px' }}>
                Schedule
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {scheduleItems.map((d) => {
                  const active = activeDay?.id === d.id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setSelectedDayId(d.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '7px 16px 7px 18px',
                        fontSize: 12.5,
                        textAlign: 'left',
                        background: active ? 'var(--bg-hover)' : 'transparent',
                        borderLeft: `2px solid ${active ? 'var(--red)' : 'transparent'}`,
                        cursor: 'pointer',
                      }}
                    >
                      <span className={d.status === 'live' ? 'dot dot-red' : 'dot'} />
                      <span
                        style={{
                          flex: 1,
                          color: active ? 'var(--fg)' : 'var(--fg-muted)',
                        }}
                      >
                        {d.label}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 10, color: 'var(--fg-dim)' }}
                      >
                        {fmtDateMD(d.date)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => navigate(`/${seriesId}/edit`)}
                style={{
                  width: 'calc(100% - 24px)',
                  margin: '10px 12px 0',
                  padding: '6px',
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  border: '1px dashed var(--border)',
                  borderRadius: 6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                <IconPlus size={12} /> Broadcast Day
              </button>
            </div>

            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              <Row justify="space-between" style={{ padding: '0 16px 6px' }}>
                <div className="eyebrow">
                  Channels · {model.trackedChannelCount}
                </div>
              </Row>
              <div
                style={{
                  padding: '0 12px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                }}
              >
                {model.topChannels.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '14px 1fr auto',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                    }}
                  >
                    <PlatformPip id={c.platform} size={8} />
                    <span
                      style={{
                        fontSize: 11.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.name}
                    </span>
                    <span
                      className="tabular"
                      style={{
                        fontSize: 10,
                        color: c.live ? 'var(--live)' : 'var(--fg-dim)',
                      }}
                    >
                      {c.live ? fmtCompact(c.live) : '·'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <main
        style={{
          padding: '16px 24px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflow: 'auto',
        }}
      >
        <Row justify="space-between" align="center">
          <Row gap={10}>
            <ClutchWordmark size={16} />
            <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
            <Row gap={6}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                {seriesName}
              </span>
              {activeDay && (
                <>
                  <IconChev size={12} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {activeDay.label}
                  </span>
                  {activeDay.status === 'live' && <Pill tone="live">● Live</Pill>}
                </>
              )}
            </Row>
          </Row>
          <Row gap={8}>
            <button
              type="button"
              className="btn"
              style={{
                minWidth: 220,
                justifyContent: 'space-between',
                background: 'var(--bg-card)',
              }}
              disabled
              title="Command palette — coming soon"
            >
              <Row gap={8}>
                <IconSearch size={13} />
                <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
                  Search, commands…
                </span>
              </Row>
              <span className="kbd">⌘K</span>
            </button>
            <ThemeToggle />
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (navigator.share) {
                  navigator
                    .share({
                      title: seriesName,
                      url: `${window.location.origin}/public/${series?.short_name ?? seriesId}`,
                    })
                    .catch(() => {
                      /* ignore */
                    });
                } else {
                  const url = `${window.location.origin}/public/${series?.short_name ?? seriesId}`;
                  navigator.clipboard.writeText(url).catch(() => {
                    /* ignore */
                  });
                }
              }}
            >
              <IconShare size={13} /> Share
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setExportOpen(true)}
            >
              <IconDownload size={13} /> Export
            </button>
          </Row>
        </Row>

        {/* ── Scope scrubber — Series / Stage / Day + View Group (v6) ──── */}
        <div className="card" style={{ padding: '10px 14px' }}>
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

        {/* ── Hero — live CCV with inline KPI strip ───────────────────── */}
        <div
          className="card"
          style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}
        >
          <Row justify="space-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="eyebrow">Concurrent viewers — live</div>
            <Row gap={6}>
              <Pill tone="live">● {model.liveChannelCount} channels live</Pill>
              <Pill>⟳ {pollInterval}s poll</Pill>
              {activeDay && activeDay.status === 'live' && broadcastDuration != null && (
                <Pill tone="info">
                  {activeDay.label} · {fmtDuration(broadcastDuration)}
                </Pill>
              )}
            </Row>
          </Row>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(260px, 1.2fr) minmax(200px, 1fr)',
              gap: 28,
              alignItems: 'stretch',
            }}
          >
            <div
              style={{
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div
                className="tabular"
                style={{
                  fontSize: 'clamp(56px, 7.5vw, 92px)',
                  lineHeight: 0.95,
                  letterSpacing: '-0.04em',
                  fontWeight: 600,
                }}
              >
                {fmtN(model.liveTotal)}
              </div>
              <div style={{ flex: 1, minHeight: 80 }}>
                {heroAreaData.length > 0 ? (
                  <AreaChart
                    data={heroAreaData}
                    width={360}
                    height={90}
                    timestamps={heroAreaTimestamps}
                    timezone={seriesDetail?.timezone}
                    label="Total CCV"
                  />
                ) : (
                  <div
                    className="placeholder"
                    style={{ height: 90, fontSize: 11 }}
                  >
                    Collecting data…
                  </div>
                )}
              </div>
              <Row
                gap={8}
                style={{
                  fontSize: 11,
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}
              >
                <span>last {heroAreaData.length}m</span>
                <span style={{ flex: 1 }} />
                <span>now</span>
              </Row>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 1,
                background: 'var(--border)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              {(
                [
                  {
                    label: 'Peak today',
                    value: fmtCompact(model.peakTotal),
                    sub: peakSub ? `${peakSub} local` : '—',
                    tone: 'fg',
                  },
                  {
                    label: 'Avg live',
                    value: fmtCompact(model.avgTotal),
                    sub: 'scope avg',
                    tone: 'fg',
                  },
                  {
                    label: 'Viewed Hours',
                    value: fmtCompact(model.viewedHours),
                    sub: 'this scope',
                    tone: 'fg',
                  },
                  {
                    label: 'Top platform',
                    value: topPlatform?.name ?? '—',
                    sub: topPlatform ? `${fmtCompact(topPlatform.ccv)} · ${fmtPct(topPlatform.share)}` : '—',
                    tone: topPlatform?.id ? platformToneVar(topPlatform.id as string) : 'fg',
                  },
                  {
                    label: 'Live channels',
                    value: String(model.liveChannelCount),
                    sub: `${model.trackedChannelCount} tracked`,
                    tone: 'fg',
                  },
                  {
                    label: 'WS status',
                    value: pollingData.wsStatus,
                    sub: pollingStatus?.lastPollTime
                      ? `poll ${fmtRelative(pollingStatus.lastPollTime)}`
                      : 'no polls yet',
                    tone: pollingData.wsStatus === 'connected' ? 'live' : 'fg',
                  },
                ] as Array<{ label: string; value: string; sub: string; tone: string }>
              ).map((k) => (
                <div
                  key={k.label}
                  style={{
                    background: 'var(--bg-card)',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    minWidth: 0,
                  }}
                >
                  <div className="eyebrow" style={{ fontSize: 9 }}>
                    {k.label}
                  </div>
                  <div
                    className="tabular"
                    style={{
                      fontSize: 22,
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      color: k.tone.startsWith('var(') ? k.tone : k.tone === 'live' ? 'var(--live)' : 'var(--fg)',
                    }}
                  >
                    {k.value}
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: 'var(--fg-dim)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {k.sub}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Distribution row — 3 auto-fit cards ─────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {/* Platform split */}
          <div
            className="card"
            style={{
              minWidth: 0,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <Row justify="space-between">
              <div className="eyebrow">Platform split</div>
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                {model.platformRows.length} sources
              </span>
            </Row>
            {model.platformRows.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto minmax(0, 1fr)',
                  gap: 16,
                  alignItems: 'center',
                }}
              >
                <Donut
                  size={110}
                  stroke={16}
                  centerLabel={fmtCompact(model.liveTotal)}
                  centerSub="Live"
                  segments={model.platformRows.map((p) => ({ color: p.color, value: p.ccv }))}
                />
                <Col gap={5} style={{ minWidth: 0 }}>
                  {model.platformRows.slice(0, 6).map((p) => (
                    <Row
                      key={p.id}
                      justify="space-between"
                      style={{ fontSize: 11.5, gap: 8, minWidth: 0 }}
                    >
                      <Row gap={6} style={{ minWidth: 0 }}>
                        <PlatformPip id={p.id} />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {p.name}
                        </span>
                      </Row>
                      <Row gap={8} style={{ flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            color: 'var(--fg-dim)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {(p.share * 100).toFixed(0)}%
                        </span>
                        <span
                          className="tabular"
                          style={{
                            color: 'var(--fg-muted)',
                            minWidth: 36,
                            textAlign: 'right',
                          }}
                        >
                          {fmtCompact(p.ccv)}
                        </span>
                      </Row>
                    </Row>
                  ))}
                </Col>
              </div>
            ) : (
              <div className="placeholder" style={{ height: 120 }}>
                No active platforms
              </div>
            )}
          </div>

          {/* Language mix — CURRENT live CCV per language bucket from the channel
              leaderboard. The breakdown API returns summed totalCCV across all
              minutes, which swamped the "now" label with bucket sizes bigger than
              the whole event's live CCV at any moment. */}
          <div
            className="card"
            style={{
              minWidth: 0,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {(() => {
              const langBuckets = new Map<string, number>();
              for (const c of model.leaderboard) {
                if ((c.live ?? 0) > 0) {
                  const l = (c.language ?? '').trim().toLowerCase();
                  if (l) langBuckets.set(l, (langBuckets.get(l) ?? 0) + c.live);
                }
              }
              const buckets = Array.from(langBuckets)
                .map(([key, value]) => ({ key, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 6);
              const max = Math.max(...buckets.map((b) => b.value), 1);
              const colors = [
                'var(--red)',
                'var(--info)',
                'var(--warn)',
                'var(--live)',
                'var(--twitch)',
                'var(--youtube)',
              ];
              return (
                <>
                  <Row justify="space-between">
                    <div className="eyebrow">Language mix</div>
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: 'var(--fg-dim)' }}
                    >
                      CCV · now
                    </span>
                  </Row>
                  {buckets.length === 0 ? (
                    <div
                      className="placeholder"
                      style={{ height: 60, fontSize: 11 }}
                    >
                      Nothing live right now
                    </div>
                  ) : (
                    <Col gap={8}>
                      {buckets.map((b, i) => (
                        <HBar
                          key={b.key}
                          label={b.key.toUpperCase().slice(0, 7)}
                          value={b.value}
                          max={max}
                          color={colors[i % colors.length]!}
                        />
                      ))}
                    </Col>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* ── Viewership over time ────────────────────────────────────── */}
        <CollapsibleSection
          storageKey="ct-timeline"
          eyebrow="Viewership over time"
          title={`${scope?.label ?? 'Series'} · 1m interval`}
        >
          {timeline.total.length > 0 ? (
            <InteractiveMainChart
              height={280}
              width={960}
              series={{
                platform: timeline.platform,
                region: timeline.region,
                language: timeline.language,
                total: timeline.total,
              }}
              totalData={timeline.total}
              timestamps={timeline.timestamps}
              timezone={seriesDetail?.timezone}
            />
          ) : (
            <div className="placeholder" style={{ height: 280 }}>
              {timeline.loading ? 'Loading time series…' : 'No time-series data yet'}
            </div>
          )}
        </CollapsibleSection>

        {/* ── Leaderboard ─────────────────────────────────────────────── */}
        <CollapsibleSection
          storageKey="ct-leaderboard"
          eyebrow="Leaderboard"
          title={`${model.leaderboard.length} tracked channels — click any column to sort`}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '28px 1fr 100px 110px 90px 100px 110px 60px',
              gap: 0,
              padding: '0 4px 6px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div />
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="name">
              Channel
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="platform">
              Platform
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="tier">
              Tier
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="live" align="right">
              Live
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="peak" align="right">
              Peak
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="hours" align="right">
              Hours
            </SortHeader>
            <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="language" align="right">
              Lang
            </SortHeader>
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {lb.sorted.map((c: ChannelRow, i: number) => (
              <div
                key={c.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px 1fr 100px 110px 90px 100px 110px 60px',
                  padding: '7px 4px',
                  borderBottom: '1px solid var(--border-faint)',
                  fontSize: 12.5,
                  alignItems: 'center',
                }}
              >
                <div
                  className="tabular"
                  style={{ color: 'var(--fg-dim)', fontSize: 11 }}
                >
                  {i + 1}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <PlatformPip id={c.platform} />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--fg-dim)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.title || '—'}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {getPlatform(c.platform)?.name ?? c.platform ?? '—'}
                </div>
                <div>
                  <TierBadge tier={c.tier} />
                </div>
                <div
                  className="tabular"
                  style={{
                    textAlign: 'right',
                    color: c.live ? 'var(--fg)' : 'var(--fg-dim)',
                  }}
                >
                  {c.live ? fmtN(c.live) : '—'}
                </div>
                <div
                  className="tabular"
                  style={{ textAlign: 'right', color: 'var(--fg-muted)' }}
                >
                  {fmtN(c.peak)}
                </div>
                <div
                  className="tabular"
                  style={{ textAlign: 'right', color: 'var(--fg-muted)' }}
                >
                  {fmtN(c.hours)}
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--fg-muted)' }}>
                  {(c.language ?? '').toUpperCase() || '—'}
                </div>
              </div>
            ))}
            {lb.sorted.length === 0 && (
              <div
                className="placeholder"
                style={{ margin: 12, height: 80 }}
              >
                No channels tracked yet
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* ── Channels (curated) ──────────────────────────────────────── */}
        <ChannelsSection
          seriesId={seriesId}
          seriesDetail={seriesDetail}
          channels={allChannels ?? []}
          onMutate={refetchChannels}
        />

        {/* ── Discovery feed (auto-paused candidates) ─────────────────── */}
        <DiscoveryFeedSection
          seriesId={seriesId}
          channels={allChannels ?? []}
          defaultTier={seriesDetail?.discovery_default_tier ?? 'community'}
          blocklist={
            (seriesDetail?.metadata?.blocklist as string[] | undefined) ?? []
          }
          onMutate={refetchChannels}
        />
      </main>

      {/* ── Right rail ───────────────────────────────────────────────── */}
      <aside
        style={{
          borderLeft: '1px solid var(--border)',
          padding: rightCollapsed ? '16px 0' : 16,
          display: 'flex',
          flexDirection: 'column',
          gap: rightCollapsed ? 10 : 16,
          background: 'var(--bg-raised)',
          overflow: rightCollapsed ? 'visible' : 'auto',
          position: 'relative',
          alignItems: rightCollapsed ? 'center' : 'stretch',
        }}
      >
        <button
          type="button"
          onClick={toggleRight}
          title={rightCollapsed ? 'Expand' : 'Collapse'}
          style={{
            position: 'absolute',
            top: 14,
            left: -12,
            zIndex: 3,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: 'var(--fg-muted)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              transform: rightCollapsed ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 200ms',
            }}
          >
            <IconChev size={12} />
          </span>
        </button>

        {rightCollapsed ? (
          <Col gap={14} style={{ alignItems: 'center', paddingTop: 40 }}>
            <div
              title="Broadcast day"
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <span className="dot dot-live" />
            </div>
            <div
              title="Polling"
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <IconBolt size={12} />
            </div>
          </Col>
        ) : (
          <>
            {/* Broadcast day */}
            <RailCollapse eyebrow="Broadcast day" storageKey="ct-rail-bday">
              {activeDay ? (
                <div
                  className="card"
                  style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <Row justify="space-between">
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {activeDay.label} · {fmtDateMD(activeDay.date)}
                    </div>
                    {activeDay.status === 'live' && (
                      <Pill tone="live">Live · {fmtDuration(broadcastDuration)}</Pill>
                    )}
                    {activeDay.status === 'scheduled' && <Pill>Scheduled</Pill>}
                    {activeDay.status === 'completed' && <Pill>Completed</Pill>}
                  </Row>
                  {activeDay.broadcast_start && activeDay.broadcast_end && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                      {new Date(activeDay.broadcast_start).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      →{' '}
                      {new Date(activeDay.broadcast_end).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  )}
                  <Row gap={6}>
                    {activeDay.status === 'scheduled' && (
                      <button
                        className="btn btn-xs"
                        style={{ flex: 1 }}
                        type="button"
                        onClick={() => onBroadcastDayStatusChange(activeDay.id, 'live')}
                      >
                        Start
                      </button>
                    )}
                    {activeDay.status === 'live' && (
                      <>
                        <button
                          className="btn btn-xs"
                          style={{ flex: 1 }}
                          type="button"
                          onClick={() => onExtendBroadcast(activeDay.id, 30)}
                        >
                          Extend +30m
                        </button>
                        <button
                          className="btn btn-xs"
                          style={{ flex: 1, color: 'var(--danger)' }}
                          type="button"
                          onClick={() => onBroadcastDayStatusChange(activeDay.id, 'completed')}
                        >
                          End now
                        </button>
                      </>
                    )}
                  </Row>
                </div>
              ) : (
                <div className="placeholder" style={{ padding: 16, textAlign: 'center' }}>
                  No broadcast day
                </div>
              )}
            </RailCollapse>

            {/* Polling */}
            <RailCollapse eyebrow="Polling" storageKey="ct-rail-poll">
              <div className="card" style={{ padding: 12 }}>
                <Row justify="space-between" style={{ marginBottom: 10 }}>
                  <Row gap={6}>
                    <span
                      className={pollingStatus?.state === 'running' ? 'dot dot-live' : 'dot'}
                    />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>
                      {pollingStatus?.state === 'running' ? 'Running' : 'Stopped'}
                    </span>
                  </Row>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                    {pollingStatus?.lastPollTime
                      ? fmtRelative(pollingStatus.lastPollTime)
                      : 'never'}
                  </span>
                </Row>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 4,
                    marginBottom: 10,
                  }}
                >
                  {PLATFORMS.slice(0, 8).map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        padding: '6px 2px',
                        background: 'var(--bg-sunken)',
                        borderRadius: 4,
                      }}
                    >
                      <PlatformPip id={p.id} size={8} />
                      <span
                        style={{
                          fontSize: 9,
                          color: 'var(--fg-dim)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        OK
                      </span>
                    </div>
                  ))}
                </div>
                <Row gap={6}>
                  <button
                    className="btn btn-xs"
                    style={{ flex: 1 }}
                    type="button"
                    onClick={onTriggerPoll}
                    disabled={pollLoading}
                  >
                    <IconBolt size={11} /> {pollLoading ? 'Polling…' : 'Poll now'}
                  </button>
                  {pollingStatus?.state === 'running' ? (
                    <button
                      className="btn btn-xs"
                      style={{ flex: 1 }}
                      type="button"
                      onClick={onStopPolling}
                    >
                      <IconPause size={11} /> Pause
                    </button>
                  ) : (
                    <button
                      className="btn btn-xs"
                      style={{ flex: 1 }}
                      type="button"
                      onClick={onStartPolling}
                    >
                      Start
                    </button>
                  )}
                </Row>
              </div>
            </RailCollapse>

            {/* Adapter health */}
            <RailCollapse eyebrow="Adapter health" storageKey="ct-rail-adapter">
              <Col gap={4}>
                {[
                  { name: 'Twitch', status: 'ok', lat: '—' },
                  { name: 'Twitch browser', status: 'ok', lat: '60s' },
                  {
                    name: 'YouTube',
                    status: ytQuota && ytQuota.percentage > 75 ? 'warn' : 'ok',
                    lat: ytQuota ? `quota ${ytQuota.percentage.toFixed(0)}%` : '—',
                  },
                  { name: 'Kick', status: 'ok', lat: '—' },
                  { name: 'TikTok relay', status: 'ok', lat: '60s' },
                  { name: 'Steam', status: 'ok', lat: '—' },
                  { name: 'Chzzk', status: 'ok', lat: '—' },
                  { name: 'Soop', status: 'ok', lat: '—' },
                ].map((a) => (
                  <Row
                    key={a.name}
                    justify="space-between"
                    style={{
                      padding: '5px 8px',
                      background: 'var(--bg-sunken)',
                      borderRadius: 4,
                      fontSize: 11.5,
                    }}
                  >
                    <Row gap={6}>
                      <span
                        className="dot"
                        style={{
                          background:
                            a.status === 'ok' ? 'var(--live)' : 'var(--warn)',
                        }}
                      />
                      <span>{a.name}</span>
                    </Row>
                    <span
                      className="mono"
                      style={{ color: 'var(--fg-dim)', fontSize: 10 }}
                    >
                      {a.lat}
                    </span>
                  </Row>
                ))}
              </Col>
            </RailCollapse>

            {/* Discovery control (v6) */}
            <RailCollapse eyebrow="Discovery" storageKey="ct-rail-discovery">
              <div
                className="card"
                style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <Row justify="space-between">
                  <Row gap={6}>
                    <span
                      className={
                        discoveryStatus?.activeDiscoveries?.includes(seriesId)
                          ? 'dot dot-live'
                          : 'dot'
                      }
                    />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>
                      {discoveryStatus?.activeDiscoveries?.includes(seriesId)
                        ? 'Running'
                        : 'Stopped'}
                    </span>
                  </Row>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                    Last{' '}
                    {discoveryStatus?.lastResults?.[seriesId]
                      ? fmtRelative(discoveryStatus.lastResults[seriesId]!.timestamp)
                      : 'never'}
                  </span>
                </Row>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                  Auto-searches live streams matching this series' keywords. New channels
                  appear in the Discovery Feed.
                </div>
                {discoveryStatus?.lastResults?.[seriesId] && (
                  <Col gap={4} style={{ fontSize: 12 }}>
                    <Row justify="space-between">
                      <span style={{ color: 'var(--fg-dim)' }}>Discovered</span>
                      <span className="tabular" style={{ fontWeight: 500 }}>
                        {fmtN(discoveryStatus.lastResults[seriesId]!.discovered)}
                      </span>
                    </Row>
                    <Row justify="space-between">
                      <span style={{ color: 'var(--fg-dim)' }}>Added</span>
                      <span
                        className="tabular"
                        style={{
                          fontWeight: 500,
                          color:
                            discoveryStatus.lastResults[seriesId]!.added > 0
                              ? 'var(--live)'
                              : 'var(--fg)',
                        }}
                      >
                        {fmtN(discoveryStatus.lastResults[seriesId]!.added)}
                      </span>
                    </Row>
                  </Col>
                )}
                {ytQuota && (
                  <Col gap={4} style={{ fontSize: 11 }}>
                    <Row justify="space-between">
                      <span style={{ color: 'var(--fg-dim)' }}>YouTube quota</span>
                      <span
                        className="mono tabular"
                        style={{
                          color: ytQuota.percentage > 75 ? 'var(--warn)' : 'var(--fg-muted)',
                        }}
                      >
                        {fmtCompact(ytQuota.used)} / {fmtCompact(ytQuota.limit)} ·{' '}
                        {ytQuota.percentage.toFixed(0)}%
                      </span>
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
                          width: Math.min(100, ytQuota.percentage) + '%',
                          height: '100%',
                          background:
                            ytQuota.percentage > 75 ? 'var(--warn)' : 'var(--live)',
                        }}
                      />
                    </div>
                  </Col>
                )}
                <Row gap={6}>
                  <button
                    type="button"
                    className="btn btn-xs"
                    style={{ flex: 1 }}
                    onClick={() => api.triggerDiscovery(seriesId).catch(() => {})}
                  >
                    <IconBolt size={11} /> Trigger now
                  </button>
                  {discoveryStatus?.activeDiscoveries?.includes(seriesId) ? (
                    <button
                      type="button"
                      className="btn btn-xs"
                      style={{ flex: 1 }}
                      onClick={() => api.stopDiscovery(seriesId).catch(() => {})}
                    >
                      <IconPause size={11} /> Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-xs"
                      style={{ flex: 1 }}
                      onClick={() => api.startDiscovery(seriesId).catch(() => {})}
                    >
                      Start
                    </button>
                  )}
                </Row>
              </div>
            </RailCollapse>
          </>
        )}
      </aside>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        seriesId={seriesId}
        seriesDetail={seriesDetail}
        activeScope={{
          level: scopeLevel,
          stageId: activeStage?.id ?? null,
          dayId: activeDay?.id ?? null,
        }}
        activeViewGroupName={viewGroup === 'all' ? null : viewGroup}
        viewGroups={viewGroups as ViewGroup[]}
      />
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function shortenLabel(label: string): string {
  // "Day 3" → "D3", "Grand Finals" → "GF"
  return label
    .split(' ')
    .map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase()))
    .join('');
}

function platformToneVar(id: string): string {
  switch (id) {
    case 'twitch':
      return 'var(--twitch)';
    case 'youtube':
      return 'var(--youtube)';
    case 'kick':
      return 'var(--kick)';
    case 'tiktok':
      return 'var(--tiktok)';
    case 'steam':
      return 'var(--steam)';
    case 'soop':
      return 'var(--soop)';
    case 'chzzk':
      return 'var(--chzzk)';
    case 'trovo':
      return 'var(--trovo)';
    default:
      return 'var(--fg)';
  }
}

// ── Series selector ─────────────────────────────────────────────────────

function SeriesSelect({
  value,
  options,
  onChange,
  onEdit,
  onNew,
}: {
  value: string;
  options: TournamentSeries[];
  onChange: (id: string) => void;
  onEdit?: () => void;
  onNew?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((s) => s.id === value);
  const hasShort =
    !!current?.short_name && current.short_name !== current.name;
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg-card)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          textAlign: 'left',
          cursor: 'pointer',
          color: 'var(--fg)',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="eyebrow" style={{ fontSize: 9 }}>
            Series
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={current?.name}
          >
            {current?.name ?? 'Select series'}
          </div>
          {hasShort && (
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                marginTop: 2,
                letterSpacing: 0.2,
              }}
            >
              {current!.short_name}
            </div>
          )}
        </div>
        <IconChevDown size={14} />
      </button>
      {open && (
        <>
          {/* click-away backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: 4,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: 'var(--shadow-lg)',
              zIndex: 10,
              maxHeight: 360,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '4px 0',
              }}
            >
              {options.map((s) => {
                const itemHasShort = !!s.short_name && s.short_name !== s.name;
                const active = s.id === value;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      onChange(s.id);
                      setOpen(false);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '8px 12px',
                      textAlign: 'left',
                      background: active ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--fg)',
                      cursor: 'pointer',
                      borderLeft: `2px solid ${active ? 'var(--red)' : 'transparent'}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: active ? 500 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={s.name}
                    >
                      {s.name}
                    </div>
                    {itemHasShort && (
                      <div
                        className="mono"
                        style={{
                          fontSize: 10,
                          color: 'var(--fg-dim)',
                          marginTop: 1,
                          letterSpacing: 0.2,
                        }}
                      >
                        {s.short_name}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {(onEdit || onNew) && (
              <div
                style={{
                  display: 'flex',
                  gap: 4,
                  padding: 4,
                  borderTop: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                }}
              >
                {onEdit && current && (
                  <button
                    type="button"
                    onClick={() => {
                      onEdit();
                      setOpen(false);
                    }}
                    className="btn"
                    style={{
                      flex: 1,
                      fontSize: 11,
                      padding: '6px 8px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 5,
                    }}
                    title={`Edit ${current.short_name ?? current.name}`}
                  >
                    <IconEdit size={12} /> Edit series
                  </button>
                )}
                {onNew && (
                  <button
                    type="button"
                    onClick={() => {
                      onNew();
                      setOpen(false);
                    }}
                    className="btn"
                    style={{
                      flex: 1,
                      fontSize: 11,
                      padding: '6px 8px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 5,
                    }}
                  >
                    <IconPlus size={12} /> New series
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
