import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import * as api from '@/services/api';
import type {
  GameTrackerChannelTimelineResponse,
  GameTrackerHealthEvidence,
  GameTrackerStreamDetailResponse,
} from '@/services/api';
import {
  Row,
  Col,
  Section,
  Pill,
  PlatformPip,
  IconBolt,
  IconUsers,
  IconUser,
  IconEye,
  IconTrophy,
  IconChev,
  IconList,
  IconDownload,
} from '@/components/design';
import { fmtN, fmtCompact, fmtDuration } from '@/design/format';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { Avatar } from './DiscoverDetailPage';
import { ChannelKpi, healthGradeColor } from './DiscoverChannelPage';

type TrackerChannelMeta = GameTrackerChannelTimelineResponse['channel'];

interface MergedPoint {
  ts: string;
  t: number;
  ccv: number;
  messages: number;
  chatters: number;
  titleChange?: string;
}

/**
 * /discover/:slug/channel/:channelId/stream/:streamId — one broadcast in
 * depth: per-minute viewers overlaid with chat volume, title-change
 * markers, follower movement and prev/next stream navigation.
 *
 * Chat and follower data are optional in the contract — every block that
 * depends on them hides itself when the backend has nothing.
 */
export function DiscoverStreamPage() {
  const { slug, channelId, streamId } = useParams<{
    slug: string;
    channelId: string;
    streamId: string;
  }>();
  const location = useLocation();
  const [detail, setDetail] = useState<GameTrackerStreamDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Channel meta rides along from the sessions table (location.state) so the
  // header paints instantly; direct URL loads fall back to a tiny timeline
  // call — the only existing endpoint that returns channel display info.
  const [channel, setChannel] = useState<TrackerChannelMeta | null>(
    () => (location.state as { channel?: TrackerChannelMeta } | null)?.channel ?? null,
  );
  const chan = channel && channel.id === channelId ? channel : null;

  useEffect(() => {
    if (!slug || !channelId || !streamId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .getGameTrackerStreamDetail(slug, channelId, streamId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, channelId, streamId]);

  useEffect(() => {
    if (chan || !slug || !channelId) return;
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 60_000);
    api
      .getGameTrackerChannelTimeline(slug, channelId, from, to, 300)
      .then((res) => {
        if (!cancelled) setChannel(res.channel);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chan, slug, channelId]);

  // Merge the viewer timeline with per-minute chat, and snap title-change
  // markers onto real timeline points so ReferenceLines land on the
  // category axis.
  const chart = useMemo(() => {
    const empty = {
      rows: [] as MergedPoint[],
      markers: [] as Array<{ ts: string; title: string }>,
      hasChatBars: false,
    };
    if (!detail) return empty;
    const chatByMinute = new Map<number, { messages: number; chatters: number }>();
    for (const c of detail.chat ?? []) {
      const t = Date.parse(c.minute);
      if (!Number.isNaN(t)) {
        chatByMinute.set(Math.floor(t / 60_000), {
          messages: Number(c.messages) || 0,
          chatters: Number(c.chatters) || 0,
        });
      }
    }
    const rows: MergedPoint[] = (detail.timeline ?? []).map((p) => {
      const t = Date.parse(p.ts);
      const chat = chatByMinute.get(Math.floor(t / 60_000));
      return {
        ts: p.ts,
        t,
        ccv: Number(p.ccv) || 0,
        messages: chat?.messages ?? 0,
        chatters: chat?.chatters ?? 0,
      };
    });
    const markers: Array<{ ts: string; title: string }> = [];
    (detail.titleChanges ?? []).forEach((tc, i) => {
      if (i === 0 || rows.length === 0) return; // first entry is the opening title
      const t = Date.parse(tc.at);
      if (Number.isNaN(t)) return;
      let best = 0;
      let bestD = Infinity;
      rows.forEach((r, idx) => {
        const d = Math.abs(r.t - t);
        if (d < bestD) {
          bestD = d;
          best = idx;
        }
      });
      rows[best] = { ...rows[best]!, titleChange: tc.title };
      markers.push({ ts: rows[best]!.ts, title: tc.title });
    });
    return { rows, markers, hasChatBars: (detail.chat ?? []).length > 0 };
  }, [detail]);

  const peakPoint = useMemo(() => {
    let best: MergedPoint | null = null;
    for (const r of chart.rows) if (!best || r.ccv > best.ccv) best = r;
    return best;
  }, [chart]);

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <BackLink slug={slug} channelId={channelId} />
        <Section style={{ marginTop: 20, color: 'var(--red)' }}>{error}</Section>
      </div>
    );
  }
  if (!detail || !slug || !channelId) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-muted)' }}>
        <BackLink slug={slug} channelId={channelId} />
        <div style={{ marginTop: 20 }}>Loading…</div>
      </div>
    );
  }

  const session = detail.session;
  const isLive = session.status === 'live';
  const latestTitle =
    session.titles.length > 0 ? session.titles[session.titles.length - 1]!.title : null;
  const start = new Date(session.started_at);
  const end = session.ended_at ? new Date(session.ended_at) : null;
  const startTime = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTime = isLive
    ? 'now'
    : end
      ? end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';

  const messages = Number(session.messages) || 0;
  const chatters = Number(session.unique_chatters) || 0;
  const hasChatData = chart.hasChatBars || messages > 0 || chatters > 0;
  const hoursWatched = Math.round((Number(session.ccv_minutes) / 60) * 10) / 10;
  const followers = detail.followers;
  const followersDelta = followers?.delta ?? null;
  const rank = detail.rank;
  const hasRank = rank != null && rank.byPeakInTracker != null && rank.of != null;

  const profilePic = (chan?.metadata?.profile_image_url as string | undefined) ?? null;

  const streamUrl = (id: string | null) =>
    id ? `/discover/${slug}/channel/${channelId}/stream/${id}` : null;
  const prevTo = streamUrl(detail.prevStreamId);
  const nextTo = streamUrl(detail.nextStreamId);
  const navState = chan ? { channel: chan } : undefined;

  const exportCsv = () => {
    if (chart.rows.length === 0) return;
    downloadCsv(
      `${slug}-stream-${streamId}-${csvStamp()}.csv`,
      ['minute', 'viewers', 'messages', 'chatters'],
      chart.rows.map((r) => [
        r.ts,
        r.ccv,
        chart.hasChatBars ? r.messages : null,
        chart.hasChatBars ? r.chatters : null,
      ]),
    );
  };

  return (
    <div style={{ padding: '32px 24px 64px', maxWidth: 1280, margin: '0 auto' }}>
      <Row justify="space-between" align="center">
        <BackLink slug={slug} channelId={channelId} />
        <Row gap={6} align="center">
          <NavChevron to={prevTo} dir="prev" state={navState} />
          <NavChevron to={nextTo} dir="next" state={navState} />
        </Row>
      </Row>

      {/* Header */}
      <Row gap={16} align="flex-start" style={{ marginTop: 16, marginBottom: 24 }}>
        <Avatar src={profilePic} name={chan?.display_name ?? '?'} size={52} />
        <Col gap={7} style={{ minWidth: 0, flex: 1 }}>
          <Row gap={10} align="center" wrap>
            <h1
              style={{
                fontFamily: 'var(--font-display, var(--font-sans))',
                fontSize: 26,
                fontWeight: 700,
                color: 'var(--fg)',
                margin: 0,
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              {chan?.display_name ?? '…'}
            </h1>
            <PlatformPip id={chan?.platform ?? null} size={12} />
            {isLive && (
              <Pill tone="live">
                <span className="dot dot-live" /> live
              </Pill>
            )}
          </Row>
          <div
            title={latestTitle ?? ''}
            style={{
              fontSize: 14,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {latestTitle ?? '—'}
          </div>
          <Row gap={10} wrap align="center" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {session.category && <Pill>{session.category}</Pill>}
            <span>
              {start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            <span className="mono tabular">
              {startTime}–{endTime}
            </span>
            <span>{fmtDuration(session.minutes_live * 60_000)}</span>
            {session.titles.length > 1 && (
              <span style={{ color: 'var(--fg-dim)' }}>
                {session.titles.length - 1} title change{session.titles.length > 2 ? 's' : ''}
              </span>
            )}
          </Row>
        </Col>
      </Row>

      {/* KPI strip */}
      <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 16 }}>
        <ChannelKpi
          icon={<IconTrophy size={13} />}
          label="Peak CCV"
          value={fmtN(session.peak_ccv)}
          sub={
            peakPoint
              ? new Date(peakPoint.ts).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : undefined
          }
        />
        <ChannelKpi icon={<IconUsers size={13} />} label="Avg CCV" value={fmtN(session.avg_ccv)} />
        <ChannelKpi
          icon={<IconEye size={13} />}
          label="Hours watched"
          value={fmtCompact(hoursWatched)}
        />
        {hasChatData && (
          <ChannelKpi icon={<IconList size={13} />} label="Messages" value={fmtN(messages)} />
        )}
        {hasChatData && (
          <ChannelKpi
            icon={<IconUsers size={13} />}
            label="Unique chatters"
            value={fmtN(chatters)}
          />
        )}
        {hasChatData && session.minutes_live > 0 && (
          <ChannelKpi
            icon={<IconBolt size={13} />}
            label="Msgs/min"
            value={(messages / session.minutes_live).toFixed(1)}
          />
        )}
        {followersDelta != null && (
          <ChannelKpi
            icon={<IconUser size={13} />}
            label="Followers ±"
            value={
              <span style={{ color: followersDelta >= 0 ? 'var(--live)' : 'var(--red)' }}>
                {followersDelta >= 0 ? '+' : ''}
                {fmtN(followersDelta)}
              </span>
            }
            sub={
              followers?.start != null && followers?.end != null
                ? `${fmtCompact(followers.start)} → ${fmtCompact(followers.end)}`
                : undefined
            }
          />
        )}
      </Row>

      {/* Stream health — rendered only once the scorer has graded this
          session (ended, big enough, chat-covered) AND the channel has
          passed the evidence gate (enough scored sessions). */}
      {session.health_grade != null && session.health_score != null && (
        <StreamHealthPanel
          grade={session.health_grade}
          score={session.health_score}
          evidence={session.health_evidence}
        />
      )}
      {detail?.healthPending && detail.healthPending.scored > 0 && (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            color: 'var(--fg-dim)',
            background: 'var(--bg-sunken)',
            borderRadius: 6,
          }}
        >
          Stream health: collecting data — {detail.healthPending.scored}/
          {detail.healthPending.required} sessions scored. Grades appear once
          enough streams have been measured to be fair.
        </div>
      )}

      {/* Main chart */}
      <Section
        title={chart.hasChatBars ? 'Viewers & chat activity' : 'Concurrent viewers'}
        eyebrow="PER-MINUTE"
        style={{ marginBottom: 16 }}
        right={
          <Row gap={8} align="center">
            {hasRank && (
              <span className="chip tabular" style={{ whiteSpace: 'nowrap' }}>
                #{rank!.byPeakInTracker} of {rank!.of} streams this day (by peak)
              </span>
            )}
            <button
              type="button"
              className="btn btn-xs"
              onClick={exportCsv}
              disabled={chart.rows.length === 0}
              style={{ cursor: 'pointer' }}
            >
              <IconDownload size={11} /> CSV
            </button>
          </Row>
        }
      >
        {chart.rows.length === 0 ? (
          <div style={{ padding: '24px 0', color: 'var(--fg-muted)', fontSize: 13 }}>
            No per-minute data for this stream.
          </div>
        ) : (
          <div style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart.rows} margin={{ top: 8, right: 16, bottom: 5, left: 5 }}>
                <CartesianGrid stroke="var(--border-faint)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v: string) =>
                    new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  }
                  stroke="var(--fg-dim)"
                  fontSize={11}
                  minTickGap={40}
                />
                <YAxis
                  yAxisId="ccv"
                  stroke="var(--fg-dim)"
                  fontSize={11}
                  width={50}
                  tickFormatter={(v: number) => fmtCompact(v)}
                />
                {chart.hasChatBars && (
                  <YAxis
                    yAxisId="chat"
                    orientation="right"
                    stroke="var(--fg-dim)"
                    fontSize={11}
                    width={44}
                    tickFormatter={(v: number) => fmtCompact(v)}
                  />
                )}
                <Tooltip content={<StreamTooltip hasChat={chart.hasChatBars} />} />
                {chart.markers.map((m, i) => (
                  <ReferenceLine
                    key={`${m.ts}-${i}`}
                    x={m.ts}
                    yAxisId="ccv"
                    stroke="var(--border-strong)"
                    strokeDasharray="4 4"
                  />
                ))}
                {chart.hasChatBars && (
                  <Bar
                    yAxisId="chat"
                    dataKey="messages"
                    name="Messages/min"
                    fill="var(--info)"
                    fillOpacity={0.35}
                    isAnimationActive={false}
                  />
                )}
                <Line
                  yAxisId="ccv"
                  type="monotone"
                  dataKey="ccv"
                  name="Viewers"
                  stroke="var(--red)"
                  strokeWidth={1.8}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Section>

      {/* Prev/next footer */}
      <Row justify="space-between" align="center">
        <FooterNavLink to={prevTo} state={navState} label="← previous stream" />
        <FooterNavLink to={nextTo} state={navState} label="next stream →" />
      </Row>
    </div>
  );
}

