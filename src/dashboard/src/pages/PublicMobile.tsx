/**
 * Public Mobile — single-column, thumb-reachable public surfaces.
 * Ported from design_handoff_viewership_tracker v5 src/public-mobile.jsx.
 *
 * Auto-selects between PublicLiveMobile and PublicRecapMobile based on
 * whether any broadcast day is live.
 */

import { useMemo, useState } from 'react';
import type { PublicSeriesInfo } from '@/services/api';
import type { SeriesWithStages } from '@/types/api';
import type { usePublicPollingData } from '@/hooks/usePublicPollingData';
import { useDashboardModel, type ChannelRow } from '@/design/useDashboardModel';
import { useTimelineSeries } from '@/design/useTimelineSeries';
import {
  Row,
  Col,
  LogoMark,
  ClutchWordmark,
  Pill,
  PlatformPip,
  TierBadge,
  AreaChart,
  InteractiveMainChart,
  HeroKPIs,
  ThemeToggle,
  IconShare,
} from '@/components/design';
import { fmtCompact, fmtN, fmtDateLong } from '@/design/format';
import { PLATFORMS } from '@/design/platforms';

// ── Shared helpers ────────────────────────────────────────────────────

function MHeader({
  title,
  sub,
  right,
  live = false,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  live?: boolean;
}) {
  return (
    <header
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-raised)',
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Row gap={10} style={{ minWidth: 0 }}>
        <LogoMark size={14} withWordmark />
        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <Col gap={1} style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </div>
          {sub && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {sub}
            </div>
          )}
        </Col>
      </Row>
      <Row gap={6} style={{ flexShrink: 0 }}>
        {live && <Pill tone="live">● Live</Pill>}
        {right}
      </Row>
    </header>
  );
}

function HScroll({ children, padding = '0 16px' }: { children: React.ReactNode; padding?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        overflowX: 'auto',
        padding,
        scrollSnapType: 'x mandatory',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
      }}
    >
      {children}
    </div>
  );
}

