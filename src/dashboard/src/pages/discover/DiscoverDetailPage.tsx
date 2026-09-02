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
import { useViewportBelow } from '@/hooks/useViewport';
import {
  Row,
  Col,
  Section,
  Kpi,
  Pill,
  Tab,
  PlatformPip,
  ChannelNameWithLink,
  TableScroll,
  rowLinkProps,
  thStyle,
  tdStyle,
  stickyThStyle,
  IconBolt,
  IconList,
  IconGrid,
  IconCheck,
  IconChevDown,
  IconDownload,
  IconShare,
  LoadingBlock,
  DeltaChip,
  GradeBadge,
  StatBlock,
  Breadcrumbs,
  SegmentedControl,
  BackToTop,
} from '@/components/design';
import { fmtN, fmtCompact, fmtRelative } from '@/design/format';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { DiscoverTrendsTab } from './DiscoverTrendsTab';
import { DiscoverYouTubeGating } from './DiscoverYouTubeGating';
import { GameArtTile } from '@/components/discover/GameArtTile';
import { DiscoverChannelsTab } from './DiscoverChannelsTab';

const POLL_INTERVAL_MS = 30_000;
type TabKey = 'live' | 'trends' | 'channels' | 'review';

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
  // Category mappings are operator detail — folded away until asked for.
  const [showCategories, setShowCategories] = useState(false);
  const [pendingReview, setPendingReview] = useState<number | null>(null);
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
  const { isAdmin, isEditor } = useAuth();

  // Platform filter lives at PAGE level so Live, Trends and Channels all
  // answer to one control (and one shareable ?platform= URL) instead of
  // each tab inventing its own.
  const platform = searchParams.get('platform') ?? 'all';
  const isPhone = useViewportBelow(700);
  const setPlatform = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'all') params.delete('platform');
    else params.set('platform', next);
    setSearchParams(params, { replace: true });
  };

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [d, lb] = await Promise.all([
          api.getGameTracker(slug),
          api.getGameTrackerLeaderboard(slug, undefined, 200),
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

  // Platforms this tracker is configured to cover — deterministic, so the
  // control doesn't flicker as small streams enter and leave the top 25.
  const trackedPlatforms = useMemo(() => {
    const out: string[] = [];
    if (detail?.twitch_game_id) out.push('twitch');
    if (detail?.kick_category_id) out.push('kick');
    if (detail?.youtube_enabled) out.push('youtube');
    if (detail?.soop_category_id) out.push('soop');
    if (detail?.tiktok_category_slug) out.push('tiktok');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.twitch_game_id, detail?.kick_category_id, detail?.youtube_enabled, detail?.soop_category_id, detail?.tiktok_category_slug]);

  // Review tab: editors see the YouTube queue as a tab of its own, with a
  // pending badge — no more hunting for it behind the YouTube filter.
  const canReview = isEditor && !!detail?.youtube_enabled;
  useEffect(() => {
    if (!slug || !canReview) return;
    let cancelled = false;
    const load = () =>
      api
        .getYouTubeGating(slug, 'pending', { limit: 1 })
        .then((r) => !cancelled && setPendingReview(r.counts.pending))
        .catch(() => {});
    load();
    const h = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [slug, canReview]);
  const effectiveTab: TabKey = tab === 'review' && !canReview ? 'live' : tab;

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
        <Breadcrumbs items={[{ label: 'Discover', to: '/discover' }, { label: slug ?? 'Tracker' }]} />
        <Section style={{ marginTop: 20, color: 'var(--danger)' }}>{error}</Section>
      </div>
    );
  }
  if (!detail || !slug) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-muted)' }}>
        <Breadcrumbs items={[{ label: 'Discover', to: '/discover' }, { label: slug ?? 'Tracker' }]} />
        <div style={{ marginTop: 20 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div className="discover-page" style={{ padding: '32px 24px 64px', maxWidth: 1320, margin: '0 auto' }}>
      <Breadcrumbs items={[{ label: 'Discover', to: '/discover' }, { label: detail.name }]} />

      {/* ── Hero: name + status, one meta line, and the category mappings
             folded away (operator detail). The platform filter lives in
             the tab bar below, next to the tabs it scopes. ─────────── */}
      <div className="discover-hero" style={{ marginTop: 14, marginBottom: 20 }}>
        <Row justify="space-between" align="flex-start" wrap gap={12}>
          <Col gap={8} style={{ minWidth: 0 }}>
            <Row gap={10} align="center" wrap>
              <GameArtTile name={detail.name} twitchGameId={detail.twitch_game_id} />
              <h1
                style={{
                  fontFamily: 'var(--font-display, var(--font-sans))',
                  fontSize: 'clamp(28px, 6vw, 34px)',
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
            <Row gap={8} align="center" wrap style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
              <span style={{ color: 'var(--live)' }}>●</span>
              <span className="tabular">{fmtN(detail.active_channel_count)} channels live</span>
              <span style={{ color: 'var(--fg-dim)' }}>·</span>
              <span>discovery every {detail.discovery_interval_seconds ?? 60}s</span>
              <span style={{ color: 'var(--fg-dim)' }}>·</span>
              <button
                type="button"
                onClick={() => setShowCategories((v) => !v)}
                aria-expanded={showCategories}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  font: 'inherit',
                  cursor: 'pointer',
                  textDecoration: 'underline dotted',
                  textUnderlineOffset: 3,
                }}
              >
                {trackedPlatforms.length} platform{trackedPlatforms.length === 1 ? '' : 's'}
                <span
                  style={{
                    display: 'inline-flex',
                    transform: showCategories ? 'rotate(180deg)' : 'none',
                    transition: 'transform 120ms',
                  }}
                >
                  <IconChevDown size={11} />
                </span>
              </button>
              {isAdmin && (
                <>
                  <span style={{ color: 'var(--fg-dim)' }}>·</span>
                  <span>
                    <span style={{ color: 'var(--fg-dim)' }}>min CCV</span>{' '}
                    <span style={{ color: 'var(--fg)' }}>{detail.min_ccv_threshold}</span>
                    <span style={{ color: 'var(--fg-dim)' }}> · poll every </span>
                    <span style={{ color: 'var(--fg)' }}>{detail.polling_interval_seconds}s</span>
                  </span>
                </>
              )}
            </Row>
            {showCategories && (
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
                {/* YouTube has no category id — membership is decided by our
                    own title rules, reviewed per channel. */}
                {detail.youtube_enabled && (
                  <Row gap={6} align="center">
                    <PlatformPip id="youtube" size={12} />
                    <span title="YouTube streams are matched by title rules and reviewed per channel">
                      title rules{canReview ? ' · reviewed in the Review tab' : ''}
                    </span>
                  </Row>
                )}
                {detail.soop_category_id && (
                  <Row gap={6} align="center">
                    <PlatformPip id="soop" size={12} />
                    <span>{detail.soop_category_name ?? detail.soop_category_id}</span>
                  </Row>
                )}
                {detail.tiktok_category_slug && (
                  <Row gap={6} align="center">
                    <PlatformPip id="tiktok" size={12} />
                    <span title="TikTok's category feed is region-personalized sampling. Best-effort coverage, not the full category">
                      {detail.tiktok_category_name ?? detail.tiktok_category_slug} · sampled
                    </span>
                  </Row>
                )}
              </Row>
            )}
          </Col>
          <ShareViewButton />
        </Row>
      </div>

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
            align="center"
            wrap
            className="discover-tabbar"
            style={{
              marginBottom: 24,
              padding: '4px 0 6px',
              borderBottom: '1px solid var(--border)',
              position: 'sticky',
              top: 'var(--topnav-h)',
              background: 'var(--bg)',
              zIndex: 4,
            }}
          >
            <Tab active={effectiveTab === 'live'} onClick={() => setTab('live')} icon={<IconBolt size={13} />}>
              Live
            </Tab>
            <Tab active={effectiveTab === 'trends'} onClick={() => setTab('trends')} icon={<IconGrid size={13} />}>
              Trends
            </Tab>
            <Tab active={effectiveTab === 'channels'} onClick={() => setTab('channels')} icon={<IconList size={13} />}>
              Channels
            </Tab>
            {canReview && (
              <Tab active={effectiveTab === 'review'} onClick={() => setTab('review')} icon={<IconCheck size={13} />}>
                Review
                {pendingReview != null && pendingReview > 0 && (
                  <span
                    className="tabular"
                    style={{
                      marginLeft: 2,
                      padding: '0 6px',
                      borderRadius: 999,
                      fontSize: 10.5,
                      fontWeight: 700,
                      background: 'color-mix(in oklab, var(--warn) 18%, transparent)',
                      color: 'var(--warn)',
                    }}
                  >
                    {pendingReview}
                  </span>
                )}
              </Tab>
            )}
            {/* Platform scope — one control for Live, Trends and Channels */}
            {trackedPlatforms.length > 1 && effectiveTab !== 'review' && (
              <div style={{ marginLeft: 10 }}>
                <SegmentedControl
                  ariaLabel="Platform"
                  size="sm"
                  value={platform}
                  onChange={setPlatform}
                  options={[
                    { value: 'all', label: 'All', title: 'All platforms' },
                    ...trackedPlatforms.map((p) => ({
                      value: p,
                      label: <span style={{ textTransform: 'capitalize' }}>{p}</span>,
                      icon: <PlatformPip id={p} size={12} />,
                      title: p,
                    })),
                  ]}
                />
              </div>
            )}
            <div className="discover-search" style={{ marginLeft: 'auto', flex: '0 1 400px', minWidth: 220 }}>
              <DiscoverSearch slug={slug ?? ''} ask={ask} />
            </div>
          </Row>

          {/* ── Tab content ──────────────────────────────────────────── */}
          {effectiveTab === 'live' && (
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
              platform={platform}
              onViewAll={() => setTab('channels')}
              onReview={canReview ? () => setTab('review') : undefined}
            />
          )}
          {effectiveTab === 'trends' && (
            <DiscoverTrendsTab slug={slug} platform={platform} retainRawDays={detail.retain_raw_days ?? null} />
          )}
          {effectiveTab === 'channels' && (
            <Col gap={16}>
              {canReview && (
                <DiscoverYouTubeGating slug={slug} expanded={false} onExpand={() => setTab('review')} />
              )}
              <DiscoverChannelsTab
                slug={slug}
                platform={platform}
                onPlatformChange={setPlatform}
                retainRawDays={detail.retain_raw_days ?? null}
              />
            </Col>
          )}
          {effectiveTab === 'review' && canReview && (
            <DiscoverYouTubeGating slug={slug} expanded onChanged={(pending) => setPendingReview(pending)} />
          )}
        </>
      )}

      {/* Phone-only bottom tab bar — thumb-reachable Live/Trends/Channels,
          mirroring the top tabs. */}
      {isPhone && !searchQuery && (
        <nav
          aria-label="Tracker sections"
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 30,
            display: 'grid',
            gridTemplateColumns: `repeat(${canReview ? 4 : 3}, 1fr)`,
            background: 'var(--bg-card)',
            borderTop: '1px solid var(--border)',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          {(
            [
              ['live', 'Live', <IconBolt key="i" size={15} />],
              ['trends', 'Trends', <IconGrid key="i" size={15} />],
              ['channels', 'Channels', <IconList key="i" size={15} />],
              ...(canReview ? ([['review', 'Review', <IconCheck key="i" size={15} />]] as const) : []),
            ] as ReadonlyArray<readonly [TabKey, string, React.ReactNode]>
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={effectiveTab === id ? 'page' : undefined}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                padding: '9px 0 10px',
                minHeight: 48,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 10.5,
                fontWeight: 600,
                color: effectiveTab === id ? 'var(--red)' : 'var(--fg-muted)',
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
      )}
      <BackToTop />
    </div>
  );
}

