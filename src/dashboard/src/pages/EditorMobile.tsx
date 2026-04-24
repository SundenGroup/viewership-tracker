/**
 * Editor Mobile — bottom-nav, single-column ops companion.
 * Ported from design_handoff_clutch_tracker/reference/src/editor-mobile.jsx
 * and wired to real data.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Row,
  Col,
  LogoMark,
  Pill,
  PlatformPip,
  AreaChart,
  Section,
  IconBolt,
  IconCheck,
  IconDot,
  IconList,
  IconMenu,
  IconPause,
  IconSettings,
  IconSparkle,
  IconX,
} from '@/components/design';
import { PLATFORMS } from '@/design/platforms';
import { fmtCompact, fmtN, fmtDuration, fmtDateMD } from '@/design/format';
import { useDashboardModel } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { usePollingApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import type {
  TournamentSeries,
  SeriesWithStages,
  OrchestratorStatus,
  DiscoveryStatus,
  Channel,
  BroadcastStatus,
} from '@/types/api';
import type { PollingDataState } from '@/hooks/usePollingData';

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
  pollLoading?: boolean;
}

export function EditorMobile({
  seriesId,
  seriesDetail,
  pollingData,
  pollingStatus,
  onExtendBroadcast,
  onBroadcastDayStatusChange,
  onTriggerPoll,
  onStartPolling,
  onStopPolling,
  pollLoading,
}: EditorMobileProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<MobileTab>('live');
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);

  const model = useDashboardModel({
    seriesDetail,
    metrics: pollingData.metrics,
    liveCCV: pollingData.liveCCV,
  });
  const liveDay = model.liveDay;

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

  const timeline = useTimelineSeries({ scope, interval: 60 });
  const heroAreaData = timeline.total.slice(-48);

  // Discovery feed
  const { data: discoveryChannels } = usePollingApi<Channel[]>(
    () => api.listChannels(seriesId, { source: 'auto_discovered' }),
    [seriesId, pollingData.lastDiscoveryResult?.timestamp],
    { intervalMs: 30_000 },
  );

  const broadcastDuration =
    liveDay?.broadcast_start != null
      ? Date.now() - new Date(liveDay.broadcast_start).getTime()
      : null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
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
          <LogoMark size={16} withWordmark />
          {pollingStatus?.state === 'running' && <Pill tone="live">● Live</Pill>}
        </Row>
        {seriesId && (
          <Row gap={4}>
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
          </Row>
        )}
      </header>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {tab === 'live' && (
          <>
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
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .slice(0, 6)
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
              {model.leaderboard.slice(0, 40).map((c) => (
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
                    <Row gap={6}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</span>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                        {(c.language ?? '').toUpperCase()}
                      </span>
                    </Row>
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
                      {c.live ? fmtCompact(c.live) : '—'}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                      Live CCV
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
          />
        )}

        {tab === 'ops' && (
          <>
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

      {/* Bottom nav */}
      <nav
        style={{
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
    </div>
  );
}

// ── Discovery Mobile tab ──────────────────────────────────────────────────
// Mirrors the filter + state machine from DiscoveryFeedSection so the
// mobile view never shows Approve on already-approved streams.
//
//   Filter (source='auto_discovered' only):
//     - Keep active channels (pending first approval)
//     - Keep inactive channels when blocked / auto-paused / re-surfaced
//
//   Row state:
//     - Pending (tier='community')         → [Approve] [Block]
//     - Blocked (inactive + blocklisted)   → "BLOCKED" chip
//     - Disabled (inactive + last_seen_at) → [Re-enable]

function DiscoveryMobileTab({
  seriesId,
  channels,
  defaultTier,
  blocklist,
}: {
  seriesId: string;
  channels: Channel[];
  defaultTier: string;
  blocklist: string[];
}) {
  const blocklistSet = useMemo(() => new Set(blocklist), [blocklist]);
  const [acted, setActed] = useState<Record<string, 'approved' | 'blocked'>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

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

  const handleApprove = async (id: string, tier?: string) => {
    setBusy((m) => ({ ...m, [id]: true }));
    try {
      await api.promoteChannel(id, tier ?? defaultTier);
      setActed((m) => ({ ...m, [id]: 'approved' }));
    } catch {
      /* ignore */
    } finally {
      setBusy((m) => ({ ...m, [id]: false }));
    }
  };

  const handleBlock = async (id: string) => {
    setBusy((m) => ({ ...m, [id]: true }));
    try {
      await api.blockChannel(seriesId, id);
      setActed((m) => ({ ...m, [id]: 'blocked' }));
    } catch {
      /* ignore */
    } finally {
      setBusy((m) => ({ ...m, [id]: false }));
    }
  };

  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        Tap Approve to promote, Re-enable to resume a paused channel, or
        Block to hide.
      </div>
      <Col gap={10}>
        {visible.map((c) => {
          const md = (c.metadata ?? {}) as {
            stream_title?: string;
            discovered_ccv?: number;
            source?: string;
            last_seen_at?: string;
            auto_paused?: boolean;
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
          const isBusy = !!busy[c.id];

          return (
            <div key={c.id} className="card" style={{ padding: 14 }}>
              <Row justify="space-between">
                <Row gap={8}>
                  <PlatformPip id={c.platform} />
                  <span style={{ fontSize: 14, fontWeight: 500 }}>
                    {c.display_name}
                  </span>
                </Row>
                <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                  {md.source ?? 'keyword'}
                </span>
              </Row>
              {md.stream_title && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    marginTop: 6,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {md.stream_title}
                </div>
              )}
              <Row gap={8} style={{ marginTop: 10, alignItems: 'center' }}>
                <span className="tabular" style={{ fontSize: 16, fontWeight: 500 }}>
                  {fmtCompact(Number(md.discovered_ccv ?? 0) || 0)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>viewers</span>
                {autoPaused && (
                  <span
                    style={{
                      fontSize: 9,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: 'color-mix(in oklab, var(--warn) 16%, transparent)',
                      color: 'var(--warn)',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Auto-paused
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {actedState === 'approved' && (
                  <StatusChipMobile tone="live" label="Approved" />
                )}
                {actedState === 'blocked' && (
                  <StatusChipMobile tone="danger" label="Blocked" />
                )}
                {isBlocked && <StatusChipMobile tone="danger" label="Blocked" />}
              </Row>
              {isPending && !actedState && (
                <Row gap={6} style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn"
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      color: 'var(--danger)',
                    }}
                    onClick={() => handleBlock(c.id)}
                    disabled={isBusy}
                  >
                    <IconX size={14} /> Block
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => handleApprove(c.id)}
                    disabled={isBusy}
                  >
                    <IconCheck size={14} /> {isBusy ? '…' : 'Approve'}
                  </button>
                </Row>
              )}
              {isDisabled && !actedState && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    marginTop: 10,
                    width: '100%',
                    justifyContent: 'center',
                  }}
                  onClick={() => handleApprove(c.id, c.tier)}
                  disabled={isBusy}
                >
                  <IconCheck size={14} /> {isBusy ? '…' : 'Re-enable'}
                </button>
              )}
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="placeholder" style={{ height: 100 }}>
            No discovery candidates yet
          </div>
        )}
      </Col>
    </>
  );
}

function StatusChipMobile({
  tone,
  label,
}: {
  tone: 'live' | 'danger';
  label: string;
}) {
  const color = tone === 'live' ? 'var(--live)' : 'var(--danger)';
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
