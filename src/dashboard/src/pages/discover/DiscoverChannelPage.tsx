import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import * as api from '@/services/api';
import type {
  GameTrackerChannelTimelineResponse,
  GameTrackerChannelSession,
} from '@/services/api';
import {
  Row,
  Col,
  Section,
  Kpi,
  Pill,
  PlatformPip,
  ChannelNameWithLink,
  ThemeToggle,
  IconBolt,
  IconUsers,
  IconTrophy,
  IconCalendar,
  IconChev,
} from '@/components/design';
import { fmtN, fmtCompact, fmtDuration } from '@/design/format';
import { Avatar } from './DiscoverDetailPage';

type RangePreset = '24h' | '7d' | '30d';

const RANGES: Record<RangePreset, { hours: number; bucketSeconds: number; label: string }> = {
  '24h': { hours: 24, bucketSeconds: 300, label: '24h' },
  '7d': { hours: 24 * 7, bucketSeconds: 1800, label: '7d' },
  '30d': { hours: 24 * 30, bucketSeconds: 3600, label: '30d' },
};

/**
 * /discover/:slug/channel/:channelId — broadcast detail for one streamer
 * within a tracker. Shows their CCV timeline, peak/avg over the range,
 * and a list of recent sessions (each contiguous run with the same
 * stream_id).
 */