/** Copies the exact current view URL — every filter and tab is in it. */
function ShareViewButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      title="Copy a link to this exact view"
      onClick={() => {
        void navigator.clipboard?.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
      style={{ padding: '7px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      {copied ? <IconCheck size={12} /> : <IconShare size={12} />}
      {copied ? 'Link copied' : 'Copy link'}
    </button>
  );
}

// Game art tile lives in components/discover/GameArtTile — shared with
// the tracker overview cards.

/** Right-rail: movers vs their 6h baseline. */
function TrendingRail({ slug }: { slug: string }) {
  const [rows, setRows] = useState<api.GameTrackerTrendingRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getGameTrackerTrending(slug, 6, 5)
        .then((r) => !cancelled && setRows(r.rows))
        .catch(() => {});
    load();
    const h = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [slug]);
  const shown = (rows ?? []).filter((r) => r.prev_peak > 0).slice(0, 4);
  if (rows !== null && shown.length === 0) return null;
  return (
    <Section title="Trending" eyebrow="VS. 6H BASELINE" compact>
      {rows === null ? (
        <LoadingBlock minHeight={80} />
      ) : (
        <Col gap={10}>
          {shown.map((r) => (
            <Row key={r.channel_id} justify="space-between" align="center">
              <Row gap={8} align="center" style={{ minWidth: 0 }}>
                <Avatar
                  src={(r.channel?.metadata?.profile_image_url as string | undefined) ?? null}
                  name={r.channel?.display_name ?? '—'}
                  size={20}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.channel?.display_name ?? r.channel_id}
                  </div>
                  <div className="tabular" style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
                    {fmtCompact(r.cur_peak)} CCV
                  </div>
                </div>
              </Row>
              <DeltaChip pct={r.cur_peak / r.prev_peak - 1} />
            </Row>
          ))}
        </Col>
      )}
    </Section>
  );
}

