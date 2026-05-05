import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import * as api from '@/services/api';
import type {
  GameTrackerDetail,
  GameTrackerLeaderboardRow,
  GameTrackerRangeBucket,
} from '@/services/api';

const POLL_INTERVAL_MS = 30_000;
const RANGE_HOURS = 24;

function platformUrl(platform: string, identifier: string): string {
  switch (platform) {
    case 'twitch':
      return `https://twitch.tv/${identifier}`;
    case 'kick':
      return `https://kick.com/${identifier}`;
    case 'youtube':
      return identifier.startsWith('UC')
        ? `https://youtube.com/channel/${identifier}`
        : `https://youtube.com/${identifier.startsWith('@') ? identifier : '@' + identifier}`;
    default:
      return '#';
  }
}

/**
 * /discover/:slug — read-only live view for one game tracker.
 *
 * Phase 1: leaderboard + 24-hour timeseries. Per-cycle refresh every
 * 30 s. Phase 3 will add the drag-to-select trends, breakdowns,
 * publisher-friendly layout, etc.
 */
export function DiscoverDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [detail, setDetail] = useState<GameTrackerDetail | null>(null);
  const [leaderboard, setLeaderboard] = useState<GameTrackerLeaderboardRow[]>([]);
  const [buckets, setBuckets] = useState<GameTrackerRangeBucket[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const [d, lb, range] = await Promise.all([
          api.getGameTracker(slug),
          api.getGameTrackerLeaderboard(slug, undefined, 50),
          api.getGameTrackerRange(
            slug,
            new Date(Date.now() - RANGE_HOURS * 60 * 60_000),
            new Date(),
            300, // 5-min buckets
          ),
        ]);
        if (cancelled) return;
        setDetail(d);
        setLeaderboard(lb);
        setBuckets(range.buckets);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };

    refresh();
    const handle = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [slug]);

  const totalCcvNow = useMemo(
    () => leaderboard.reduce((sum, row) => sum + row.concurrent_viewers, 0),
    [leaderboard],
  );

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <Link to="/discover" style={{ color: 'var(--fg-muted)' }}>
          ← back to Discover
        </Link>
        <div className="placeholder" style={{ marginTop: 20, color: 'var(--red)' }}>
          {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-muted)' }}>
        <Link to="/discover" style={{ color: 'var(--fg-muted)' }}>
          ← back to Discover
        </Link>
        <div style={{ marginTop: 20 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 24px', maxWidth: 1200, margin: '0 auto' }}>
      <Link to="/discover" style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        ← back to Discover
      </Link>

      <div style={{ marginTop: 12, marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
          {detail.name}
        </h1>
        <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontSize: 13 }}>
          {detail.twitch_game_name && <>Twitch: {detail.twitch_game_name}</>}
          {detail.twitch_game_name && detail.kick_category_slug && ' · '}
          {detail.kick_category_slug && <>Kick: {detail.kick_category_slug}</>}
          {' · '}
          {detail.active_channel_count} active channel{detail.active_channel_count === 1 ? '' : 's'}
        </p>
      </div>

      {/* Top metrics row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
          marginBottom: 24,
        }}
      >
        <MetricCard label="Total CCV (now)" value={totalCcvNow.toLocaleString()} />
        <MetricCard label="Live streams" value={leaderboard.length.toString()} />
        <MetricCard
          label="Last cycle"
          value={
            detail.last_cycle
              ? `${detail.last_cycle.snapshotsWritten} snapshots / ${detail.last_cycle.durationMs}ms`
              : '—'
          }
        />
      </div>

      {/* 24h timeseries */}
      <div className="card" style={{ padding: 16, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            Last 24 hours
          </h3>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>5-min buckets</span>
        </div>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={buckets} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid stroke="var(--border-faint)" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                tickFormatter={(v: string) =>
                  new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
                stroke="var(--fg-dim)"
                fontSize={11}
              />
              <YAxis stroke="var(--fg-dim)" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={(v: string) => new Date(v).toLocaleString()}
                formatter={(value: number, name: string) => [value.toLocaleString(), name]}
              />
              <Line
                type="monotone"
                dataKey="total_ccv"
                name="Total CCV"
                stroke="var(--red)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Leaderboard */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            Top streams now
          </h3>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <th style={th}>#</th>
              <th style={th}>Channel</th>
              <th style={th}>Platform</th>
              <th style={{ ...th, textAlign: 'right' }}>CCV</th>
              <th style={th}>Title</th>
              <th style={th}>Lang</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{ padding: 32, textAlign: 'center', color: 'var(--fg-muted)' }}
                >
                  No active streams right now
                </td>
              </tr>
            )}
            {leaderboard.map((row, i) => (
              <tr key={row.channel_id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
                <td style={{ ...td, color: 'var(--fg-dim)' }}>{i + 1}</td>
                <td style={td}>
                  {row.channel ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar
                        src={
                          (row.channel.metadata?.profile_image_url as string | undefined) ?? null
                        }
                        name={row.channel.display_name}
                      />
                      <a
                        href={platformUrl(row.platform, row.channel.channel_identifier)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--fg)', fontWeight: 500 }}
                      >
                        {row.channel.display_name}
                      </a>
                    </div>
                  ) : (
                    <span style={{ color: 'var(--fg-muted)' }}>{row.channel_id.slice(0, 8)}</span>
                  )}
                </td>
                <td style={{ ...td, color: 'var(--fg-muted)' }}>{row.platform}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {row.concurrent_viewers.toLocaleString()}
                </td>
                <td
                  style={{
                    ...td,
                    color: 'var(--fg-muted)',
                    maxWidth: 280,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={row.stream_title ?? ''}
                >
                  {row.stream_title ?? '—'}
                </td>
                <td style={{ ...td, color: 'var(--fg-dim)' }}>{row.language ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const td: React.CSSProperties = {
  padding: '10px 12px',
};

function Avatar({ src, name }: { src: string | null; name: string }) {
  const initials = name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        width={28}
        height={28}
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'var(--bg-sunken)',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: 'var(--bg-sunken)',
        color: 'var(--fg-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
        flexShrink: 0,
      }}
    >
      {initials || '?'}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--fg)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  );
}
