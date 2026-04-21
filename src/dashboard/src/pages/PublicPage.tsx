/**
 * Public dashboard — editorial live view at tracker.clutch.game/public/<shortName>.
 *
 * Automatically switches between:
 *   - PublicLive: when the series has any broadcast day with status === 'live'
 *   - PublicRecap: when the series is completed (all days done)
 *
 * Ported from design_handoff_clutch_tracker/reference/src/public.jsx
 * (PublicLive + PublicPostEvent / PublicRecap).
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Row,
  Col,
  ClutchWordmark,
  Pill,
  PlatformPip,
  TierBadge,
  AreaChart,
  VBarChart,
  Section,
  InteractiveMainChart,
  ThemeToggle,
} from '@/components/design';
import { fmtCompact, fmtN, fmtDateLong } from '@/design/format';
import { PLATFORMS, getPlatform } from '@/design/platforms';
import { useDashboardModel, type ChannelRow } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import { usePublicPollingData } from '@/hooks/usePublicPollingData';
import { useViewportBelow } from '@/hooks/useViewport';
import { PublicMobile } from './PublicMobile';
import { Spinner } from '@/components/common/Loader';
import * as api from '@/services/api';
import type { PublicSeriesInfo } from '@/services/api';
import type { SeriesWithStages } from '@/types/api';

const REGION_LABELS: Record<string, { label: string; desc: string }> = {
  global: { label: 'Global', desc: 'Official multi-region feeds' },
  west: { label: 'West', desc: 'EN / DE / FR / ES / PT' },
  east: { label: 'East', desc: 'RU / TR / PL' },
  apac: { label: 'APAC', desc: 'KO / JA / ZH / TH / VI' },
  emea: { label: 'EMEA', desc: 'Europe, Middle East, Africa' },
  americas: { label: 'Americas', desc: 'NA / SA' },
};

export function PublicPage() {
  const { shortName } = useParams<{ shortName: string }>();
  const isMobile = useViewportBelow(900);

  const [seriesInfo, setSeriesInfo] = useState<PublicSeriesInfo | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useEffect(() => {
    if (!shortName) return;
    setSeriesLoading(true);
    setSeriesError(null);
    api
      .getPublicSeries(shortName)
      .then((info) => {
        setSeriesInfo(info);
        setSeriesLoading(false);
      })
      .catch((err) => {
        setSeriesError(err instanceof Error ? err.message : 'Failed to load series');
        setSeriesLoading(false);
      });
  }, [shortName]);

  useEffect(() => {
    if (seriesInfo && shortName) {
      window.umami?.track('public-dashboard-view', {
        series: seriesInfo.name,
        shortName,
      });
    }

  }, [seriesInfo?.id]);

  const seriesId = seriesInfo?.id;
  const pollingData = usePublicPollingData(shortName, seriesId);

  // Is any broadcast day live? → PublicLive. Otherwise if series completed → PublicRecap.
  const liveDay = useMemo(() => {
    if (!seriesInfo) return null;
    for (const s of seriesInfo.stages) {
      for (const d of s.broadcast_days) {
        if (d.status === 'live') return d;
      }
    }
    return null;
  }, [seriesInfo]);

  // Construct a SeriesWithStages-shaped object for useDashboardModel.
  // NOTE: must run BEFORE any early returns to obey React's rules-of-hooks.
  const seriesDetail: SeriesWithStages | null = useMemo(() => {
    if (!seriesInfo) return null;
    return {
      id: seriesInfo.id,
      name: seriesInfo.name,
      short_name: seriesInfo.shortName,
      game: seriesInfo.game,
      partner: seriesInfo.partner,
      status: seriesInfo.status,
      timezone: seriesInfo.timezone,
      auto_start_polling: false,
      min_role: 'viewer',
      start_date: seriesInfo.startDate,
      end_date: seriesInfo.endDate,
      discovery_keywords: [],
      discovery_game_ids: {},
      discovery_default_tier: 'community',
      is_public: true,
      metadata: {},
      created_at: '',
      updated_at: '',
      stages: seriesInfo.stages.map((s) => ({
        id: s.id,
        series_id: seriesInfo.id,
        name: s.name,
        order: s.order,
        start_date: s.start_date,
        end_date: s.end_date,
        status: 'active',
        metadata: {},
        created_at: '',
        updated_at: '',
        broadcast_days: s.broadcast_days.map((d) => ({
          id: d.id,
          stage_id: s.id,
          series_id: seriesInfo.id,
          label: d.label,
          date: d.date,
          broadcast_start: d.broadcast_start,
          broadcast_end: d.broadcast_end,
          status: d.status,
          metadata: {},
          created_at: '',
          updated_at: '',
        })),
      })),
    };
  }, [seriesInfo]);

  // Early-return states — ALL hooks above this line must be called on every render.
  if (seriesLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  if (seriesError || !seriesInfo || !shortName || !seriesDetail) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>Series not found</h1>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 6 }}>
            {seriesError ?? 'This series does not exist or is not publicly available.'}
          </p>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <PublicMobile
        seriesInfo={seriesInfo}
        seriesDetail={seriesDetail}
        pollingData={pollingData}
        shortName={shortName}
        mode={liveDay ? 'live' : 'recap'}
      />
    );
  }

  if (liveDay) {
    return <PublicLive seriesInfo={seriesInfo} seriesDetail={seriesDetail} pollingData={pollingData} shortName={shortName} />;
  }

  return <PublicRecap seriesInfo={seriesInfo} seriesDetail={seriesDetail} pollingData={pollingData} shortName={shortName} />;
}

// ── PublicLive ────────────────────────────────────────────────────────────

function PublicLive({
  seriesInfo,
  seriesDetail,
  pollingData,
  shortName,
}: {
  seriesInfo: PublicSeriesInfo;
  seriesDetail: SeriesWithStages;
  pollingData: ReturnType<typeof usePublicPollingData>;
  shortName: string;
}) {
  const model = useDashboardModel({
    seriesDetail,
    metrics: pollingData.metrics,
    liveCCV: pollingData.liveCCV,
  });

  const scope = seriesInfo.id
    ? { level: 'series' as const, id: seriesInfo.id }
    : null;

  const timeline = useTimelineSeries({ scope, interval: 60, publicShortName: shortName });

  // Filters lifted from the channel table into the header per design v2.
  const [region, setRegion] = useState<string>('all');
  const [platform, setPlatform] = useState<string>('all');
  const regionOptions = useMemo(
    () => Array.from(new Set(model.leaderboard.map((c) => c.region).filter(Boolean))) as string[],
    [model.leaderboard],
  );

  const liveCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.filter((d) => d.status === 'live').length,
    0,
  );
  const totalDayCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.length,
    0,
  );
  const completedDayCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.filter((d) => d.status === 'completed').length,
    0,
  );
  const currentDayNumber = completedDayCount + (liveCount > 0 ? 1 : 0);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header
        style={{
          padding: '20px 32px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Row gap={18}>
          <ClutchWordmark size={18} />
          <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
          <Col gap={1}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{seriesInfo.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
              {seriesInfo.game ? `${seriesInfo.game} · ` : ''}Live viewership
            </div>
          </Col>
        </Row>
        <Row gap={10}>
          <Pill tone="live">
            ● Live
            {totalDayCount > 0 ? ` · Day ${currentDayNumber} of ${totalDayCount}` : ''}
          </Pill>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 4,
            }}
          >
            <option value="all">All regions</option>
            {regionOptions.map((r) => (
              <option key={r} value={r}>
                {REGION_LABELS[r.toLowerCase()]?.label ?? r.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 4,
            }}
          >
            <option value="all">All platforms</option>
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <ThemeToggle />
        </Row>
      </header>

      {/* Hero row */}
      <div
        style={{
          padding: '40px 32px 24px',
          display: 'grid',
          gridTemplateColumns: '1.3fr 1fr',
          gap: 32,
          alignItems: 'end',
        }}
      >
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Right now · {model.liveChannelCount} channels across {model.platformRows.length} platforms
          </div>
          <div
            className="tabular"
            style={{
              fontSize: 'clamp(72px, 11vw, 150px)',
              lineHeight: 0.9,
              letterSpacing: '-0.05em',
              fontWeight: 600,
            }}
          >
            {fmtN(model.liveTotal)}
          </div>
          <Row gap={32} style={{ marginTop: 16, flexWrap: 'wrap' }}>
            <Col gap={2}>
              <div className="eyebrow">Peak today</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {fmtCompact(model.peakTotal)}
              </div>
            </Col>
            <Col gap={2}>
              <div className="eyebrow">Avg today</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {fmtCompact(model.avgTotal)}
              </div>
            </Col>
            <Col gap={2}>
              <div className="eyebrow">Hours watched</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {fmtCompact(model.viewedHours)}
              </div>
            </Col>
            <Col gap={2}>
              <div className="eyebrow">Languages</div>
              <div className="tabular" style={{ fontSize: 22, fontWeight: 500 }}>
                {model.languageBreakdown.length}
              </div>
            </Col>
          </Row>
        </div>
        <div style={{ height: 180 }}>
          {timeline.total.length > 0 ? (
            <>
              <AreaChart data={timeline.total} width={500} height={180} color="var(--red)" />
              <div className="eyebrow" style={{ textAlign: 'right', marginTop: 4 }}>
                Series timeline
              </div>
            </>
          ) : (
            <div className="placeholder" style={{ height: 180 }}>
              Collecting data…
            </div>
          )}
        </div>
      </div>

      {/* By category (tier breakdown) */}
      <div style={{ padding: '0 32px 16px' }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          By category
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 10,
          }}
        >
          {model.tierRows.map((t) => (
            <div
              key={t.key}
              className="card"
              style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <Row justify="space-between">
                <span style={{ fontSize: 12, fontWeight: 600 }}>{t.label}</span>
                <span
                  className="tabular"
                  style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}
                >
                  {(t.share * 100).toFixed(0)}%
                </span>
              </Row>
              <div
                className="tabular"
                style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}
              >
                {fmtCompact(t.ccv)}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>Live CCV</div>
              <div
                style={{
                  marginTop: 8,
                  height: 4,
                  background: 'var(--bg-sunken)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: t.share * 100 + '%',
                    height: '100%',
                    background: t.color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Platform tiles */}
      <div style={{ padding: '8px 32px 0' }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          By platform
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(140px, 1fr))`,
            gap: 8,
          }}
        >
          {model.platformRows.map((p) => (
            <div
              key={p.id}
              className="card"
              style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <Row gap={6}>
                <PlatformPip id={p.id} size={12} />
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)' }}>
                  {p.name}
                </span>
              </Row>
              <div
                className="tabular"
                style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}
              >
                {fmtCompact(p.ccv)}
              </div>
              <Row style={{ alignItems: 'center' }}>
                <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                  {(p.share * 100).toFixed(1)}%
                </span>
                <div
                  style={{
                    flex: 1,
                    marginLeft: 8,
                    height: 3,
                    background: 'var(--bg-sunken)',
                    borderRadius: 2,
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
              </Row>
            </div>
          ))}
        </div>
      </div>

      {/* Main interactive chart */}
      <div style={{ padding: '28px 32px 24px' }}>
        <Section eyebrow="Viewership over time" title="Today · per minute">
          {timeline.total.length > 0 ? (
            <InteractiveMainChart
              height={260}
              width={1250}
              series={{
                platform: timeline.platform,
                region: timeline.region,
                language: timeline.language,
                total: timeline.total,
              }}
              totalData={timeline.total}
            />
          ) : (
            <div className="placeholder" style={{ height: 260 }}>
              {timeline.loading ? 'Loading time series…' : 'No time-series data yet'}
            </div>
          )}
        </Section>
      </div>

      {/* Sortable channel table */}
      <div style={{ padding: '0 32px 40px' }}>
        <Section eyebrow="Live now" title={`All ${model.leaderboard.length} tracked channels`}>
          <SortableChannelTable
            channels={model.leaderboard}
            live
            region={region}
            platform={platform}
            onRegionChange={setRegion}
            onPlatformChange={setPlatform}
          />
        </Section>
      </div>

      <footer
        style={{
          padding: '24px 32px',
          borderTop: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--fg-dim)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <ClutchWordmark size={14} muted />
        <span>tracker.clutch.game/public/{shortName} · Updated every 30s</span>
      </footer>
    </div>
  );
}

// ── PublicRecap ────────────────────────────────────────────────────────────

function PublicRecap({
  seriesInfo,
  seriesDetail,
  pollingData,
  shortName,
}: {
  seriesInfo: PublicSeriesInfo;
  seriesDetail: SeriesWithStages;
  pollingData: ReturnType<typeof usePublicPollingData>;
  shortName: string;
}) {
  const model = useDashboardModel({
    seriesDetail,
    metrics: pollingData.metrics,
    liveCCV: pollingData.liveCCV,
  });

  const scope = seriesInfo.id
    ? { level: 'series' as const, id: seriesInfo.id }
    : null;

  const timeline = useTimelineSeries({ scope, interval: 300, publicShortName: shortName });

  const totalDayCount = seriesInfo.stages.reduce(
    (acc, s) => acc + s.broadcast_days.length,
    0,
  );

  const palette = [
    'var(--red)', 'var(--info)', 'var(--warn)', 'var(--live)',
    'var(--twitch)', 'var(--tiktok)', 'var(--youtube)', 'var(--kick)',
  ];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Header */}
      <header style={{ padding: '28px 40px 8px', borderBottom: '1px solid var(--border)' }}>
        <Row justify="space-between">
          <Row gap={18}>
            <ClutchWordmark size={18} />
            <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
            <Col gap={1}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{seriesInfo.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
                Final recap
                {seriesInfo.startDate && seriesInfo.endDate
                  ? ` · ${fmtDateLong(seriesInfo.startDate)} – ${fmtDateLong(seriesInfo.endDate)}`
                  : seriesInfo.startDate
                    ? ` · ${fmtDateLong(seriesInfo.startDate)}`
                    : ''}
              </div>
            </Col>
          </Row>
          <Row gap={8}>
            <Pill>Completed</Pill>
            <ThemeToggle />
          </Row>
        </Row>
      </header>

      {/* Headline */}
      <section style={{ padding: '40px 40px 24px' }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          Event recap
        </div>
        <h1
          style={{
            fontSize: 'clamp(36px, 5vw, 56px)',
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
            fontWeight: 600,
            margin: 0,
            maxWidth: 1000,
          }}
        >
          {seriesInfo.name}
        </h1>
        <div style={{ fontSize: 15, color: 'var(--fg-muted)', marginTop: 8 }}>
          {totalDayCount} broadcast day{totalDayCount === 1 ? '' : 's'} ·{' '}
          {model.trackedChannelCount} tracked channels · {model.platformRows.length} platforms ·{' '}
          {model.languageBreakdown.length} languages
        </div>
      </section>

      {/* KPI strip — 3-up per v5 (Channels + Languages removed) */}
      <section style={{ padding: '0 40px 32px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 0,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            overflow: 'hidden',
            background: 'var(--bg-card)',
          }}
        >
          {[
            { label: 'Peak CCV', value: fmtN(model.peakTotal), sub: 'single highest moment' },
            { label: 'Avg CCV', value: fmtCompact(model.avgTotal), sub: 'across broadcast hours' },
            { label: 'Hours watched', value: fmtCompact(model.viewedHours), sub: 'of live broadcast' },
          ].map((k, i, arr) => (
            <div
              key={k.label}
              style={{
                padding: '20px 18px',
                borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <div className="eyebrow" style={{ fontSize: 11 }}>
                {k.label}
              </div>
              <div
                className="tabular"
                style={{
                  fontSize: 32,
                  fontWeight: 500,
                  letterSpacing: '-0.02em',
                  lineHeight: 1.05,
                  marginTop: 4,
                }}
              >
                {k.value}
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                {k.sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* By category (tier breakdown) */}
      <section style={{ padding: '0 40px 32px' }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          By category
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 10,
          }}
        >
          {model.tierRows.map((t) => (
            <div key={t.key} className="card" style={{ padding: 16 }}>
              <Row justify="space-between">
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                <span
                  className="tabular"
                  style={{ fontSize: 11, color: 'var(--fg-dim)' }}
                >
                  {(t.share * 100).toFixed(0)}%
                </span>
              </Row>
              <div
                className="tabular"
                style={{
                  fontSize: 28,
                  fontWeight: 500,
                  letterSpacing: '-0.02em',
                  marginTop: 6,
                }}
              >
                {fmtCompact(t.peak || t.ccv)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Peak concurrent</div>
              <div
                style={{
                  marginTop: 10,
                  height: 5,
                  background: 'var(--bg-sunken)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: t.share * 100 + '%',
                    height: '100%',
                    background: t.color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Timeline */}
      <section style={{ padding: '0 40px 32px' }}>
        <Section eyebrow="Viewership over time" title="How audience shifted across the event">
          {timeline.total.length > 0 ? (
            <InteractiveMainChart
              height={280}
              width={1160}
              series={{
                platform: timeline.platform,
                region: timeline.region,
                language: timeline.language,
                total: timeline.total,
              }}
              totalData={timeline.total}
            />
          ) : (
            <div className="placeholder" style={{ height: 280 }}>
              {timeline.loading ? 'Loading time series…' : 'No time-series data'}
            </div>
          )}
        </Section>
      </section>

      {/* Languages bar chart */}
      {model.languageBreakdown.length > 0 && (
        <section style={{ padding: '0 40px 32px' }}>
          <Section
            eyebrow="Languages"
            title={`Peak CCV by language · ${model.languageBreakdown.length} tracked`}
          >
            <div style={{ height: 240 }}>
              <VBarChart
                width={1160}
                height={240}
                items={model.languageBreakdown.slice(0, 8).map((l, i) => ({
                  label: (l.language ?? l.key ?? '').toUpperCase() || '—',
                  value: l.peakCCV ?? Number(l.peak_ccv ?? 0) ?? l.totalCCV ?? 0,
                  sub: '',
                  color: palette[i % palette.length]!,
                }))}
              />
            </div>
          </Section>
        </section>
      )}

      {/* All channels */}
      <section style={{ padding: '0 40px 48px' }}>
        <Section
          eyebrow="Channel breakdown"
          title={`All ${model.leaderboard.length} tracked channels`}
        >
          <SortableChannelTable channels={model.leaderboard} live={false} />
        </Section>
      </section>

      <footer
        style={{
          padding: '24px 40px',
          borderTop: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--fg-dim)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <ClutchWordmark size={14} muted />
        <span>
          Generated {new Date().toLocaleDateString()} · tracker.clutch.game/public/{shortName}
        </span>
      </footer>
    </div>
  );
}

// ── Sortable channel table (shared between Live + Recap) ─────────────────

function SortableChannelTable({
  channels,
  live,
  region: controlledRegion,
  platform: controlledPlatform,
  onRegionChange,
  onPlatformChange,
}: {
  channels: ChannelRow[];
  live: boolean;
  region?: string;
  platform?: string;
  onRegionChange?: (v: string) => void;
  onPlatformChange?: (v: string) => void;
}) {
  const [sort, setSort] = useState<keyof ChannelRow>(live ? 'live' : 'peak');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [internalRegion, setInternalRegion] = useState<string>('all');
  const [internalPlatform, setInternalPlatform] = useState<string>('all');

  const region = controlledRegion ?? internalRegion;
  const platform = controlledPlatform ?? internalPlatform;
  const setRegion = onRegionChange ?? setInternalRegion;
  const setPlatform = onPlatformChange ?? setInternalPlatform;

  const filtered = channels
    .filter((c) => (region === 'all' ? true : c.region === region))
    .filter((c) => (platform === 'all' ? true : c.platform === platform));

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sort] ?? 0;
    const bv = b[sort] ?? 0;
    if (typeof av === 'string' && typeof bv === 'string') {
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return dir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });

  const toggle = (k: keyof ChannelRow) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(k);
      setDir('desc');
    }
  };

  const H = ({
    k,
    children,
    align = 'left',
  }: {
    k: keyof ChannelRow;
    children: React.ReactNode;
    align?: 'left' | 'right' | 'center';
  }) => (
    <button
      type="button"
      onClick={() => toggle(k)}
      style={{
        background: 'none',
        border: 'none',
        textAlign: align,
        padding: 0,
        color: sort === k ? 'var(--fg)' : 'var(--fg-dim)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        width: '100%',
      }}
    >
      {children} {sort === k && <span>{dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );

  // Column order per design v4: Channel · Region · Tier · Lang · [Live (live view only) · Peak · Avg · Hours]
  const cols = live
    ? '28px 1.7fr 90px 90px 60px 80px 80px 80px 90px'
    : '28px 1.7fr 90px 90px 60px 80px 80px 90px';
  const regions = Array.from(new Set(channels.map((c) => c.region).filter(Boolean))) as string[];
  const filtersControlled = !!onRegionChange || !!onPlatformChange;

  return (
    <div>
      {!filtersControlled ? (
        <Row gap={8} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 4,
            }}
          >
            <option value="all">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {REGION_LABELS[r.toLowerCase()]?.label ?? r.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 4,
            }}
          >
            <option value="all">All platforms</option>
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {sorted.length} channels · sort any column
          </div>
        </Row>
      ) : (
        <Row justify="flex-end" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {sorted.length} channels · sort any column
          </div>
        </Row>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          gap: 0,
          padding: '0 6px 8px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div />
        <H k="name">Channel</H>
        <H k="region">Region</H>
        <H k="tier">Tier</H>
        <H k="language">Lang</H>
        {live && <H k="live" align="right">Live</H>}
        <H k="peak" align="right">Peak</H>
        <H k="avg" align="right">Avg</H>
        <H k="hours" align="right">Hours</H>
      </div>
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        {sorted.map((c, i) => (
          <div
            key={c.id}
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              padding: '9px 6px',
              borderBottom: '1px solid var(--border-faint)',
              fontSize: 13,
              alignItems: 'center',
            }}
          >
            <div className="tabular" style={{ color: 'var(--fg-dim)', fontSize: 11 }}>
              {i + 1}
            </div>
            <Row gap={8} style={{ minWidth: 0 }}>
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
                {c.title && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.title}
                  </div>
                )}
              </div>
            </Row>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              {c.region ? REGION_LABELS[c.region.toLowerCase()]?.label ?? c.region.toUpperCase() : '—'}
            </div>
            <div>
              <TierBadge tier={c.tier} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {(c.language ?? '').toUpperCase() || '—'}
            </div>
            {live && (
              <div
                className="tabular"
                style={{
                  textAlign: 'right',
                  color: c.live ? 'var(--fg)' : 'var(--fg-dim)',
                  fontWeight: c.live ? 500 : 400,
                }}
              >
                {c.live ? fmtCompact(c.live) : <span style={{ fontSize: 11 }}>offline</span>}
              </div>
            )}
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtCompact(c.peak)}
            </div>
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtCompact(c.avg)}
            </div>
            <div className="tabular" style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
              {fmtCompact(c.hours)}
            </div>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="placeholder" style={{ margin: 12, height: 80 }}>
            No channels match the filters
          </div>
        )}
      </div>
    </div>
  );
}