function CategoryStrip({ model }: { model: ReturnType<typeof useDashboardModel> }) {
  return (
    <HScroll>
      {model.tierRows.map((t) => (
        <div
          key={t.key}
          className="card"
          style={{
            flex: '0 0 160px',
            padding: 14,
            scrollSnapAlign: 'start',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <Row justify="space-between">
            <span style={{ fontSize: 11, fontWeight: 600 }}>{t.label}</span>
            <span className="tabular" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
              {(t.share * 100).toFixed(0)}%
            </span>
          </Row>
          <div
            className="tabular"
            style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}
          >
            {fmtCompact(t.peak || t.ccv)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>Peak CCV</div>
          <div
            style={{
              marginTop: 6,
              height: 3,
              background: 'var(--bg-sunken)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <div style={{ width: t.share * 100 + '%', height: '100%', background: t.color }} />
          </div>
        </div>
      ))}
    </HScroll>
  );
}

function PlatformStrip({ model }: { model: ReturnType<typeof useDashboardModel> }) {
  return (
    <HScroll>
      {model.platformRows.map((p) => (
        <div
          key={p.id}
          className="card"
          style={{
            flex: '0 0 120px',
            padding: 12,
            scrollSnapAlign: 'start',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          <Row gap={6}>
            <PlatformPip id={p.id} size={10} />
            <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)' }}>
              {p.name}
            </span>
          </Row>
          <div
            className="tabular"
            style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.02em' }}
          >
            {fmtCompact(p.ccv)}
          </div>
          <div style={{ height: 2, background: 'var(--bg-sunken)', borderRadius: 1, overflow: 'hidden' }}>
            <div style={{ width: p.share * 100 + '%', height: '100%', background: p.color }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
            {(p.share * 100).toFixed(1)}%
          </div>
        </div>
      ))}
    </HScroll>
  );
}

function ChannelAccordion({
  channels,
  live = true,
  initial = 8,
}: {
  channels: ChannelRow[];
  live?: boolean;
  initial?: number;
}) {
  const [sort, setSort] = useState<keyof ChannelRow>(live ? 'live' : 'peak');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [region, setRegion] = useState<string>('all');
  const [platform, setPlatform] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

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
  const visible = showAll ? sorted : sorted.slice(0, initial);

  const toggleSort = (k: keyof ChannelRow) => {
    if (sort === k) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(k);
      setDir('desc');
    }
  };

  const sortOpts: Array<[keyof ChannelRow, string]> = live
    ? [
        ['live', 'Live'],
        ['peak', 'Peak'],
        ['avg', 'Avg'],
        ['hours', 'Hours'],
        ['name', 'A–Z'],
      ]
    : [
        ['peak', 'Peak'],
        ['avg', 'Avg'],
        ['hours', 'Hours'],
        ['name', 'A–Z'],
      ];

  const regionOptions = Array.from(new Set(channels.map((c) => c.region).filter(Boolean))) as string[];

  return (
    <div>
      <div style={{ overflowX: 'auto', marginBottom: 10, WebkitOverflowScrolling: 'touch' }}>
        <Row gap={6} style={{ padding: '0 0 4px', width: 'max-content' }}>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              fontSize: 11.5,
              padding: '5px 8px',
              borderRadius: 4,
            }}
          >
            <option value="all">All regions</option>
            {regionOptions.map((r) => (
              <option key={r} value={r}>
                {r.toUpperCase()}
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
              fontSize: 11.5,
              padding: '5px 8px',
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
        </Row>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 10, WebkitOverflowScrolling: 'touch' }}>
        <Row gap={4} style={{ padding: '0 0 4px', width: 'max-content' }}>
          <span className="eyebrow" style={{ alignSelf: 'center', marginRight: 4, fontSize: 9 }}>
            Sort
          </span>
          {sortOpts.map(([k, l]) => (
            <button
              key={String(k)}
              type="button"
              onClick={() => toggleSort(k)}
              className="btn btn-xs"
              style={{
                background: sort === k ? 'var(--bg-card)' : 'transparent',
                borderColor: sort === k ? 'var(--border-strong)' : 'var(--border)',
                color: sort === k ? 'var(--fg)' : 'var(--fg-muted)',
              }}
            >
              {l} {sort === k && (dir === 'asc' ? '▲' : '▼')}
            </button>
          ))}
        </Row>
      </div>

      <Col gap={4}>
        {visible.map((c, i) => {
          const isOpen = open === c.id;
          return (
            <div key={c.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : c.id)}
                style={{
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  padding: '10px 12px',
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr auto',
                  gap: 10,
                  alignItems: 'center',
                  cursor: 'pointer',
                  color: 'var(--fg)',
                  textAlign: 'left',
                }}
              >
                <span className="tabular" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                  {i + 1}
                </span>
                <Row gap={8} style={{ minWidth: 0 }}>
                  <PlatformPip id={c.platform} size={10} />
                  <Col gap={1} style={{ minWidth: 0 }}>
                    <Row gap={6} style={{ minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.name}
                      </span>
                      {c.language && (
                        <span className="mono" style={{ fontSize: 9.5, color: 'var(--fg-dim)' }}>
                          {c.language.toUpperCase()}
                        </span>
                      )}
                    </Row>
                    {c.title && (
                      <div
                        style={{
                          fontSize: 10.5,
                          color: 'var(--fg-dim)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.title}
                      </div>
                    )}
                  </Col>
                </Row>
                <Col gap={0} style={{ textAlign: 'right' }}>
                  <span
                    className="tabular"
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: live && c.live ? 'var(--fg)' : 'var(--fg-muted)',
                    }}
                  >
                    {live ? (
                      c.live ? (
                        fmtCompact(c.live)
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>offline</span>
                      )
                    ) : (
                      fmtCompact(c.peak)
                    )}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--fg-dim)' }}>
                    {live ? 'Live CCV' : 'Peak'}
                  </span>
                </Col>
              </button>
              {isOpen && (
                <div
                  style={{
                    padding: '4px 12px 12px',
                    borderTop: '1px solid var(--border-faint)',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4,1fr)',
                    gap: 8,
                    fontSize: 11,
                  }}
                >
                  {live && (
                    <Col gap={1}>
                      <span className="eyebrow" style={{ fontSize: 8 }}>
                        Live
                      </span>
                      <span className="tabular" style={{ fontSize: 13, fontWeight: 500 }}>
                        {c.live ? fmtCompact(c.live) : '—'}
                      </span>
                    </Col>
                  )}
                  <Col gap={1}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>
                      Peak
                    </span>
                    <span className="tabular" style={{ fontSize: 13, fontWeight: 500 }}>
                      {fmtCompact(c.peak)}
                    </span>
                  </Col>
                  <Col gap={1}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>
                      Avg
                    </span>
                    <span className="tabular" style={{ fontSize: 13, fontWeight: 500 }}>
                      {fmtCompact(c.avg)}
                    </span>
                  </Col>
                  <Col gap={1}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>
                      Hours
                    </span>
                    <span className="tabular" style={{ fontSize: 13, fontWeight: 500 }}>
                      {fmtCompact(c.hours)}
                    </span>
                  </Col>
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      marginTop: 4,
                    }}
                  >
                    <TierBadge tier={c.tier} />
                    {c.region && (
                      <span style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
                        {c.region.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Col>
      {sorted.length > initial && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="btn btn-xs"
          style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
        >
          {showAll ? `Show top ${initial}` : `Show all ${sorted.length} channels`}
        </button>
      )}
    </div>
  );
}

// ── PublicMobile (Live or Recap) ───────────────────────────────────────

export function PublicMobile({
  seriesInfo,
  seriesDetail,
  pollingData,
  shortName,
  mode,
}: {
  seriesInfo: PublicSeriesInfo;
  seriesDetail: SeriesWithStages;
  pollingData: ReturnType<typeof usePublicPollingData>;
  shortName: string;
  mode: 'live' | 'recap';
}) {
  const model = useDashboardModel({
    seriesDetail,
    metrics: pollingData.metrics,
    liveCCV: pollingData.liveCCV,
  });

  const scope = seriesInfo.id ? { level: 'series' as const, id: seriesInfo.id } : null;
  const timeline = useTimelineSeries({
    scope,
    interval: mode === 'live' ? 60 : 300,
    publicShortName: shortName,
  });

  const dateRange = useMemo(() => {
    if (seriesInfo.startDate && seriesInfo.endDate) {
      return `${fmtDateLong(seriesInfo.startDate)} – ${fmtDateLong(seriesInfo.endDate)}`;
    }
    return seriesInfo.startDate ? fmtDateLong(seriesInfo.startDate) : '';
  }, [seriesInfo]);

  const isLive = mode === 'live';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--bg)',
      }}
    >
      <MHeader
        title={seriesInfo.name}
        sub={
          isLive
            ? seriesInfo.game ?? 'Live viewership'
            : dateRange
              ? `${dateRange} · Recap`
              : 'Recap'
        }
        live={isLive}
        right={
          isLive ? (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                style={{ padding: 6 }}
                onClick={() => {
                  if (navigator.share) {
                    navigator
                      .share({ title: seriesInfo.name, url: window.location.href })
                      .catch(() => {});
                  } else {
                    navigator.clipboard.writeText(window.location.href).catch(() => {});
                  }
                }}
                title="Share"
              >
                <IconShare size={14} />
              </button>
              <ThemeToggle size={12} />
            </>
          ) : (
            <>
              <Pill>Completed</Pill>
              <ThemeToggle size={12} />
            </>
          )
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {/* Hero */}
        {isLive ? (
          <div style={{ padding: '20px 16px 12px' }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Right now · {model.liveChannelCount} channels · {model.platformRows.length} platforms
            </div>
            <div
              className="tabular"
              style={{
                fontSize: 64,
                lineHeight: 0.9,
                letterSpacing: '-0.05em',
                fontWeight: 600,
              }}
            >
              {fmtN(model.liveTotal)}
            </div>
            <Row gap={18} style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <Col gap={2}>
                <div className="eyebrow" style={{ fontSize: 9 }}>
                  Peak today
                </div>
                <div className="tabular" style={{ fontSize: 16, fontWeight: 500 }}>
                  {fmtCompact(model.peakTotal)}
                </div>
              </Col>
              <Col gap={2}>
                <div className="eyebrow" style={{ fontSize: 9 }}>
                  Avg today
                </div>
                <div className="tabular" style={{ fontSize: 16, fontWeight: 500 }}>
                  {fmtCompact(model.avgTotal)}
                </div>
              </Col>
              <Col gap={2}>
                <div className="eyebrow" style={{ fontSize: 9 }}>
                  Hours
                </div>
                <div className="tabular" style={{ fontSize: 16, fontWeight: 500 }}>
                  {fmtCompact(model.viewedHours)}
                </div>
              </Col>
              <Col gap={2}>
                <div className="eyebrow" style={{ fontSize: 9 }}>
                  Languages
                </div>
                <div className="tabular" style={{ fontSize: 16, fontWeight: 500 }}>
                  {model.languageBreakdown.length}
                </div>
              </Col>
            </Row>
            {timeline.total.length > 0 && (
              <>
                <div style={{ marginTop: 14, height: 90 }}>
                  <AreaChart data={timeline.total} width={360} height={90} color="var(--red)" />
                </div>
                <div
                  className="eyebrow"
                  style={{ textAlign: 'right', marginTop: 4, fontSize: 9 }}
                >
                  Last 8 hours
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <section style={{ padding: '20px 16px 10px' }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                Event recap
              </div>
              <h1
                style={{
                  fontSize: 26,
                  lineHeight: 1.1,
                  letterSpacing: '-0.03em',
                  fontWeight: 600,
                  margin: 0,
                }}
              >
                {seriesInfo.name}
              </h1>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>
                {dateRange ? `${dateRange} · ` : ''}
                {model.trackedChannelCount} channels · {model.platformRows.length} platforms ·{' '}
                {model.languageBreakdown.length} languages
              </div>
            </section>

            {/* HeroKPIs — mobile variant with micro visualizations (v6) */}
            <section style={{ padding: '0 16px 16px' }}>
              <HeroKPIs
                variant="mobile"
                peak={model.peakTotal}
                avg={model.avgTotal}
                hours={model.viewedHours}
                days={Math.max(1, seriesInfo.stages.reduce((a, s) => a + s.broadcast_days.length, 0))}
                timeSeries={timeline.total}
              />
            </section>
          </>
        )}

        {/* By category strip */}
        <div style={{ padding: '8px 16px 4px' }}>
          <div className="eyebrow">By category</div>
        </div>
        <CategoryStrip model={model} />

        {/* By platform strip */}
        <div style={{ padding: '16px 16px 4px' }}>
          <div className="eyebrow">By platform</div>
        </div>
        <PlatformStrip model={model} />

        {/* Timeline chart */}
        <section style={{ padding: '20px 16px 8px' }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Viewership over time
          </div>
          {timeline.total.length > 0 ? (
            <InteractiveMainChart
              height={180}
              width={360}
              series={{
                platform: timeline.platform,
                region: timeline.region,
                language: timeline.language,
                total: timeline.total,
              }}
              totalData={timeline.total}
              initialShowTotal={false}
              timestamps={timeline.timestamps}
              timezone={seriesInfo.timezone}
            />
          ) : (
            <div className="placeholder" style={{ height: 180 }}>
              {timeline.loading ? 'Loading…' : 'No time-series data'}
            </div>
          )}
        </section>

        {/* Channel accordion list */}
        <section style={{ padding: '20px 16px 32px' }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            {isLive
              ? `Live now · ${model.liveChannelCount} channels`
              : `All ${model.trackedChannelCount} channels`}
          </div>
          <ChannelAccordion channels={model.leaderboard} live={isLive} initial={isLive ? 8 : 10} />
        </section>

        <footer
          style={{
            padding: 16,
            borderTop: '1px solid var(--border)',
            fontSize: 10,
            color: 'var(--fg-dim)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <ClutchWordmark size={12} muted />
          <span>
            {isLive
              ? 'tracker.clutch.game · 30s refresh'
              : `Generated ${new Date().toLocaleDateString()}`}
          </span>
        </footer>
      </div>
    </div>
  );
}
