import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTrackerDetail, GameTrackerLeaderboardRow } from '@/services/api';
import { DiscoverSearch } from './DiscoverSearch';
import {
  Row,
  Col,
  Section,
  Kpi,
  Pill,
  Tab,
  PlatformPip,
  ChannelNameWithLink,
  ThemeToggle,
  IconBolt,
  IconUsers,
  IconEye,
  IconTrophy,
  IconList,
  IconGrid,
  IconChev,
} from '@/components/design';
import { fmtN, fmtCompact } from '@/design/format';
import { DiscoverTrendsTab } from './DiscoverTrendsTab';
import { DiscoverChannelsTab } from './DiscoverChannelsTab';

const POLL_INTERVAL_MS = 30_000;
type TabKey = 'live' | 'trends' | 'channels';

/**
 * /discover/:slug — live game tracker page.
 *
 * Mirrors the published-report aesthetic (HeroKPIs + Section cards),
 * uses the design kit primitives end-to-end so dark/light parity holds
 * and surface tokens stay consistent with the rest of the redesign.
 */
export function DiscoverDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as TabKey | null) ?? 'live';

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
          api.getGameTrackerLeaderboard(slug, undefined, 25),
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

  const setTab = (next: TabKey) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'live') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <BackLink />
        <Section style={{ marginTop: 20, color: 'var(--red)' }}>{error}</Section>
      </div>
    );
  }
  if (!detail || !slug) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-muted)' }}>
        <BackLink />
        <div style={{ marginTop: 20 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 24px 64px', maxWidth: 1320, margin: '0 auto' }}>
      <Row justify="space-between" align="center" gap={16}>
        <BackLink />
        <Row gap={10} align="center" style={{ flex: 1, justifyContent: 'flex-end' }}>
          <DiscoverSearch slug={slug ?? ''} />
          <ThemeToggle />
        </Row>
      </Row>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <Row justify="space-between" align="flex-end" wrap style={{ marginTop: 14, marginBottom: 24, gap: 16 }}>
        <Col gap={10}>
          <Row gap={10} align="center">
            <h1
              style={{
                fontFamily: 'var(--font-display, var(--font-sans))',
                fontSize: 44,
                fontWeight: 700,
                color: 'var(--fg)',
                margin: 0,
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              {detail.name}
            </h1>
            <Pill tone={detail.status === 'active' ? 'live' : 'default'}>
              {detail.status === 'active' ? '● Live' : detail.status}
            </Pill>
          </Row>
          <Row gap={14} wrap style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {detail.twitch_game_name && (
              <Row gap={6} align="center">
                <PlatformPip id="twitch" size={12} />
                <span>{detail.twitch_game_name}</span>
              </Row>
            )}
            {detail.kick_category_slug && (
              <Row gap={6} align="center">
                <PlatformPip id="kick" size={12} />
                <span>{detail.kick_category_slug}</span>
              </Row>
            )}
            <span>
              <span style={{ color: 'var(--fg-dim)' }}>min CCV</span>{' '}
              <span style={{ color: 'var(--fg)' }}>{detail.min_ccv_threshold}</span>
            </span>
            <span>
              <span style={{ color: 'var(--fg-dim)' }}>poll every</span>{' '}
              <span style={{ color: 'var(--fg)' }}>{detail.polling_interval_seconds}s</span>
            </span>
          </Row>
        </Col>
      </Row>

      {/* ── Tab bar ───────────────────────────────────────────────────── */}
      <Row
        gap={4}
        style={{
          marginBottom: 24,
          paddingBottom: 0,
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: 0,
          background: 'var(--bg)',
          zIndex: 4,
        }}
      >
        <Tab active={tab === 'live'} onClick={() => setTab('live')} icon={<IconBolt size={13} />}>
          Live
        </Tab>
        <Tab active={tab === 'trends'} onClick={() => setTab('trends')} icon={<IconGrid size={13} />}>
          Trends
        </Tab>
        <Tab active={tab === 'channels'} onClick={() => setTab('channels')} icon={<IconList size={13} />}>
          Channels
        </Tab>
      </Row>

      {/* ── Tab content ──────────────────────────────────────────────── */}
      {tab === 'live' && (
        <LiveTab
          slug={slug}
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

function BackLink() {
  return (
    <Link
      to="/discover"
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
      back to Discover
    </Link>
  );
}

// ── Live tab ─────────────────────────────────────────────────────────

function LiveTab({
  slug,
  totalCcvNow,
  peakNow,
  activeChannelCount,
  platformCount,
  leaderboard,
  lastCycle,
}: {
  slug: string;
  totalCcvNow: number;
  peakNow: number;
  activeChannelCount: number;
  platformCount: number;
  leaderboard: GameTrackerLeaderboardRow[] | null;
  lastCycle: GameTrackerDetail['last_cycle'];
}) {
  return (
    <Col gap={16}>
      {/* Hero KPI strip */}
      <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <KpiCard
          icon={<IconUsers size={14} />}
          label="Total CCV (now)"
          value={fmtN(totalCcvNow)}
        />
        <KpiCard
          icon={<IconTrophy size={14} />}
          label="Top stream"
          value={fmtN(peakNow)}
          sub={leaderboard?.[0]?.channel?.display_name ?? null}
        />
        <KpiCard
          icon={<IconEye size={14} />}
          label="Live streams"
          value={fmtN(activeChannelCount)}
        />
        <KpiCard
          icon={<IconGrid size={14} />}
          label="Platforms"
          value={String(platformCount)}
        />
      </Row>

      {/* Top streams */}
      <Section title="Top streams now" eyebrow="LIVE LEADERBOARD">
        <LeaderboardTable rows={leaderboard} trackerSlug={slug} />
      </Section>

      {/* Footer cycle status */}
      {lastCycle && (
        <Row justify="flex-end" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          last cycle: {lastCycle.snapshotsWritten} snapshots in {lastCycle.durationMs}ms
          {lastCycle.bumpedMismatch > 0 && ` · ${lastCycle.bumpedMismatch} bumped`}
          {lastCycle.dropped > 0 && ` · ${lastCycle.dropped} dropped`}
        </Row>
      )}
    </Col>
  );
}

// ── Shared ───────────────────────────────────────────────────────────

/**
 * KpiCard — Section-styled wrapper around the design-kit Kpi with a
 * red accent bar at the top and an optional icon next to the eyebrow,
 * so it reads like a published-report KPI tile.
 */
function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{
        padding: '24px 24px',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: 'var(--red)',
        }}
      />
      <Kpi
        size="lg"
        label={
          <Row gap={5} align="center" style={{ color: 'var(--fg-muted)' }}>
            {icon}
            {label}
          </Row>
        }
        value={<span style={{ fontWeight: 600 }}>{value}</span>}
        sub={
          sub ? (
            <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{sub}</span>
          ) : undefined
        }
      />
    </div>
  );
}

export function LeaderboardTable({
  rows,
  trackerSlug,
}: {
  rows: GameTrackerLeaderboardRow[] | null;
  trackerSlug: string;
}) {
  const navigate = useNavigate();
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ ...thStyle, width: 36 }}>#</th>
          <th style={{ ...thStyle, width: 56 }}></th>
          <th style={thStyle}>Channel</th>
          <th style={{ ...thStyle, width: 60 }}>Lang</th>
          <th style={{ ...thStyle, textAlign: 'right', width: 110 }}>Live CCV</th>
        </tr>
      </thead>
      <tbody>
        {rows === null && (
          <tr>
            <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
              Loading…
            </td>
          </tr>
        )}
        {rows && rows.length === 0 && (
          <tr>
            <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--fg-muted)' }}>
              No active streams right now
            </td>
          </tr>
        )}
        {(rows ?? []).map((row, i) => {
          const profilePic = row.channel?.metadata?.profile_image_url as string | undefined;
          const onRowClick = () => navigate(`/discover/${trackerSlug}/channel/${row.channel_id}`);
          return (
            <tr
              key={row.channel_id}
              onClick={onRowClick}
              style={{
                borderBottom: '1px solid var(--border-faint)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-sunken)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <td style={{ ...tdStyle, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>
                {i + 1}
              </td>
              <td style={tdStyle}>
                <PlatformPip id={row.platform} size={12} />
              </td>
              <td style={tdStyle}>
                {row.channel ? (
                  <Row gap={10} align="center">
                    <Avatar src={profilePic ?? null} name={row.channel.display_name} size={32} />
                    <Col gap={2} style={{ minWidth: 0, flex: 1 }}>
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{ display: 'inline-flex' }}
                      >
                        <ChannelNameWithLink
                          name={row.channel.display_name}
                          platform={row.platform}
                          channelIdentifier={row.channel.channel_identifier}
                        />
                      </div>
                      <div
                        title={row.stream_title ?? ''}
                        style={{
                          fontSize: 11,
                          color: 'var(--fg-dim)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: 480,
                        }}
                      >
                        {row.stream_title ?? '—'}
                      </div>
                    </Col>
                  </Row>
                ) : (
                  <span style={{ color: 'var(--fg-muted)' }}>{row.channel_id.slice(0, 8)}</span>
                )}
              </td>
              <td style={{ ...tdStyle, color: 'var(--fg-dim)' }}>
                {row.language?.toUpperCase() ?? '—'}
              </td>
              <td
                style={{
                  ...tdStyle,
                  textAlign: 'right',
                  fontFamily: 'var(--font-mono)',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                  color: 'var(--fg)',
                }}
              >
                {fmtCompact(row.concurrent_viewers)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Avatar({
  src,
  name,
  size = 28,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
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
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
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
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--bg-sunken)',
        color: 'var(--fg-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(9, Math.round(size * 0.36)),
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials || '?'}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 6px',
  textAlign: 'left',
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const tdStyle: React.CSSProperties = {
  padding: '12px 6px',
};