function BackLink({ slug, channelId }: { slug: string | undefined; channelId: string | undefined }) {
  return (
    <Link
      to={slug && channelId ? `/discover/${slug}/channel/${channelId}` : '/discover'}
      style={{
        color: 'var(--fg-muted)',
        fontSize: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        textDecoration: 'none',
      }}
    >
      <span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}>
        <IconChev size={12} />
      </span>
      back to channel
    </Link>
  );
}

function NavChevron({
  to,
  dir,
  state,
}: {
  to: string | null;
  dir: 'prev' | 'next';
  state?: { channel: TrackerChannelMeta };
}) {
  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-sunken)',
    color: to ? 'var(--fg-muted)' : 'var(--fg-faint)',
    textDecoration: 'none',
  };
  const icon = (
    <span
      style={{
        display: 'inline-flex',
        transform: dir === 'prev' ? 'rotate(180deg)' : undefined,
      }}
    >
      <IconChev size={13} />
    </span>
  );
  if (!to) {
    return (
      <span style={style} aria-disabled="true">
        {icon}
      </span>
    );
  }
  return (
    <Link to={to} state={state} title={dir === 'prev' ? 'Previous stream' : 'Next stream'} style={style}>
      {icon}
    </Link>
  );
}

function FooterNavLink({
  to,
  state,
  label,
}: {
  to: string | null;
  state?: { channel: TrackerChannelMeta };
  label: string;
}) {
  if (!to) {
    return <span style={{ fontSize: 12, color: 'var(--fg-faint)' }}>{label}</span>;
  }
  return (
    <Link
      to={to}
      state={state}
      style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }}
    >
      {label}
    </Link>
  );
}

