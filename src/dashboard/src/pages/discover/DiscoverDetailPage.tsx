import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTrackerDetail, GameTrackerLeaderboardRow } from '@/services/api';
import { DiscoverTrendsTab } from './DiscoverTrendsTab';
import { DiscoverChannelsTab } from './DiscoverChannelsTab';

const POLL_INTERVAL_MS = 30_000;
type Tab = 'live' | 'trends' | 'channels';

/**
 * /discover/:slug — live game tracker page.
 *
 * Three tabs: Live (default; KPIs + top streams now), Trends
 * (drag-to-select timeline + breakdowns), Channels (full list with
 * platform filter).
 *
 * Aesthetic mirrors the exported HTML reports: large mono numerals on
 * report-style KPI cards with a red accent bar, generous padding,
 * theme-token colors throughout for full dark/light parity.
 */
export function DiscoverDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as Tab | null) ?? 'live';

  const [detail, setDetail] = useState<GameTrackerDetail | null>(null);
  const [leaderboard, setLeaderboard] = useState<GameTrackerLeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [d, lb] = await Promise.all([
          api.getGameTracker(slug),
          api.getGameTrackerLeaderboard(slug, undefined, 20),
        ]);
        if (cancelled) return;
        setDetail(d);
        setLeaderboard(lb);
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
    () => (leaderboard ?? []).reduce((sum, row) => sum + row.concurrent_viewers, 0),
    [leaderboard],
  );

  const peakNow = useMemo(
    () => (leaderboard ?? []).reduce((max, row) => Math.max(max, row.concurrent_viewers), 0),
    [leaderboard],
  );

  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const r of leaderboard ?? []) set.add(r.platform);
    return Array.from(set).sort();
  }, [leaderboard]);

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'live') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

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

  if (!detail || !slug) {
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
    <div style={{ padding: '32px 24px 64px', maxWidth: 1280, margin: '0 auto' }}>
      <Link to="/discover" style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        ← back to Discover
      </Link>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 14, marginBottom: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: 'var(--fg)',
                margin: 0,
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              {detail.name}
            </h1>
            <div style={{ display: 'flex', gap: 12, marginTop: 10, fontSize: 12, color: 'var(--fg-muted)' }}>
              {detail.twitch_game_name && (
                <span>
                  <span style={{ color: 'var(--fg-dim)' }}>Twitch:</span> {detail.twitch_game_name}
                </span>
              )}
              {detail.kick_category_slug && (
                <span>
                  <span style={{ color: 'var(--fg-dim)' }}>Kick:</span> {detail.kick_category_slug}
                </span>
              )}
              <span>
                <span style={{ color: 'var(--fg-dim)' }}>Min CCV:</span> {detail.min_ccv_threshold}
              </span>
            </div>
          </div>
          <span
            style={{
              fontSize: 11,
              padding: '4px 12px',
              borderRadius: 999,
              background:
                detail.status === 'active'
                  ? 'color-mix(in oklab, #10b981 18%, transparent)'
                  : 'color-mix(in oklab, var(--fg-dim) 20%, transparent)',
              color: detail.status === 'active' ? '#10b981' : 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 600,
            }}
          >
            {detail.status === 'active' ? '● Live' : detail.status}
          </span>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--border)',
          marginBottom: 24,
          position: 'sticky',
          top: 0,
          background: 'var(--bg)',
          zIndex: 4,
        }}
      >
        {(['live', 'trends', 'channels'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '12px 20px',
              border: 'none',
              background: 'transparent',
              color: tab === t ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: tab === t ? 600 : 500,
              fontSize: 13,
              borderBottom: tab === t ? '2px solid var(--red)' : '2px solid transparent',
              marginBottom: -1,
              textTransform: 'capitalize',
              cursor: 'pointer',
              letterSpacing: '0.02em',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Tab content ─────────────────────────────────────────────── */}
      {tab === 'live' && (
        <LiveTab
          totalCcvNow={totalCcvNow}
          peakNow={peakNow}
          activeChannelCount={detail.active_channel_count}
          platformCount={platforms.length}
          leaderboard={leaderboard}
          lastCycle={detail.last_cycle}
        />
      )}
      {tab === 'trends' && <DiscoverTrendsTab slug={slug} />}
      {tab === 'channels' && <DiscoverChannelsTab slug={slug} />}
    </div>
  );
}

