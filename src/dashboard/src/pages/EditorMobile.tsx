/**
 * Editor Mobile — bottom-nav, single-column ops companion.
 * Ported from design_handoff_clutch_tracker/reference/src/editor-mobile.jsx
 * and wired to real data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Row,
  Col,
  LogoMark,
  Pill,
  PlatformPip,
  AreaChart,
  Section,
  ChannelNameWithLink,
  IconBolt,
  IconCheck,
  IconDot,
  IconExternal,
  IconList,
  IconMenu,
  IconMore,
  IconPause,
  IconPlus,
  IconSettings,
  IconSparkle,
  IconUsers,
  IconX,
} from '@/components/design';
import { fmtRelative } from '@/design/format';
import { useAuth } from '@/hooks/useAuth';
import { PLATFORMS } from '@/design/platforms';
import { fmtCompact, fmtN, fmtDuration, fmtDateMD } from '@/design/format';
import { useDashboardModel } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { usePollingApi } from '@/hooks/useApi';
import { useNow } from '@/hooks/useNow';
import * as api from '@/services/api';
import type {
  TournamentSeries,
  SeriesWithStages,
  OrchestratorStatus,
  DiscoveryStatus,
  Channel,
  BroadcastStatus,
  BroadcastDay,
  MetricsResponse,
  LiveCCVResponse,
  ViewGroup,
} from '@/types/api';
import type { PollingDataState } from '@/hooks/usePollingData';
import { AddChannelDialog } from '@/components/editor/AddChannelDialog';

type MobileTab = 'live' | 'channels' | 'discovery' | 'ops';

export interface EditorMobileProps {
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
  onTriggerDiscovery?: () => void;
  onStartDiscovery?: () => void;
  onStopDiscovery?: () => void;
  pollLoading?: boolean;
  discoveryLoading?: boolean;
}

export function EditorMobile({
  seriesId,
  seriesDetail,
  pollingData,
  pollingStatus,
  discoveryStatus,
  onExtendBroadcast,
  onBroadcastDayStatusChange,
  onTriggerPoll,
  onStartPolling,
  onStopPolling,
  onTriggerDiscovery,
  onStartDiscovery,
  onStopDiscovery,
  pollLoading,
  discoveryLoading,
}: EditorMobileProps) {
  const navigate = useNavigate();
  const { isAdmin, logout } = useAuth();
  const [tab, setTab] = useState<MobileTab>('live');
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewGroup, setViewGroup] = useState<string>('all');
  const [addChannelOpen, setAddChannelOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on outside click / Esc
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Live day — derive directly from seriesDetail so we can compute
  // scope (and trigger scoped metric fetches) BEFORE constructing the
  // dashboard model. If we read liveDay off the model first, the model
  // would always be built from series-level pollingData and the
  // peak/avg/leaderboard would never narrow to the selected day.
  const liveDay = useMemo(() => {
    if (!seriesDetail) return null;
    for (const s of seriesDetail.stages) {
      for (const d of s.broadcast_days) {
        if (d.status === 'live') return d;
      }
    }
    return null;
  }, [seriesDetail]);

  // Active day — user's tap in the Schedule wins, else the live day, else
  // the most recently completed day, else the latest in the list.
  const activeDay = useMemo(() => {
    if (!seriesDetail) return liveDay;
    const all = seriesDetail.stages.flatMap((s) => s.broadcast_days);
    if (selectedDayId) return all.find((d) => d.id === selectedDayId) ?? liveDay;
    if (liveDay) return liveDay;
    const completed = all
      .filter((d) => d.status === 'completed')
      .sort((a, b) => b.date.localeCompare(a.date));
    return completed[0] ?? all[all.length - 1] ?? null;
  }, [seriesDetail, selectedDayId, liveDay]);

  const scope = activeDay
    ? { level: 'day' as const, id: activeDay.id }
    : seriesId
      ? { level: 'series' as const, id: seriesId }
      : null;

  // View groups (e.g. "West") from series metadata, + the resolved
  // language/platform filter for the currently-selected group. Mirrors the
  // public viewer: selecting a group narrows the live chart, hero KPIs and
  // the channels leaderboard to that subset.
  const viewGroups = useMemo<ViewGroup[]>(() => {
    const raw = (seriesDetail?.metadata as { viewGroups?: ViewGroup[] } | undefined)?.viewGroups;
    return raw ?? [];
  }, [seriesDetail]);
  const viewFilter = useMemo<{ languages?: string[]; platforms?: string[] }>(() => {
    if (viewGroup === 'all') return {};
    const vg = viewGroups.find((g) => g.name === viewGroup);
    if (!vg) return {};
    return {
      ...(vg.languages?.length ? { languages: vg.languages } : {}),
      ...(vg.platforms?.length ? { platforms: vg.platforms } : {}),
    };
  }, [viewGroup, viewGroups]);
  const hasViewFilter = Boolean(viewFilter.languages?.length || viewFilter.platforms?.length);
  const filterKey = `${viewFilter.languages?.join(',') ?? ''}|${viewFilter.platforms?.join(',') ?? ''}`;

  // Scoped metrics + liveCCV (mirrors the desktop EditorDesktop and
  // PublicMobile behaviour). Without this the mobile dashboard's hero
  // peak/avg and the channels-tab leaderboard always render at series
  // level even when a specific day is selected. Also forced when a view
  // filter is active, since pollingData is unfiltered.
  const needsScopedFetch = scope?.level === 'day' || hasViewFilter;
  const scopeCacheKey = scope ? `${scope.level}:${scope.id}` : '';
  const { data: scopedMetrics } = usePollingApi<MetricsResponse>(
    () =>
      needsScopedFetch && scope
        ? api.getMetrics(scope.level, scope.id, viewFilter.languages, viewFilter.platforms)
        : Promise.resolve(null as unknown as MetricsResponse),
    [scopeCacheKey, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch },
  );
  const { data: scopedLiveCCV } = usePollingApi<LiveCCVResponse>(
    () =>
      needsScopedFetch && scope && seriesId
        ? api.getLiveCCV(seriesId, scope.level, scope.id, viewFilter.languages, viewFilter.platforms)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [scopeCacheKey, seriesId, filterKey],
    { intervalMs: 30_000, enabled: needsScopedFetch && !!seriesId },
  );

  const model = useDashboardModel({
    seriesDetail,
    metrics: needsScopedFetch ? scopedMetrics : pollingData.metrics,
    liveCCV: needsScopedFetch ? scopedLiveCCV : pollingData.liveCCV,
  });

  const timeline = useTimelineSeries({
    scope,
    interval: 60,
    languages: viewFilter.languages,
    platforms: viewFilter.platforms,
  });

  // All broadcast days (for the Add-channel dialog's day picker).
  const allDays = useMemo<BroadcastDay[]>(
    () => seriesDetail?.stages.flatMap((s) => s.broadcast_days) ?? [],
    [seriesDetail],
  );
  const heroAreaData = timeline.total.slice(-48);

  // Discovery feed
  const { data: discoveryChannels } = usePollingApi<Channel[]>(
    () => api.listChannels(seriesId, { source: 'auto_discovered' }),
    [seriesId, pollingData.lastDiscoveryResult?.timestamp],
    { intervalMs: 30_000 },
  );

  // Tick every 30s so the "Live · HH:MM" pill advances without needing
  // the user to hard-refresh the page.
  const nowTick = useNow(30_000);
  const broadcastDuration =
    liveDay?.broadcast_start != null
      ? nowTick - new Date(liveDay.broadcast_start).getTime()
      : null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--bg)',
      }}
    >
      {/* Top bar */}
      <header
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-raised)',
          position: 'sticky',
          top: 0,
          zIndex: 2,
        }}
      >
        <Row gap={10}>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            style={{ padding: 4 }}
            onClick={() => navigate('/')}
            title="Back to series list"
            aria-label="Back to series list"
          >
            <IconMenu size={18} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{
              background: 'transparent',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              color: 'inherit',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Series list"
            aria-label="Series list"
          >
            <LogoMark size={16} withWordmark />
          </button>
          {pollingStatus?.state === 'running' && <Pill tone="live">● Live</Pill>}
        </Row>
        {seriesId && (
          <Row gap={4} style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              style={{ padding: 6 }}
              onClick={() => navigate(`/${seriesId}/edit`)}
              title="Edit series"
              aria-label="Edit series"
            >
              <IconSettings size={16} />
            </button>
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                style={{ padding: 6 }}
                onClick={() => setMenuOpen((o) => !o)}
                title="Account menu"
                aria-label="Account menu"
                aria-expanded={menuOpen}
              >
                <IconMore size={16} />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 6px)',
                    minWidth: 180,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                    padding: 4,
                    zIndex: 20,
                  }}
                >
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/');
                    }}
                  >
                    Series list
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(`/explore/${seriesId}`);
                    }}
                  >
                    Explore (post-event)
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/settings/notifications');
                    }}
                  >
                    Notifications
                  </MenuItem>
                  {isAdmin && (
                    <>
                      <MenuItem
                        icon={<IconUsers size={13} />}
                        onClick={() => {
                          setMenuOpen(false);
                          navigate('/users');
                        }}
                      >
                        Users
                      </MenuItem>
                      <MenuItem
                        onClick={() => {
                          setMenuOpen(false);
                          navigate('/settings/youtube-keys');
                        }}
                      >
                        YouTube API keys
                      </MenuItem>
                    </>
                  )}
                  <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      logout();
                    }}
                  >
                    Sign out
                  </MenuItem>
                </div>
              )}
            </div>
          </Row>
        )}
      </header>

      {/* Body — leaves room at the bottom for the fixed bottom nav (54px tab
          area + iOS safe-area inset). */}
      <div
        style={{
          flex: 1,
          padding: '14px',
          paddingBottom: 'calc(64px + env(safe-area-inset-bottom))',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {tab === 'live' && (
          <>
            {/* View-group filter — narrows the live chart, KPIs and
                leaderboard to a group (e.g. "West"). Only shown when the
                series defines view groups. */}
            {viewGroups.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  overflowX: 'auto',
                  paddingBottom: 2,
                  marginBottom: 2,
                  WebkitOverflowScrolling: 'touch',
                }}
              >
                {[{ name: 'all', label: 'All channels' }, ...viewGroups.map((g) => ({ name: g.name, label: g.name }))].map(
                  (opt) => {
                    const active = viewGroup === opt.name;
                    return (
                      <button
                        key={opt.name}
                        type="button"
                        onClick={() => setViewGroup(opt.name)}
                        style={{
                          flex: '0 0 auto',
                          padding: '6px 13px',
                          borderRadius: 999,
                          fontSize: 12.5,
                          fontWeight: active ? 600 : 500,
                          whiteSpace: 'nowrap',
                          background: active
                            ? 'color-mix(in oklab, var(--red) 12%, var(--bg-card))'
                            : 'var(--bg-card)',
                          color: active ? 'var(--red)' : 'var(--fg)',
                          border: '1px solid ' + (active ? 'var(--red)' : 'var(--border)'),
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  },
                )}
              </div>
            )}
            {/* Hero CCV */}
            <div className="card" style={{ padding: 18 }}>
              <Row justify="space-between">
                <span className="eyebrow">Live concurrent</span>
                <Pill tone="live">● Updating</Pill>
              </Row>
              <div
                className="tabular display"
                style={{
                  fontSize: 56,
                  lineHeight: 1,
                  marginTop: 6,
                  letterSpacing: '-0.04em',
                }}
              >
                {fmtN(model.liveTotal)}
              </div>
              <Row
                gap={14}
                style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6, flexWrap: 'wrap' }}
              >
                <span>
                  Peak{' '}
                  <b className="tabular" style={{ color: 'var(--fg)' }}>
                    {fmtCompact(model.peakTotal)}
                  </b>
                </span>
                <span>
                  Avg{' '}
                  <b className="tabular" style={{ color: 'var(--fg)' }}>
                    {fmtCompact(model.avgTotal)}
                  </b>
                </span>
                <span>
                  Live channels{' '}
                  <b className="tabular" style={{ color: 'var(--fg)' }}>
                    {model.liveChannelCount}
                  </b>
                </span>
              </Row>
              <div style={{ marginTop: 12, height: 80 }}>
                {heroAreaData.length > 0 ? (
                  <AreaChart data={heroAreaData} width={320} height={80} />
                ) : (
                  <div className="placeholder" style={{ height: 80 }}>
                    Collecting…
                  </div>
                )}
              </div>
            </div>

            {/* Platform strip */}
            <div className="card" style={{ padding: 14 }}>
              <Row justify="space-between" style={{ marginBottom: 10 }}>
                <span className="eyebrow">Platform split</span>
                <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>Live CCV</span>
              </Row>
              {model.platformRows.length > 0 ? (
                <Col gap={8}>
                  {model.platformRows.slice(0, 8).map((p) => (
                    <Row key={p.id} gap={8}>
                      <Row gap={6} style={{ width: 96 }}>
                        <PlatformPip id={p.id} />
                        <span style={{ fontSize: 12 }}>{p.name}</span>
                      </Row>
                      <div
                        style={{
                          flex: 1,
                          height: 6,
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
                        style={{
                          fontSize: 11,
                          width: 56,
                          textAlign: 'right',
                          color: 'var(--fg-muted)',
                        }}
                      >
                        {fmtCompact(p.ccv)}
                      </span>
                    </Row>
                  ))}
                </Col>
              ) : (
                <div className="placeholder" style={{ height: 80 }}>
                  No active platforms
                </div>
              )}
            </div>

            {/* Schedule strip */}
            {seriesDetail && (
              <div className="card" style={{ padding: 14 }}>
                <Row justify="space-between" style={{ marginBottom: 10 }}>
                  <span className="eyebrow">Schedule</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                    Local
                  </span>
                </Row>
                <Row gap={6} wrap>
                  {seriesDetail.stages
                    .flatMap((s) => s.broadcast_days)
                    .sort((a, b) => {
                      // Live day first, then upcoming (asc), then completed (desc)
                      const rank = (d: { status: string }) =>
                        d.status === 'live' ? 0 : d.status === 'scheduled' ? 1 : 2;
                      const ra = rank(a);
                      const rb = rank(b);
                      if (ra !== rb) return ra - rb;
                      // Within scheduled: chronological asc; within completed: most recent first
                      return ra === 2
                        ? b.date.localeCompare(a.date)
                        : a.date.localeCompare(b.date);
                    })
                    .map((d) => {
                      const isActive = activeDay?.id === d.id;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setSelectedDayId(d.id)}
                          style={{
                            flex: '1 1 40%',
                            padding: 10,
                            borderRadius: 8,
                            background: isActive
                              ? 'var(--bg-card)'
                              : d.status === 'live'
                                ? 'var(--red-wash)'
                                : 'var(--bg-sunken)',
                            border: `1px solid ${
                              isActive
                                ? 'var(--red)'
                                : d.status === 'live'
                                  ? 'color-mix(in oklab, var(--red) 30%, transparent)'
                                  : 'var(--border)'
                            }`,
                            textAlign: 'left',
                            cursor: 'pointer',
                            color: 'var(--fg)',
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {d.label}
                            </span>
                            {d.status === 'live' && <Pill tone="red">LIVE</Pill>}
                            {d.status === 'completed' && (
                              <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                                ✓
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: 'var(--fg-muted)',
                              marginTop: 2,
                            }}
                          >
                            {fmtDateMD(d.date)}
                            {isActive && ' · selected'}
                          </div>
                        </button>
                      );
                    })}
                </Row>
              </div>
            )}
          </>
        )}

        {tab === 'channels' && (
          <>
            <Row gap={6} style={{ overflowX: 'auto' }}>
              {['All', 'Live'].map((x) => (
                <Pill key={x} tone={x === 'Live' ? 'live' : 'default'}>
                  {x}
                </Pill>
              ))}
            </Row>
            <Col gap={6}>
              {/* Sort by current viewers desc — live CCV when broadcast
                  is on, peak otherwise (matches the desktop ordering). */}
              {[...model.leaderboard]
                .sort((a, b) => {
                  const av = a.live > 0 ? a.live : a.peak;
                  const bv = b.live > 0 ? b.live : b.peak;
                  return bv - av;
                })
                .slice(0, 40)
                .map((c) => (
                <div
                  key={c.id}
                  className="card"
                  style={{
                    padding: 10,
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <PlatformPip id={c.platform} size={12} />
                  <Col gap={1} style={{ flex: 1, minWidth: 0 }}>
                    <Row gap={6} style={{ minWidth: 0 }}>
                      <ChannelNameWithLink
                        name={c.name}
                        platform={c.platform}
                        channelIdentifier={c.channelIdentifier}
                      />
                      <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                        {(c.language ?? '').toUpperCase()}
                      </span>
                    </Row>
                    {/* Hide stream-title sub-line for YouTube — the
                        titles are long and often misleading. Other
                        platforms keep theirs. */}
                    {c.platform !== 'youtube' && (
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
                    )}
                  </Col>
                  <Col gap={1} style={{ textAlign: 'right' }}>
                    <span
                      className="tabular"
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: c.live ? 'var(--fg)' : 'var(--fg-dim)',
                      }}
                    >
                      {c.live ? fmtCompact(c.live) : fmtCompact(c.peak)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                      {c.live ? 'Live CCV' : 'Peak'}
                    </span>
                  </Col>
                </div>
              ))}
            </Col>
          </>
        )}

        {tab === 'discovery' && (
          <DiscoveryMobileTab
            seriesId={seriesId}
            channels={discoveryChannels ?? []}
            defaultTier={seriesDetail?.discovery_default_tier ?? 'community'}
            blocklist={
              (seriesDetail?.metadata?.blocklist as string[] | undefined) ?? []
            }
            discoveryStatus={discoveryStatus}
            discoveryLoading={discoveryLoading}
            onTriggerDiscovery={onTriggerDiscovery}
          />
        )}

        {tab === 'ops' && (
          <>
            {/* Add channel — lives in Ops to keep the Channels tab clean. */}
            <Section eyebrow="Channels" title="Manage" compact>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => setAddChannelOpen(true)}
                disabled={!seriesId}
              >
                <IconPlus size={13} /> Add channel
              </button>
            </Section>

            {liveDay ? (
              <Section
                eyebrow="Broadcast day"
                title={`${liveDay.label} · ${fmtDateMD(liveDay.date)}`}
                compact
                right={
                  liveDay.status === 'live' ? (
                    <Pill tone="live">Live · {fmtDuration(broadcastDuration)}</Pill>
                  ) : (
                    <Pill>{liveDay.status}</Pill>
                  )
                }
              >
                <Row gap={6}>
                  {liveDay.status === 'live' && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        style={{ flex: 1 }}
                        onClick={() => onExtendBroadcast(liveDay.id, 30)}
                      >
                        Extend +30m
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ flex: 1, color: 'var(--danger)' }}
                        onClick={() =>
                          onBroadcastDayStatusChange(liveDay.id, 'completed')
                        }
                      >
                        End now
                      </button>
                    </>
                  )}
                </Row>
              </Section>
            ) : (
              <Section eyebrow="Broadcast day" title="No active day" compact>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Schedule a broadcast day in the series editor.
                </div>
              </Section>
            )}

            <Section
              eyebrow="Polling"
              title={
                pollingStatus?.state === 'running' ? 'Running · 30s' : 'Stopped'
              }
              compact
              right={
                <span
                  className={pollingStatus?.state === 'running' ? 'dot dot-live' : 'dot'}
                />
              }
            >
              <Row gap={6}>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={onTriggerPoll}
                  disabled={pollLoading}
                >
                  <IconBolt size={12} /> {pollLoading ? 'Polling…' : 'Poll now'}
                </button>
                {pollingStatus?.state === 'running' ? (
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1 }}
                    onClick={onStopPolling}
                  >
                    <IconPause size={12} /> Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1 }}
                    onClick={onStartPolling}
                  >
                    Start
                  </button>
                )}
              </Row>
            </Section>

            {(() => {
              const isDiscoveryActive = !!seriesId &&
                !!discoveryStatus?.activeDiscoveries.includes(seriesId);
              const lastResult = seriesId
                ? discoveryStatus?.lastResults?.[seriesId] ?? null
                : null;
              return (
                <Section
                  eyebrow="Discovery"
                  title={
                    isDiscoveryActive
                      ? `Running${
                          lastResult
                            ? ` · last ${fmtRelative(lastResult.timestamp)}`
                            : ''
                        }`
                      : lastResult
                        ? `Stopped · last ${fmtRelative(lastResult.timestamp)}`
                        : 'Stopped'
                  }
                  compact
                  right={
                    <span className={isDiscoveryActive ? 'dot dot-live' : 'dot'} />
                  }
                >
                  <Row gap={6}>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={onTriggerDiscovery}
                      disabled={!onTriggerDiscovery || discoveryLoading}
                    >
                      <IconSparkle size={12} />{' '}
                      {discoveryLoading ? 'Discovering…' : 'Discover now'}
                    </button>
                    {isDiscoveryActive ? (
                      <button
                        type="button"
                        className="btn"
                        style={{ flex: 1 }}
                        onClick={onStopDiscovery}
                        disabled={!onStopDiscovery}
                      >
                        <IconPause size={12} /> Pause
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={onStartDiscovery}
                        disabled={!onStartDiscovery}
                      >
                        Start
                      </button>
                    )}
                  </Row>
                  {lastResult && (
                    <div
                      style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 8 }}
                    >
                      Last run: <strong>{lastResult.discovered}</strong> found ·{' '}
                      <strong>{lastResult.added}</strong> added ·{' '}
                      <strong>{lastResult.resurfaced}</strong> re-surfaced ·{' '}
                      <strong>{lastResult.alreadyTracked}</strong> already tracked
                      {lastResult.errors.length > 0 && (
                        <>
                          {' · '}
                          <span style={{ color: 'var(--danger)' }}>
                            {lastResult.errors.length} errors
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </Section>
              );
            })()}

            <Section eyebrow="Adapters" title={`${PLATFORMS.length} platforms`} compact>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                {PLATFORMS.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 3,
                      padding: 8,
                      background: 'var(--bg-sunken)',
                      borderRadius: 6,
                    }}
                  >
                    <PlatformPip id={p.id} />
                    <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
                      {p.name}
                    </span>
                    <span className="dot" style={{ background: 'var(--live)' }} />
                  </div>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>

      {/* Bottom nav — fixed to viewport so it's always reachable, mirrors the
          sticky header at the top. */}
      <nav
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 5,
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-raised)',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {(
          [
            { id: 'live', label: 'Live', icon: <IconDot size={18} /> },
            { id: 'channels', label: 'Channels', icon: <IconList size={18} /> },
            { id: 'discovery', label: 'Discover', icon: <IconSparkle size={18} /> },
            { id: 'ops', label: 'Ops', icon: <IconSettings size={18} /> },
          ] as Array<{ id: MobileTab; label: string; icon: React.ReactNode }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              color: tab === t.id ? 'var(--red)' : 'var(--fg-muted)',
              fontSize: 10.5,
              fontWeight: 500,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* Add-channel dialog — opened from the Ops tab. */}
      <AddChannelDialog
        open={addChannelOpen}
        onClose={() => setAddChannelOpen(false)}
        seriesId={seriesId}
        broadcastDays={allDays}
        onAdded={() => {
          // New channel flows into the dashboard on the next poll cycle;
          // trigger one so it appears promptly.
          onTriggerPoll?.();
        }}
      />
    </div>
  );
}