const SUBSCORE_SPEC = [
  { key: 'engagement', label: 'Engagement', max: 40 },
  { key: 'curve', label: 'Curve', max: 30 },
  { key: 'followers', label: 'Followers', max: 15 },
  { key: 'spikeResponse', label: 'Response', max: 15 },
] as const;

/**
 * "Stream health" card — the per-session integrity grade with its
 * evidence: big A-F letter + score, subscore mini-bars, and the scorer's
 * plain-language flags. Health first, accusation never: the footnote
 * frames everything as signals, not proof.
 */
function StreamHealthPanel({
  grade,
  score,
  evidence,
}: {
  grade: string;
  score: number;
  evidence: GameTrackerHealthEvidence | null;
}) {
  const gradeCol = healthGradeColor(grade);
  const subs = evidence?.subscores ?? null;
  const flags = evidence?.flags ?? [];
  const cohort = evidence?.cohort ?? null;
  const engagementPct = evidence?.engagementPct ?? null;
  return (
    <Section
      title="Stream health"
      eyebrow="INTEGRITY SIGNALS"
      style={{ marginBottom: 16 }}
      right={
        cohort != null && cohort.n > 0 ? (
          <span className="chip tabular" style={{ whiteSpace: 'nowrap' }}>
            vs {fmtN(cohort.n)} {cohort.band} CCV streams (30d)
          </span>
        ) : undefined
      }
    >
      <Row gap={24} align="flex-start" wrap>
        {/* Grade */}
        <Col gap={4} style={{ alignItems: 'center', minWidth: 88 }}>
          <div
            style={{
              fontFamily: 'var(--font-display, var(--font-sans))',
              fontSize: 46,
              fontWeight: 700,
              lineHeight: 1,
              color: gradeCol,
            }}
          >
            {grade}
          </div>
          <div className="mono tabular" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {score}/100
          </div>
        </Col>

        {/* Subscore mini-bars */}
        {subs != null && (
          <Col gap={8} style={{ flex: '1 1 220px', minWidth: 200 }}>
            {SUBSCORE_SPEC.map(({ key, label, max }) => {
              const value = Math.max(0, Math.min(max, subs[key]));
              const ratio = max > 0 ? value / max : 0;
              const barCol =
                ratio >= 2 / 3 ? 'var(--live)' : ratio >= 1 / 3 ? 'var(--warn)' : 'var(--danger)';
              return (
                <Row key={key} gap={8} align="center">
                  <span
                    style={{
                      width: 82,
                      flexShrink: 0,
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                    }}
                  >
                    {label}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 5,
                      borderRadius: 999,
                      background: 'var(--bg-sunken)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.round(ratio * 100)}%`,
                        height: '100%',
                        borderRadius: 999,
                        background: barCol,
                      }}
                    />
                  </div>
                  <span
                    className="mono tabular"
                    style={{ width: 44, flexShrink: 0, fontSize: 11, color: 'var(--fg-dim)', textAlign: 'right' }}
                  >
                    {value}/{max}
                  </span>
                </Row>
              );
            })}
          </Col>
        )}

        {/* Evidence flags */}
        <Col gap={6} style={{ flex: '1.4 1 280px', minWidth: 240 }}>
          {flags.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              No integrity flags for this session.
            </div>
          ) : (
            flags.map((f, i) => (
              <Row key={`${f.kind}-${i}`} gap={7} align="flex-start">
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: f.severity === 'critical' ? 'var(--danger)' : 'var(--warn)',
                    flexShrink: 0,
                    marginTop: 5,
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--fg)', lineHeight: 1.5 }}>
                  {f.detail}
                </span>
              </Row>
            ))
          )}
        </Col>
      </Row>

      <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
        {engagementPct != null && cohort != null && (
          <>Chat engagement in the {ordinal(engagementPct)} percentile of its cohort. </>
        )}
        {evidence?.rawScore != null && (
          <>Red-flag rules adjusted this score from a base of {evidence.rawScore}. </>
        )}
        C means typical — D and F appear only when red flags are detected. Signals, not proof.
      </div>
    </Section>
  );
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

