import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import * as api from '@/services/api';
import type {
  GameTrackerDetail,
  GameTrackerLeaderboardRow,
  GameTrackerRecentChannelRow,
} from '@/services/api';
import { DiscoverSearch } from './DiscoverSearch';
import { DiscoverSearchResults } from './DiscoverSearchResults';
import {
  DiscoverAskResults,
  useDiscoverAsk,
} from '@/components/discover/DiscoverAskBox';
import { useAuth } from '@/hooks/useAuth';
import {
  Row,
  Col,
  Section,
  Kpi,
  Pill,
  Tab,
  PlatformPip,
  ChannelNameWithLink,
  RangePill,
  TableScroll,
  rowLinkProps,
  thStyle,
  tdStyle,
  IconBolt,
  IconUsers,
  IconEye,
  IconTrophy,
  IconList,
  IconGrid,
  IconChev,
  IconDownload,
} from '@/components/design';
import { fmtN, fmtCompact, fmtRelative } from '@/design/format';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { DiscoverTrendsTab } from './DiscoverTrendsTab';
import { DiscoverYouTubeGating } from './DiscoverYouTubeGating';
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
  const searchQuery = (searchParams.get('q') ?? '').trim();

  const [detail, setDetail] = useState<GameTrackerDetail | null>(null);
  const [leaderboard, setLeaderboard] = useState<GameTrackerLeaderboardRow[] | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Ask (natural-language) ─────────────────────────────────────────
  // The server compiles a question into ONE validated intent and answers
  // straight from Postgres (answer/refusal only — no URL patches here).
  const getAskViewState = useCallback(
    (): api.DiscoverAskViewState => ({
      tab: searchParams.get('tab') ?? undefined,
      platform: searchParams.get('platform') ?? undefined,
      language: searchParams.get('language') ?? undefined,
    }),
    [searchParams],
  );
  const ask = useDiscoverAsk({ slug: slug ?? '', getViewState: getAskViewState });
  const isAdmin = useAuth().user?.role === 'admin';

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
        setLastUpdatedAt(Date.now());
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
  // Top language by summed live CCV — a KPI that actually changes, unlike
  // the "Platforms: 2" tile it replaces.
  const topLanguage = useMemo(() => {
    const byLang = new Map<string, number>();
    let total = 0;
    for (const r of leaderboard ?? []) {
      const lang = r.language?.toUpperCase() ?? '—';
      byLang.set(lang, (byLang.get(lang) ?? 0) + r.concurrent_viewers);
      total += r.concurrent_viewers;
    }
    let best: { lang: string; ccv: number } | null = null;
    for (const [lang, ccv] of byLang) {
      if (lang !== '—' && (!best || ccv > best.ccv)) best = { lang, ccv };
    }
    if (!best || total === 0) return null;
    return { lang: best.lang, sharePct: Math.round((best.ccv / total) * 100) };
  }, [leaderboard]);

  // A search takeover replaces the body — clear any lingering Ask card so
  // the two result surfaces never stack.
  useEffect(() => {
    if (searchQuery) ask.dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

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
        <Section style={{ marginTop: 20, color: 'var(--danger)' }}>{error}</Section>
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
      <BackLink />

      {/* ── Hero — the page leads with WHAT this is; tools sit beside it
             and wrap below on narrow screens ─────────────────────────── */}
      <Row justify="space-between" align="flex-end" wrap style={{ marginTop: 14, marginBottom: 24, gap: 16 }}>
        <Col gap={10} style={{ minWidth: 0 }}>
          <Row gap={10} align="center" wrap>
            <h1
              style={{
                fontFamily: 'var(--font-display, var(--font-sans))',
                fontSize: 'clamp(28px, 6vw, 44px)',
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
              {detail.status === 'active'
                ? '● Live'
                : detail.status.charAt(0).toUpperCase() + detail.status.slice(1)}
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
            {/* YouTube has no category id to show — membership is decided by
                our own gating rules, so name that instead of faking one. */}
            {detail.youtube_enabled && (
              <Row gap={6} align="center">
                <PlatformPip id="youtube" size={12} />
                <span title="YouTube streams are matched by title rules and reviewed per channel">
                  reviewed channels
                </span>
              </Row>
            )}
            {/* Polling config is operator detail — admins only */}
            {isAdmin && (
              <span>
                <span style={{ color: 'var(--fg-dim)' }}>min CCV</span>{' '}
                <span style={{ color: 'var(--fg)' }}>{detail.min_ccv_threshold}</span>
                <span style={{ color: 'var(--fg-dim)' }}> · poll every </span>
                <span style={{ color: 'var(--fg)' }}>{detail.polling_interval_seconds}s</span>
              </span>
            )}
          </Row>
        </Col>
        <div style={{ flex: '1 1 320px', maxWidth: 520, minWidth: 240 }}>
          <DiscoverSearch slug={slug ?? ''} ask={ask} />
        </div>
      </Row>

      {/* Ask results — answer card / refusal, between the hero and the
          tab bar (renders nothing when idle) */}
      <DiscoverAskResults ask={ask} />

      {/* When ?q is set, search results take over the body and the tab
          bar is hidden — the operator's intent is "find this thing,"
          not "browse Live/Trends/Channels". Clearing the search returns
          to the previous tab. */}
      {searchQuery ? (
        <DiscoverSearchResults slug={slug} query={searchQuery} />
      ) : (
        <>
          {/* ── Tab bar ─────────────────────────────────────────────── */}
          <Row
            gap={4}
            style={{
              marginBottom: 24,
              paddingBottom: 0,
              borderBottom: '1px solid var(--border)',
              position: 'sticky',
              top: 'var(--topnav-h)',
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

          {/* ── Tab content ──────────────────────────────────────────── */}
          {tab === 'live' && (
            <LiveTab
              slug={slug}
              totalCcvNow={totalCcvNow}
              peakNow={peakNow}
              activeChannelCount={detail.active_channel_count}
              topLanguage={topLanguage}
              leaderboard={leaderboard}
              lastCycle={detail.last_cycle}
              lastUpdatedAt={lastUpdatedAt}
              isAdmin={isAdmin}
              onViewAll={() => setTab('channels')}
            />
          )}
          {tab === 'trends' && <DiscoverTrendsTab slug={slug} />}
          {tab === 'channels' && (
            <Col gap={16}>
              {isAdmin && detail.youtube_enabled && <DiscoverYouTubeGating slug={slug} />}
              <DiscoverChannelsTab slug={slug} />
            </Col>
          )}
        </>
      )}
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
  topLanguage,
  leaderboard,
  lastCycle,
  lastUpdatedAt,
  isAdmin,
  onViewAll,
}: {
  slug: string;
  totalCcvNow: number;
  peakNow: number;
  activeChannelCount: number;
  topLanguage: { lang: string; sharePct: number } | null;
  leaderboard: GameTrackerLeaderboardRow[] | null;
  lastCycle: GameTrackerDetail['last_cycle'];
  lastUpdatedAt: number | null;
  isAdmin: boolean;
  onViewAll: () => void;
}) {
  // Which platforms actually appear in this tracker's live set — the filter
  // only offers what exists, so an empty "YouTube" tab can't confuse anyone.
  const platformsPresent = useMemo(() => {
    const set = new Set<string>();
    for (const r of leaderboard ?? []) set.add(r.platform);
    return [...set].sort();
  }, [leaderboard]);
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const shown = useMemo(
    () =>
      leaderboard == null
        ? null
        : platformFilter === 'all'
          ? leaderboard
          : leaderboard.filter((r) => r.platform === platformFilter),
    [leaderboard, platformFilter],
  );

  const exportCsv = () => {
    if (!leaderboard || leaderboard.length === 0) return;
    downloadCsv(
      `${slug}-live-${csvStamp()}.csv`,
      ['rank', 'channel', 'platform', 'language', 'ccv', 'stream_title'],
      leaderboard.map((row, i) => [
        i + 1,
        row.channel?.display_name ?? row.channel_id,
        row.platform,
        row.language,
        row.concurrent_viewers,
        row.stream_title,
      ]),
    );
  };
  return (
    <Col gap={16}>
      {/* Hero KPI strip */}
      <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <KpiCard
          icon={<IconUsers size={14} />}
          label="Viewers now"
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
          label="Top language"
          value={topLanguage?.lang ?? '—'}
          sub={topLanguage ? `${topLanguage.sharePct}% of viewers` : null}
        />
      </Row>

      {/* Recently discovered channels (48h) — hidden when empty */}
      <RecentlyDiscoveredStrip slug={slug} />

      {/* Top streams */}
      <Section
        title="Top streams now"
        eyebrow="LIVE LEADERBOARD"
        right={
          <Row gap={10} align="center" wrap>
            {platformsPresent.length > 1 && (
              <Row gap={4} align="center">
                {(['all', ...platformsPresent] as string[]).map((p) => (
                  <RangePill
                    key={p}
                    active={platformFilter === p}
                    onClick={() => setPlatformFilter(p)}
                  >
                    {p}
                  </RangePill>
                ))}
              </Row>
            )}
            <FreshnessIndicator at={lastUpdatedAt} />
            <button
              type="button"
              className="btn btn-xs"
              onClick={exportCsv}
              disabled={!leaderboard || leaderboard.length === 0}
              style={{ cursor: 'pointer' }}
            >
              <IconDownload size={11} /> CSV
            </button>
          </Row>
        }
      >
        <LeaderboardTable rows={shown} trackerSlug={slug} />
        {activeChannelCount > (leaderboard?.length ?? 0) && (
          <button
            type="button"
            onClick={onViewAll}
            style={{
              alignSelf: 'flex-start',
              padding: '6px 0',
              border: 'none',
              background: 'transparent',
              color: 'var(--red)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            View all {fmtN(activeChannelCount)} live channels →
          </button>
        )}
      </Section>

      {/* Scheduler telemetry is operator detail — admins only */}
      {isAdmin && lastCycle && (
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

export type LeaderboardRow = GameTrackerLeaderboardRow & {
  minutes_live?: number;
  days_streamed?: number;
  /** Range mode only — carried through for CSV export. */
  avg_ccv?: number;
};

/**
 * "updated Xs ago" freshness readout for polled sections. Re-renders on
 * a slow internal tick so the age stays current between polls.
 */
export function FreshnessIndicator({ at }: { at: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(handle);
  }, []);
  if (at === null) return null;
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  const label = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  return (
    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>
      updated {label} ago
    </span>
  );
}

/**
 * Compact wrap of chips for channels the tracker discovered in the last
 * 48h — each links to the channel detail page. Renders nothing while
 * loading or when the window is empty.
 */
function RecentlyDiscoveredStrip({ slug }: { slug: string }) {
  const [rows, setRows] = useState<GameTrackerRecentChannelRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .getGameTrackerRecentChannels(slug, 48, 12)
      .then((res) => {
        if (!cancelled) setRows(res.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (rows.length === 0) return null;

  return (
    <Section eyebrow="Recently discovered (48h)" compact>
      <Row gap={8} wrap>
        {rows.map((r) => (
          <Link
            key={r.channel_id}
            to={`/discover/${slug}/channel/${r.channel_id}`}
            aria-label={`${r.display_name} — discovered ${fmtRelative(r.joined_at)}, peak ${fmtCompact(r.peak)}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: 'var(--bg-sunken)',
              fontSize: 11.5,
              textDecoration: 'none',
              color: 'inherit',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-sunken)';
            }}
          >
            <PlatformPip id={r.platform} size={11} />
            <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{r.display_name}</span>
            <span style={{ color: 'var(--fg-dim)' }}>·</span>
            <span
              className="mono"
              style={{ color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}
            >
              peak {fmtCompact(r.peak)}
            </span>
            <span style={{ color: 'var(--fg-dim)' }}>·</span>
            <span style={{ color: 'var(--fg-dim)' }}>{fmtRelative(r.joined_at)}</span>
          </Link>
        ))}
      </Row>
    </Section>
  );
}

export function LeaderboardTable({
  rows,
  trackerSlug,
  metricLabel = 'Live CCV',
  showRangeStats = false,
}: {
  rows: LeaderboardRow[] | null;
  trackerSlug: string;
  /** Header label for the CCV column — "Live CCV" (now) or "Peak CCV" (range). */
  metricLabel?: string;
  /** Show Days streamed + Hours columns (range mode). */
  showRangeStats?: boolean;
}) {
  const navigate = useNavigate();
  const colCount = showRangeStats ? 7 : 5;
  return (
    <TableScroll>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: showRangeStats ? 640 : 480 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ ...thStyle, width: 36 }}>#</th>
          <th style={{ ...thStyle, width: 56 }}></th>
          <th style={thStyle}>Channel</th>
          <th style={{ ...thStyle, width: 60 }}>Lang</th>
          {showRangeStats && <th style={{ ...thStyle, textAlign: 'right', width: 70 }}>Days</th>}
          {showRangeStats && <th style={{ ...thStyle, textAlign: 'right', width: 90 }}>Hours</th>}
          <th style={{ ...thStyle, textAlign: 'right', width: 110 }}>{metricLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows === null && (
          <tr>
            <td colSpan={colCount} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
              Loading…
            </td>
          </tr>
        )}
        {rows && rows.length === 0 && (
          <tr>
            <td colSpan={colCount} style={{ padding: 32, textAlign: 'center', color: 'var(--fg-muted)' }}>
              {showRangeStats ? 'No streams in this range' : 'No active streams right now'}
            </td>
          </tr>
        )}
        {(rows ?? []).map((row, i) => {
          const profilePic = row.channel?.metadata?.profile_image_url as string | undefined;
          const channelTo = `/discover/${trackerSlug}/channel/${row.channel_id}`;
          const onRowClick = () => navigate(channelTo);
          return (
            <tr
              key={row.channel_id}
              onClick={onRowClick}
              {...rowLinkProps(`Open ${row.channel?.display_name ?? 'channel'} details`, onRowClick)}
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
                      <ChannelNameWithLink
                        name={row.channel.display_name}
                        platform={row.platform}
                        channelIdentifier={row.channel.channel_identifier}
                        to={channelTo}
                      />
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
              {showRangeStats && (
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--fg-muted)',
                  }}
                >
                  {row.days_streamed ?? '—'}
                </td>
              )}
              {showRangeStats && (
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--fg-muted)',
                  }}
                >
                  {row.minutes_live != null ? `${(row.minutes_live / 60).toFixed(1)}h` : '—'}
                </td>
              )}
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
    </TableScroll>
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
  // A broken/blocked profile image degrades to initials instead of a
  // blank dark circle (the Trends tab shipped rows of black dots).
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const fallback = (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'color-mix(in oklab, var(--info) 14%, var(--bg-sunken))',
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
  if (!src || broken) return fallback;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      onError={() => setBroken(true)}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'color-mix(in oklab, var(--info) 10%, var(--bg-sunken))',
        objectFit: 'cover',
        flexShrink: 0,
      }}
    />
  );
}