// ── Discovery Mobile tab ──────────────────────────────────────────────────
// Mobile-native discovery feed: roomy cards designed for thumb-tap, with the
// same data fidelity as DiscoveryFeedSection (external link, handle, language,
// relative time, auto-pause reason, sort + source filter + count + clear-all).

type DiscoverySortKey = 'recent' | 'viewers' | 'platform' | 'name' | 'lang';

function DiscoveryMobileTab({
  seriesId,
  channels,
  defaultTier,
  blocklist,
  discoveryStatus,
  discoveryLoading,
  onTriggerDiscovery,
}: {
  seriesId: string;
  channels: Channel[];
  defaultTier: string;
  blocklist: string[];
  discoveryStatus: DiscoveryStatus | null;
  discoveryLoading?: boolean;
  onTriggerDiscovery?: () => void;
}) {
  const blocklistSet = useMemo(() => new Set(blocklist), [blocklist]);
  const [acted, setActed] = useState<Record<string, 'approved' | 'blocked'>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<DiscoverySortKey>('recent');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Same filter as DiscoveryFeedSection
  const visible = useMemo(() => {
    return channels.filter((c) => {
      if (c.source !== 'auto_discovered') return false;
      if (c.is_active) return true;
      if (blocklistSet.has(c.channel_identifier)) return true;
      const md = c.metadata as
        | { last_seen_at?: string; auto_paused?: boolean }
        | undefined;
      return !!md?.last_seen_at || !!md?.auto_paused;
    });
  }, [channels, blocklistSet]);

  // Build display rows with full metadata
  const rows = useMemo(() => {
    return visible.map((c) => {
      const md = (c.metadata ?? {}) as {
        stream_title?: string;
        discovered_ccv?: number;
        source?: string;
        last_seen_at?: string;
        auto_paused?: boolean;
        auto_paused_reason?: string;
        paused_at?: string;
      };
      const inBlocklist = blocklistSet.has(c.channel_identifier);
      const autoPaused = !!md.auto_paused;
      const actedState = acted[c.id];
      const isPending = !actedState && c.tier === 'community';
      const isBlocked = !actedState && !c.is_active && inBlocklist;
      const isDisabled =
        !actedState &&
        !c.is_active &&
        !inBlocklist &&
        !!md.last_seen_at &&
        (c.tier !== 'community' || autoPaused);
      return {
        id: c.id,
        name: c.display_name,
        handle: c.channel_identifier,
        platform: c.platform,
        viewers: Number(md.discovered_ccv ?? 0) || 0,
        title: md.stream_title ?? '',
        lang: (c.language ?? '').toUpperCase(),
        source: md.source ?? 'keyword',
        reason: md.auto_paused_reason ?? '',
        pausedAt: md.paused_at ?? md.last_seen_at ?? c.added_at,
        addedAt: c.added_at,
        tier: c.tier,
        autoPaused,
        isPending,
        isBlocked,
        isDisabled,
        actedState,
      };
    });
  }, [visible, acted, blocklistSet]);

  const sourceOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.source))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    if (sourceFilter === 'all') return rows;
    return rows.filter((r) => r.source === sourceFilter);
  }, [rows, sourceFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sort) {
        case 'viewers':
          return b.viewers - a.viewers;
        case 'platform':
          return (
            (a.platform ?? '').localeCompare(b.platform ?? '') ||
            a.name.localeCompare(b.name)
          );
        case 'name':
          return a.name.localeCompare(b.name);
        case 'lang':
          return (
            (a.lang || 'ZZZ').localeCompare(b.lang || 'ZZZ') || b.viewers - a.viewers
          );
        case 'recent':
        default:
          return (b.pausedAt || b.addedAt).localeCompare(a.pausedAt || a.addedAt) || 0;
      }
    });
    return arr;
  }, [filtered, sort]);

  const setRowBusy = (id: string, v: boolean) =>
    setBusy((m) => ({ ...m, [id]: v }));

  const handleApprove = useCallback(
    async (id: string, tier?: string) => {
      setRowBusy(id, true);
      setRowError((m) => ({ ...m, [id]: '' }));
      try {
        await api.promoteChannel(id, tier ?? defaultTier);
        setActed((m) => ({ ...m, [id]: 'approved' }));
      } catch (err) {
        setRowError((m) => ({
          ...m,
          [id]: err instanceof Error ? err.message : 'Failed to approve',
        }));
      } finally {
        setRowBusy(id, false);
      }
    },
    [defaultTier],
  );

  const handleBlock = useCallback(
    async (id: string) => {
      setRowBusy(id, true);
      setRowError((m) => ({ ...m, [id]: '' }));
      try {
        await api.blockChannel(seriesId, id);
        setActed((m) => ({ ...m, [id]: 'blocked' }));
      } catch (err) {
        setRowError((m) => ({
          ...m,
          [id]: err instanceof Error ? err.message : 'Failed to block',
        }));
      } finally {
        setRowBusy(id, false);
      }
    },
    [seriesId],
  );

  const handleClearAll = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await api.clearDiscoveryFeed(seriesId);
    } catch {
      /* ignore */
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }, [confirmClear, seriesId]);

  const isDiscoveryRunning =
    !!discoveryStatus?.activeDiscoveries.includes(seriesId);
  const lastResult = discoveryStatus?.lastResults?.[seriesId] ?? null;

  return (
    <Col gap={12}>
      {/* Header: status + count + run-now */}
      <div className="card" style={{ padding: 14 }}>
        <Row justify="space-between" style={{ alignItems: 'center' }}>
          <Col gap={3} style={{ minWidth: 0 }}>
            <span className="eyebrow" style={{ fontSize: 10 }}>
              Discovery feed
            </span>
            <span style={{ fontSize: 16, fontWeight: 600 }}>
              {sorted.length} candidate{sorted.length === 1 ? '' : 's'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {isDiscoveryRunning ? (
                <>
                  Auto-discovery <strong style={{ color: 'var(--live)' }}>running</strong>
                  {lastResult
                    ? ` · last ${fmtRelative(lastResult.timestamp)}`
                    : ''}
                </>
              ) : lastResult ? (
                <>Auto-discovery stopped · last {fmtRelative(lastResult.timestamp)}</>
              ) : (
                <>Auto-discovery stopped</>
              )}
            </span>
          </Col>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onTriggerDiscovery}
            disabled={!onTriggerDiscovery || discoveryLoading}
            style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}
          >
            <IconSparkle size={14} />{' '}
            {discoveryLoading ? 'Running…' : 'Run now'}
          </button>
        </Row>
      </div>

      {/* Sort chips — full-width scrollable */}
      <Col gap={6}>
        <span className="eyebrow" style={{ fontSize: 10 }}>
          Sort
        </span>
        <Row gap={6} style={{ overflowX: 'auto', paddingBottom: 2 }}>
          {(['recent', 'viewers', 'platform', 'name', 'lang'] as DiscoverySortKey[]).map(
            (s) => (
              <SortChipMobile
                key={s}
                active={sort === s}
                onClick={() => setSort(s)}
                label={s === 'lang' ? 'Language' : capitalise(s)}
              />
            ),
          )}
        </Row>
      </Col>

      {/* Source filter — full-width select */}
      {sourceOptions.length > 1 && (
        <Col gap={6}>
          <span className="eyebrow" style={{ fontSize: 10 }}>
            Source
          </span>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 14,
              background: 'var(--bg-card)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <option value="all">All sources ({rows.length})</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>
                {s} ({rows.filter((r) => r.source === s).length})
              </option>
            ))}
          </select>
        </Col>
      )}

      {/* Rows */}
      <Col gap={10}>
        {sorted.map((r) => {
          const isBusy = !!busy[r.id];
          const error = rowError[r.id];
          return (
            <div key={r.id} className="card" style={{ padding: 14 }}>
              {/* Row 1 — name + external link + chips */}
              <Row gap={8} style={{ alignItems: 'center', minWidth: 0 }} wrap>
                <PlatformPip id={r.platform} />
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: '1 1 auto',
                  }}
                >
                  {r.name}
                </span>
                <a
                  href={channelUrlMobile(r.platform, r.handle)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: 'var(--fg-dim)',
                    display: 'inline-flex',
                    padding: 6,
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}
                  aria-label="Open channel in a new tab"
                  title="Open channel"
                >
                  <IconExternal size={14} />
                </a>
              </Row>

              {/* Row 2 — handle + language */}
              <Row gap={6} style={{ marginTop: 6, alignItems: 'center' }} wrap>
                {r.handle && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '60%',
                    }}
                    title={r.handle}
                  >
                    {r.handle}
                  </span>
                )}
                {r.lang && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: 'var(--fg-muted)',
                      padding: '3px 7px',
                      borderRadius: 3,
                      background: 'var(--bg-sunken)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    {r.lang}
                  </span>
                )}
              </Row>

              {/* Row 3 — stream title (multi-line, clamped to 2) */}
              {r.title ? (
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--fg-muted)',
                    marginTop: 8,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    lineHeight: 1.35,
                  }}
                  title={r.title}
                >
                  {r.title}
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--fg-dim)',
                    marginTop: 8,
                    fontStyle: 'italic',
                  }}
                >
                  no stream title
                </div>
              )}

              {/* Row 4 — meta strip: source · time · pause reason */}
              <Row
                gap={8}
                style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: 'var(--fg-dim)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: 'var(--bg-sunken)',
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                  }}
                >
                  {r.source}
                </span>
                <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                  {fmtRelative(r.pausedAt)}
                </span>
                {r.reason && (
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--warn)',
                      fontStyle: 'italic',
                    }}
                    title={r.reason}
                  >
                    {r.reason}
                  </span>
                )}
              </Row>

              {/* Row 5 — viewers + status chips */}
              <Row
                gap={8}
                style={{
                  marginTop: 12,
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  className="tabular"
                  style={{ fontSize: 22, fontWeight: 600, lineHeight: 1 }}
                >
                  {fmtCompact(r.viewers)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                  viewers
                </span>
                <div style={{ flex: 1 }} />
                {r.actedState === 'approved' && (
                  <StatusChipMobile tone="live" label="Approved" />
                )}
                {r.actedState === 'blocked' && (
                  <StatusChipMobile tone="danger" label="Blocked" />
                )}
                {r.isPending && !r.actedState && (
                  <StatusChipMobile tone="info" label="Pending" />
                )}
                {r.autoPaused && !r.actedState && (
                  <StatusChipMobile tone="warn" label="Auto-paused" />
                )}
                {r.isBlocked && (
                  <StatusChipMobile tone="danger" label="Blocked" />
                )}
              </Row>

              {/* Inline error after a failed action */}
              {error && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--danger)',
                    marginTop: 8,
                    padding: '6px 8px',
                    background: 'color-mix(in oklab, var(--danger) 10%, transparent)',
                    borderRadius: 4,
                  }}
                >
                  {error}
                </div>
              )}

              {/* Row 6 — actions */}
              {r.isPending && !r.actedState && (
                <Row gap={8} style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn"
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      padding: '12px 0',
                      fontSize: 14,
                      color: 'var(--danger)',
                      border: '1px solid var(--danger)',
                    }}
                    onClick={() => handleBlock(r.id)}
                    disabled={isBusy}
                  >
                    <IconX size={15} /> {isBusy ? '…' : 'Block'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      padding: '12px 0',
                      fontSize: 14,
                    }}
                    onClick={() => handleApprove(r.id)}
                    disabled={isBusy}
                  >
                    <IconCheck size={15} /> {isBusy ? '…' : 'Approve'}
                  </button>
                </Row>
              )}
              {r.isDisabled && !r.actedState && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    marginTop: 12,
                    width: '100%',
                    justifyContent: 'center',
                    padding: '12px 0',
                    fontSize: 14,
                  }}
                  onClick={() => handleApprove(r.id, r.tier)}
                  disabled={isBusy}
                >
                  <IconCheck size={15} /> {isBusy ? '…' : 'Re-enable'}
                </button>
              )}
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="placeholder" style={{ height: 100 }}>
            No discovery candidates yet
          </div>
        )}
      </Col>

      {/* Clear all — bottom destructive action */}
      {sorted.length > 0 && (
        <button
          type="button"
          className="btn"
          onClick={handleClearAll}
          onBlur={() => setConfirmClear(false)}
          disabled={clearing}
          style={{
            marginTop: 4,
            padding: '12px 0',
            fontSize: 13,
            justifyContent: 'center',
            color: confirmClear ? 'white' : 'var(--fg-muted)',
            background: confirmClear ? 'var(--danger)' : 'transparent',
            border: `1px solid ${confirmClear ? 'var(--danger)' : 'var(--border)'}`,
          }}
        >
          <IconX size={13} />{' '}
          {clearing ? 'Clearing…' : confirmClear ? 'Tap again to confirm' : 'Clear all candidates'}
        </button>
      )}
    </Col>
  );
}