// ── Live tab ──────────────────────────────────────────────────────────

function LiveTab({
  totalCcvNow,
  peakNow,
  activeChannelCount,
  platformCount,
  leaderboard,
  lastCycle,
}: {
  totalCcvNow: number;
  peakNow: number;
  activeChannelCount: number;
  platformCount: number;
  leaderboard: GameTrackerLeaderboardRow[] | null;
  lastCycle: GameTrackerDetail['last_cycle'];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
        }}
      >
        <ReportKpi label="Total CCV (now)" value={totalCcvNow.toLocaleString()} />
        <ReportKpi label="Top stream" value={peakNow.toLocaleString()} />
        <ReportKpi label="Live streams" value={activeChannelCount.toLocaleString()} />
        <ReportKpi label="Platforms" value={platformCount.toString()} />
      </div>

      {/* Top streams */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            Top streams now
          </h3>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <th style={{ ...th, width: 36 }}>#</th>
              <th style={{ ...th, width: 80 }}>Platform</th>
              <th style={th}>Channel</th>
              <th style={{ ...th, width: 60 }}>Lang</th>
              <th style={{ ...th, textAlign: 'right', width: 110 }}>Live CCV</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard === null && (
              <tr>
                <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
                  Loading…
                </td>
              </tr>
            )}
            {leaderboard && leaderboard.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--fg-muted)' }}>
                  No active streams right now
                </td>
              </tr>
            )}
            {(leaderboard ?? []).map((row, i) => {
              const profilePic = row.channel?.metadata?.profile_image_url as string | undefined;
              return (
                <tr key={row.channel_id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
                  <td style={{ ...td, color: 'var(--fg-dim)' }}>{i + 1}</td>
                  <td style={{ ...td, color: 'var(--fg-muted)', textTransform: 'capitalize' }}>
                    {row.platform}
                  </td>
                  <td style={td}>
                    {row.channel ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar src={profilePic ?? null} name={row.channel.display_name} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <a
                            href={platformUrl(row.platform, row.channel.channel_identifier)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--fg)', fontWeight: 500, display: 'block' }}
                          >
                            {row.channel.display_name}
                          </a>
                          <div
                            title={row.stream_title ?? ''}
                            style={{
                              fontSize: 11,
                              color: 'var(--fg-dim)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 460,
                            }}
                          >
                            {row.stream_title ?? '—'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--fg-muted)' }}>{row.channel_id.slice(0, 8)}</span>
                    )}
                  </td>
                  <td style={{ ...td, color: 'var(--fg-dim)' }}>{row.language ?? '—'}</td>
                  <td
                    style={{
                      ...td,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: 600,
                      fontFamily: 'var(--font-mono, monospace)',
                    }}
                  >
                    {row.concurrent_viewers.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer cycle status */}
      {lastCycle && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', textAlign: 'right' }}>
          last cycle: {lastCycle.snapshotsWritten} snapshots in {lastCycle.durationMs}ms
          {lastCycle.bumpedMismatch > 0 && ` · ${lastCycle.bumpedMismatch} bumped`}
          {lastCycle.dropped > 0 && ` · ${lastCycle.dropped} dropped`}
        </div>
      )}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────

function ReportKpi({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="card"
      style={{
        padding: '22px 24px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: 'var(--red)',
        }}
      />
      <div
        style={{
          fontSize: 10,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 32,
          fontWeight: 700,
          color: 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function platformUrl(platform: string, identifier: string): string {
  switch (platform) {
    case 'twitch':
      return `https://twitch.tv/${identifier}`;
    case 'kick':
      return `https://kick.com/${identifier}`;
    default:
      return '#';
  }
}

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
        width={32}
        height={32}
        style={{
          width: 32,
          height: 32,
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
        width: 32,
        height: 32,
        borderRadius: '50%',
        background: 'var(--bg-sunken)',
        color: 'var(--fg-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials || '?'}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const td: React.CSSProperties = {
  padding: '12px 14px',
};