/** Right-rail: channels discovery found recently. */
function NewFacesRail({ slug, onReview }: { slug: string; onReview?: () => void }) {
  const [rows, setRows] = useState<api.GameTrackerRecentChannelRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getGameTrackerRecentChannels(slug, 48, 6)
      .then((r) => !cancelled && setRows(r.rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);
  if (rows !== null && rows.length === 0) return null;
  return (
    <Section title="New faces" eyebrow="FOUND BY DISCOVERY" compact>
      {rows === null ? (
        <LoadingBlock minHeight={80} />
      ) : (
        <Col gap={9}>
          {rows.map((r) => (
            <Row key={r.channel_id} justify="space-between" align="center">
              <Row gap={8} align="center" style={{ minWidth: 0 }}>
                <Avatar src={null} name={r.display_name} size={20} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.display_name}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>{fmtRelative(r.joined_at)}</div>
                </div>
              </Row>
              <span className="tabular" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {fmtCompact(r.peak)}
              </span>
            </Row>
          ))}
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--fg-dim)',
              lineHeight: 1.5,
              borderTop: '1px solid var(--border-faint)',
              paddingTop: 8,
            }}
          >
            YouTube channels count only after review. A missing number beats a wrong one.
            {onReview && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={onReview}
                  style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--red)', font: 'inherit', cursor: 'pointer' }}
                >
                  Open the review queue →
                </button>
              </>
            )}
          </div>
        </Col>
      )}
    </Section>
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
  platform,
  onViewAll,
  onReview,
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
  platform: string;
  onViewAll: () => void;
  onReview?: () => void;
}) {
  const shown = useMemo(
    () =>
      leaderboard == null
        ? null
        : platform === 'all'
          ? leaderboard
          : leaderboard.filter((r) => r.platform === platform),
    [leaderboard, platform],
  );

  // KPIs are computed from the SAME filtered set as the table below —
  // a "Viewers now" that disagrees with the rows under it reads as a bug.
  // One 24h window feeds two KPIs: the Δ-vs-6h chip and the 24h peak —
  // same platform scope as everything else so the numbers agree.
  const [baseline6h, setBaseline6h] = useState<number | null>(null);
  const [peak24, setPeak24] = useState<{ value: number; at: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 3600_000);
    api
      .getGameTrackerRange(slug, from, to, 600, platform !== 'all' ? platform : undefined)
      .then((r) => {
        if (cancelled) return;
        const sixAgo = to.getTime() - 6 * 3600_000;
        const base = r.buckets.find((b) => Date.parse(b.ts) >= sixAgo && b.total_ccv > 0);
        setBaseline6h(base ? base.total_ccv : null);
        let best: { value: number; at: string } | null = null;
        for (const b of r.buckets) {
          if (!best || b.total_ccv > best.value) best = { value: b.total_ccv, at: b.ts };
        }
        setPeak24(best && best.value > 0 ? best : null);
      })
      .catch(() => {
        if (!cancelled) {
          setBaseline6h(null);
          setPeak24(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, platform]);

  const [newToday, setNewToday] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getGameTrackerRecentChannels(slug, 24, 200)
      .then((r) => !cancelled && setNewToday(r.rows.length))
      .catch(() => !cancelled && setNewToday(null));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const kpis = useMemo(() => {
    const rows = shown ?? [];
    let total = 0;
    let peak = 0;
    const byLang = new Map<string, number>();
    for (const r of rows) {
      total += r.concurrent_viewers;
      if (r.concurrent_viewers > peak) peak = r.concurrent_viewers;
      const lang = r.language?.toUpperCase() ?? '—';
      byLang.set(lang, (byLang.get(lang) ?? 0) + r.concurrent_viewers);
    }
    let best: { lang: string; ccv: number } | null = null;
    for (const [lang, ccv] of byLang) {
      if (lang !== '—' && (!best || ccv > best.ccv)) best = { lang, ccv };
    }
    return {
      total,
      peak,
      topLang: best && total > 0 ? { lang: best.lang, sharePct: Math.round((best.ccv / total) * 100) } : null,
    };
  }, [shown]);
  const scopeSuffix = platform === 'all' ? '' : ` · ${platform}`;
  const deltaVs6h =
    baseline6h != null && baseline6h > 0 && kpis.total > 0
      ? Math.round(((kpis.total - baseline6h) / baseline6h) * 100)
      : null;

  const exportCsv = () => {
    if (!shown || shown.length === 0) return;
    downloadCsv(
      `${slug}-live-${csvStamp()}.csv`,
      ['rank', 'channel', 'platform', 'language', 'ccv', 'stream_title'],
      shown.map((row, i) => [
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
      {/* KPI strip — four plain stats, same treatment for each */}
      <div
        className="discover-kpis"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}
      >
        <StatBlock
          label={`Live viewers${scopeSuffix}`}
          value={
            <Row gap={10} align="baseline">
              <span>{fmtCompact(kpis.total)}</span>
              {deltaVs6h != null && <DeltaChip pct={deltaVs6h / 100} />}
            </Row>
          }
          sub={deltaVs6h != null ? 'vs 6 hours ago' : 'across live streams'}
        />
        <StatBlock
          label={`24h peak${scopeSuffix}`}
          value={peak24 ? fmtCompact(peak24.value) : '—'}
          sub={
            peak24
              ? `at ${new Date(peak24.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : null
          }
        />
        <StatBlock
          label="Live channels"
          value={fmtN(platform === 'all' ? activeChannelCount : (shown?.length ?? 0))}
          sub={platform === 'all' ? 'all platforms' : 'matching filter'}
        />
        <StatBlock
          label="New today"
          value={newToday != null ? fmtN(newToday) : '—'}
          sub="found by discovery"
        />
      </div>

      {/* Top streams + the discovery rails, prototype layout */}
      <div className="live-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }}>
        <div>
      <Section
        title="Top streams now"
        eyebrow={`Live now · ${(shown ?? []).length}${
          activeChannelCount > (shown?.length ?? 0) && platform === 'all' ? ` of ${fmtN(activeChannelCount)}` : ''
        } streams`}
        right={
          <Row gap={10} align="center" wrap>
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
        <LeaderboardTable
          rows={shown}
          trackerSlug={slug}
          showUptime
          // The column only appears once someone in the list has a grade
          // that passed the evidence gate — a column of dashes says nothing.
          showLastGrade={(shown ?? []).some((r) => r.last_grade)}
          sticky
        />
        {platform === 'tiktok' && (shown?.length ?? 0) > 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: '8px 0 0' }}>
            TikTok's category feed is region-personalized sampling. This column shows the
            streams it surfaces to us, not the full category.
          </div>
        )}
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
        </div>
        <Col gap={16}>
          <TrendingRail slug={slug} />
          <NewFacesRail slug={slug} onReview={onReview} />
        </Col>
      </div>
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

/** "3h 32m" since a live session started. */
function fmtUptime(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

export type LeaderboardRow = GameTrackerLeaderboardRow & {
  minutes_live?: number;
  days_streamed?: number;
  /** Range mode only — carried through for CSV export. */
  avg_ccv?: number;
  /** Range mode: how many completed sessions the median grade covers. */
  grade_sessions?: number;
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
            aria-label={`${r.display_name}: discovered ${fmtRelative(r.joined_at)}, peak ${fmtCompact(r.peak)}`}
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
  filterHint = null,
  rankOffset = 0,
  showLastGrade = false,
  showRangeGrade = false,
  showUptime,
  sticky = false,
}: {
  rows: LeaderboardRow[] | null;
  trackerSlug: string;
  /** Header label for the CCV column — "Live CCV" (now) or "Peak CCV" (range). */
  metricLabel?: string;
  /** Show Days streamed + Hours columns (range mode). */
  showRangeStats?: boolean;
  /** Set when a platform/language filter may be hiding rows. */
  filterHint?: string | null;
  /** First row's rank − 1 (pagination) so on-screen ranks match the CSV. */
  rankOffset?: number;
  /** Live boards: show each channel's last completed-broadcast grade. */
  showLastGrade?: boolean;
  /** Range mode: median grade over the window (no uptime column). */
  showRangeGrade?: boolean;
  /** Live boards: "3h 12m" since the session started. Defaults to showLastGrade for older callers. */
  showUptime?: boolean;
  /** Column headers stick under the page's sticky chrome while scrolling. */
  sticky?: boolean;
}) {
  const navigate = useNavigate();
  const uptime = showUptime ?? showLastGrade;
  const colCount =
    (showRangeStats ? 8 : 5) + (uptime ? 1 : 0) + (showLastGrade || showRangeGrade ? 1 : 0);
  const platformFilterHint = filterHint ? `(${filterHint})` : '';
  const th = sticky ? { ...thStyle, ...stickyThStyle } : thStyle;
  return (
    <TableScroll>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: showRangeStats ? 640 : 480 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ ...th, width: 36 }}>#</th>
          <th style={{ ...th, width: 56 }}></th>
          <th style={th}>Channel</th>
          <th style={{ ...th, width: 60 }}>Lang</th>
          {showRangeStats && <th style={{ ...th, textAlign: 'right', width: 70 }}>Days</th>}
          {showRangeStats && (
            <th style={{ ...th, textAlign: 'right', width: 90 }} title="Airtime: hours the channel was live">
              Hours live
            </th>
          )}
          {showRangeStats && (
            <th style={{ ...th, textAlign: 'right', width: 104 }} title="Avg viewers × hours live: total audience time">
              Hours watched
            </th>
          )}
          {uptime && (
            <th style={{ ...th, textAlign: 'right', width: 78 }} title="Time since this live session started">
              Uptime
            </th>
          )}
          {(showLastGrade || showRangeGrade) && (
            <th
              style={{ ...th, textAlign: 'center', width: 82 }}
              title={
                showRangeGrade
                  ? 'Median grade across the completed broadcasts inside this range'
                  : 'Grade of the channel\'s last completed broadcast (30 days): live sessions are scored after they end, and only once three broadcasts have been scored'
              }
            >
              {showRangeGrade ? 'Grade' : 'Last grade'}
            </th>
          )}
          <th style={{ ...th, textAlign: 'right', width: 110 }}>{metricLabel}</th>
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
              {showRangeStats ? 'No streams in this range' : 'No active streams right now'}{' '}
              {platformFilterHint}
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
                {rankOffset + i + 1}
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
                  {row.minutes_live != null && row.avg_ccv != null
                    ? fmtCompact(Math.round((row.avg_ccv * row.minutes_live) / 60))
                    : '—'}
                </td>
              )}
              {uptime && (
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--fg-muted)',
                    whiteSpace: 'nowrap',
                  }}
                  title="Time since this live session started"
                >
                  {row.live_started_at ? fmtUptime(row.live_started_at) : '—'}
                </td>
              )}
              {(showLastGrade || showRangeGrade) && (
                <td
                  style={{ ...tdStyle, textAlign: 'center' }}
                  title={
                    showRangeGrade && row.grade_sessions
                      ? `Median of ${row.grade_sessions} completed broadcast${row.grade_sessions === 1 ? '' : 's'} in range`
                      : undefined
                  }
                >
                  <GradeBadge
                    grade={row.last_grade}
                    score={row.last_score}
                    noGradeTitle={
                      row.avg_ccv != null && row.avg_ccv < 50
                        ? `Not scored: averages ${Math.round(row.avg_ccv)} viewers here (scoring starts at 50)`
                        : 'No scored broadcast in this range. A session is scored when it ends with 50+ avg viewers, 30+ minutes, and chat watched for half the stream'
                    }
                  />
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
  const [loaded, setLoaded] = useState(false);
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
  // Initials stay underneath until the picture has actually arrived —
  // lazy-loaded rows used to flash a row of blank circles.
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0 }}>
      {!loaded && fallback}
      <img
        src={src}
        alt=""
        loading="lazy"
        width={size}
        height={size}
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(true)}
        style={{
          position: 'absolute',
          inset: 0,
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          opacity: loaded ? 1 : 0,
          transition: 'opacity 120ms',
        }}
      />
    </span>
  );
}