function SortChipMobile({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 14px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        fontWeight: 600,
        background: active ? 'var(--red)' : 'transparent',
        border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
        color: active ? 'white' : 'var(--fg-muted)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }}
    >
      {label}
    </button>
  );
}

function capitalise(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function channelUrlMobile(platform: string | null, id: string): string {
  switch (platform) {
    case 'twitch':
      return `https://twitch.tv/${id}`;
    case 'youtube':
      if (id.startsWith('yt-video:')) return `https://www.youtube.com/watch?v=${id.slice(9)}`;
      if (id.startsWith('@')) return `https://www.youtube.com/${id}`;
      return `https://www.youtube.com/channel/${id}`;
    case 'kick':
      return `https://kick.com/${id}`;
    case 'tiktok':
      return `https://www.tiktok.com/${id.startsWith('@') ? id : '@' + id}/live`;
    case 'steam':
      return `https://steamcommunity.com/broadcast/watch/${id}`;
    case 'soop':
      return `https://www.sooplive.co.kr/${id}`;
    case 'chzzk':
      return `https://chzzk.naver.com/${id}`;
    case 'trovo':
      return `https://trovo.live/${id}`;
    default:
      return '#';
  }
}

function StatusChipMobile({
  tone,
  label,
}: {
  tone: 'live' | 'danger' | 'info' | 'warn';
  label: string;
}) {
  const color =
    tone === 'live'
      ? 'var(--live)'
      : tone === 'danger'
        ? 'var(--danger)'
        : tone === 'warn'
          ? 'var(--warn)'
          : 'var(--info)';
  return (
    <span
      style={{
        fontSize: 9,
        padding: '3px 7px',
        borderRadius: 3,
        background: `color-mix(in oklab, ${color} 16%, transparent)`,
        color,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  );
}

// ── Account/admin menu item ───────────────────────────────────────────────
function MenuItem({
  children,
  onClick,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        background: 'transparent',
        border: 0,
        textAlign: 'left',
        fontSize: 13,
        color: 'var(--fg)',
        cursor: 'pointer',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-sunken)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}