/**
 * Custom tooltip: time, viewers, chat volume and — when the hovered minute
 * carries a title-change marker — the new title.
 */
function StreamTooltip({
  active,
  payload,
  hasChat,
}: {
  active?: boolean;
  payload?: Array<{ payload?: MergedPoint }>;
  hasChat?: boolean;
}) {
  const row = active && payload && payload.length > 0 ? payload[0]?.payload : undefined;
  if (!row) return null;
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--bg-card) 95%, transparent)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        fontSize: 11.5,
        padding: '8px 10px',
        maxWidth: 320,
      }}
    >
      <div style={{ color: 'var(--fg-muted)', marginBottom: 4 }}>
        {new Date(row.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="tabular" style={{ color: 'var(--red)', fontWeight: 600 }}>
        {fmtN(row.ccv)} viewers
      </div>
      {hasChat && (
        <div className="tabular" style={{ color: 'var(--info)', marginTop: 2 }}>
          {fmtN(row.messages)} messages · {fmtN(row.chatters)} chatters
        </div>
      )}
      {row.titleChange && (
        <div
          style={{
            marginTop: 5,
            paddingTop: 5,
            borderTop: '1px solid var(--border)',
            color: 'var(--fg)',
            whiteSpace: 'normal',
          }}
        >
          <span style={{ color: 'var(--fg-muted)' }}>Title → </span>
          {row.titleChange}
        </div>
      )}
    </div>
  );
}