export function DiscoverChannelPage() {
  const { slug, channelId } = useParams<{ slug: string; channelId: string }>();
  const [rangeKey, setRangeKey] = useState<RangePreset>('24h');
  const [data, setData] = useState<GameTrackerChannelTimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug || !channelId) return;
    let cancelled = false;
    const r = RANGES[rangeKey];
    const from = new Date(Date.now() - r.hours * 60 * 60_000);
    const to = new Date();
    api
      .getGameTrackerChannelTimeline(slug, channelId, from, to, r.bucketSeconds)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, channelId, rangeKey]);

  const peakCcv = useMemo(
    () => (data?.timeline ?? []).reduce((m, b) => (b.concurrent_viewers > m ? b.concurrent_viewers : m), 0),
    [data],
  );
  const avgCcv = useMemo(() => {
    const t = data?.timeline ?? [];
    if (t.length === 0) return 0;
    return Math.round(t.reduce((s, b) => s + b.concurrent_viewers, 0) / t.length);
  }, [data]);
  const peakBucket = useMemo(
    () => data?.timeline.find((b) => b.concurrent_viewers === peakCcv) ?? null,
    [data, peakCcv],
  );
  const totalSessions = data?.sessions?.length ?? 0;
  const totalMinutes = useMemo(
    () => (data?.sessions ?? []).reduce((s, x) => s + x.minutes_live, 0),
    [data],
  );
  const profilePic = (data?.channel?.metadata?.profile_image_url as string | undefined) ?? null;

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <BackLink slug={slug} />
        <Section style={{ marginTop: 20, color: 'var(--red)' }}>{error}</Section>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-muted)' }}>
        <BackLink slug={slug} />
        <div style={{ marginTop: 20 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 24px 64px', maxWidth: 1280, margin: '0 auto' }}>
      <Row justify="space-between" align="center">
        <BackLink slug={slug} />
        <ThemeToggle />
      </Row>

      {/* Hero */}
      <Row gap={16} align="center" style={{ marginTop: 16, marginBottom: 28 }}>
        <Avatar src={profilePic} name={data.channel.display_name} size={64} />
        <Col gap={6}>
          <Row gap={10} align="center">
            <h1
              style={{
                fontFamily: 'var(--font-display, var(--font-sans))',
                fontSize: 36,
                fontWeight: 700,
                color: 'var(--fg)',
                margin: 0,
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              {data.channel.display_name}
            </h1>
            <Pill tone={data.timeline.length > 0 && data.timeline[data.timeline.length - 1]!.concurrent_viewers > 0 ? 'live' : 'default'}>
              {data.channel.platform}
            </Pill>
          </Row>
          <Row gap={6} align="center" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            <PlatformPip id={data.channel.platform} size={11} />
            <ChannelNameWithLink
              name={data.channel.channel_identifier}
              platform={data.channel.platform}
              channelIdentifier={data.channel.channel_identifier}
              weight={400}
            />
          </Row>
        </Col>
      </Row>

      {/* Range picker */}
      <Row gap={8} align="center" style={{ marginBottom: 16 }}>
        <span
          className="eyebrow"
          style={{
            fontSize: 10,
            color: 'var(--fg-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <IconCalendar size={11} /> Range
        </span>
        <Row gap={4}>
          {(Object.keys(RANGES) as RangePreset[]).map((k) => (
            <RangePill key={k} active={rangeKey === k} onClick={() => setRangeKey(k)}>
              {RANGES[k].label}
            </RangePill>
          ))}
        </Row>
      </Row>

      {/* KPIs */}
      <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 16 }}>
        <ChannelKpi
          icon={<IconTrophy size={13} />}
          label="Peak CCV"
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
        <ChannelKpi
          icon={<IconUsers size={13} />}
          label={`Avg CCV (${RANGES[rangeKey].label})`}
          value={fmtN(avgCcv)}
        />
        <ChannelKpi
          icon={<IconBolt size={13} />}
          label="Sessions"
          value={String(totalSessions)}
          sub={`${fmtDuration(totalMinutes * 60_000)} live`}
        />
      </Row>

      {/* Timeline chart */}
      <Section
        title="Concurrent viewers"
        eyebrow="TIMELINE"
        style={{ marginBottom: 16 }}
      >
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.timeline} margin={{ top: 8, right: 16, bottom: 5, left: 5 }}>
              <CartesianGrid stroke="var(--border-faint)" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                tickFormatter={(v: string) => {
                  const d = new Date(v);
                  return rangeKey === '24h'
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                }}
                stroke="var(--fg-dim)"
                fontSize={11}
                minTickGap={40}
              />
              <YAxis
                stroke="var(--fg-dim)"
                fontSize={11}
                width={50}
                tickFormatter={(v: number) => fmtCompact(v)}
              />
              <Tooltip
                contentStyle={{
                  background: 'color-mix(in oklab, var(--bg-card) 95%, transparent)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 6,
                  fontSize: 11.5,
                  padding: '8px 10px',
                }}
                labelFormatter={(v: string) => new Date(v).toLocaleString()}
                formatter={(value: number) => [value.toLocaleString(), 'CCV']}
              />
              <Line
                type="monotone"
                dataKey="concurrent_viewers"
                name="CCV"
                stroke="var(--red)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* Recent sessions */}
      <Section title="Recent broadcasts" eyebrow="SESSIONS">
        <SessionsTable sessions={data.sessions ?? []} />
      </Section>
    </div>
  );
}

function BackLink({ slug }: { slug: string | undefined }) {
  return (
    <Link
      to={slug ? `/discover/${slug}?tab=channels` : '/discover'}
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
      back to tracker
    </Link>
  );
}

function ChannelKpi({
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
        padding: '20px 24px',
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

function SessionsTable({ sessions }: { sessions: GameTrackerChannelSession[] }) {
  if (sessions.length === 0) {
    return (
      <div style={{ padding: '12px 0', color: 'var(--fg-muted)', fontSize: 13 }}>
        No completed sessions in the last 30 days.
      </div>
    );
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={th}>Started</th>
          <th style={th}>Title</th>
          <th style={{ ...th, textAlign: 'right' }}>Peak</th>
          <th style={{ ...th, textAlign: 'right' }}>Avg</th>
          <th style={{ ...th, textAlign: 'right' }}>Duration</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={`${s.stream_id}-${s.started_at}`} style={{ borderBottom: '1px solid var(--border-faint)' }}>
            <td style={td}>
              <div style={{ fontSize: 12, color: 'var(--fg)' }}>
                {new Date(s.started_at).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                {new Date(s.started_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </td>
            <td
              style={{
                ...td,
                color: 'var(--fg)',
                maxWidth: 480,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={s.stream_title ?? ''}
            >
              {s.stream_title ?? '—'}
            </td>
            <td style={{ ...td, ...numTd, fontWeight: 600 }}>{fmtCompact(s.peak_ccv)}</td>
            <td style={{ ...td, ...numTd, color: 'var(--fg-muted)' }}>{fmtCompact(s.avg_ccv)}</td>
            <td style={{ ...td, ...numTd, color: 'var(--fg-dim)' }}>
              {fmtDuration(s.minutes_live * 60_000)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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
        background: active
          ? 'color-mix(in oklab, var(--red) 12%, transparent)'
          : 'transparent',
        color: active ? 'var(--red)' : 'var(--fg-muted)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const th: React.CSSProperties = {
  padding: '8px 6px',
  textAlign: 'left',
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const td: React.CSSProperties = {
  padding: '12px 6px',
};

const numTd: React.CSSProperties = {
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
};
