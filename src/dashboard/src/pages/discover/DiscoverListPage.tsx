import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTracker } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import {
  Row,
  Col,
  Pill,
  PlatformPip,
  IconPlus,
  IconBolt,
} from '@/components/design';
import { fmtCompact } from '@/design/format';

/**
 * /discover — landing page listing all game trackers.
 *
 * Grid of card-style tiles. Empty state guides admin to /discover/admin/new.
 */
interface TrackerPulse {
  buckets: Array<{ ts: string; total_ccv: number }>;
}

export function DiscoverListPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [trackers, setTrackers] = useState<GameTracker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<Record<string, TrackerPulse | null>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .listGameTrackers()
      .then((rows) => {
        if (!cancelled) setTrackers(rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Portfolio pulse — a 7d hourly series per tracker so the landing page
  // compares games instead of listing configs. Best-effort per card.
  useEffect(() => {
    if (!trackers?.length) return;
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3600_000);
    for (const t of trackers) {
      api
        .getGameTrackerRange(t.slug, from, to, 3600)
        .then((r) => {
          if (!cancelled) setPulse((prev) => ({ ...prev, [t.slug]: { buckets: r.buckets } }));
        })
        .catch(() => {
          if (!cancelled) setPulse((prev) => ({ ...prev, [t.slug]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [trackers]);

  const isAdmin = auth.user?.role === 'admin';

  return (
    <div style={{ padding: '32px 24px 64px', maxWidth: 1280, margin: '0 auto' }}>
      <Row justify="space-between" align="flex-end" style={{ marginBottom: 28, gap: 16 }}>
        <Col gap={6}>
          <h1
            style={{
              fontFamily: 'var(--font-display, var(--font-sans))',
              fontSize: 40,
              fontWeight: 700,
              color: 'var(--fg)',
              margin: 0,
              letterSpacing: '-0.02em',
              lineHeight: 1,
            }}
          >
            Discover
          </h1>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>
            Continuous viewership tracking per game across Twitch, Kick and YouTube.
          </p>
        </Col>
        <Row gap={8} align="center">
          {isAdmin && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate('/discover/admin/new')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <IconPlus size={13} /> New tracker
            </button>
          )}
        </Row>
      </Row>

      {error && (
        <div className="card" style={{ padding: 16, color: 'var(--red)', marginBottom: 20 }}>
          Failed to load trackers: {error}
        </div>
      )}

      {trackers === null && !error && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="card" style={{ padding: 20, opacity: 0.6 }}>
              <div style={{ height: 18, width: '55%', borderRadius: 5, background: 'var(--bg-hover)' }} />
              <div style={{ height: 12, width: '40%', borderRadius: 5, background: 'var(--bg-hover)', marginTop: 14 }} />
              <div style={{ height: 12, width: '30%', borderRadius: 5, background: 'var(--bg-hover)', marginTop: 8 }} />
            </div>
          ))}
        </div>
      )}

      {trackers && trackers.length === 0 && (
        <div
          className="card"
          style={{
            padding: '60px 24px',
            textAlign: 'center',
          }}
        >
          <Row justify="center" gap={6}>
            <IconBolt size={14} />
            <span style={{ fontSize: 14, color: 'var(--fg-muted)' }}>No game trackers yet.</span>
          </Row>
          {isAdmin && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--fg-muted)' }}>
              <Link to="/discover/admin/new" style={{ color: 'var(--red)' }}>
                Create one
              </Link>{' '}
              to start.
            </div>
          )}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 16,
        }}
      >
        {(trackers ?? []).map((t) => (
          <Link
            key={t.id}
            to={`/discover/${t.slug}`}
            style={{
              textDecoration: 'none',
              color: 'inherit',
              display: 'block',
            }}
          >
            <div
              className="card shadow-lg"
              style={{
                padding: 20,
                cursor: 'pointer',
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
                  height: 2,
                  background: 'var(--red)',
                }}
              />
              <Row justify="space-between" align="flex-start" style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-display, var(--font-sans))',
                    fontSize: 18,
                    fontWeight: 600,
                    color: 'var(--fg)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {t.name}
                </div>
                <Row gap={6} align="center">
                  <Pill tone={t.status === 'active' ? 'live' : 'default'}>
                    {t.status === 'active' ? '● Tracking' : t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                  </Pill>
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      title="Edit tracker"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        navigate(`/discover/admin/edit/${t.slug}`);
                      }}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                    >
                      Edit
                    </button>
                  )}
                </Row>
              </Row>
              <Col gap={6} style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {t.twitch_game_name && (
                  <Row gap={6} align="center">
                    <PlatformPip id="twitch" size={11} />
                    <span>{t.twitch_game_name}</span>
                  </Row>
                )}
                {t.kick_category_slug && (
                  <Row gap={6} align="center">
                    <PlatformPip id="kick" size={11} />
                    <span>{t.kick_category_slug}</span>
                  </Row>
                )}
                {t.youtube_enabled && (
                  <Row gap={6} align="center">
                    <PlatformPip id="youtube" size={11} />
                    <span>reviewed channels</span>
                  </Row>
                )}
              </Col>
              <TrackerPulseStrip pulse={pulse[t.slug]} />
              {isAdmin && (
                <Row gap={10} style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-dim)' }}>
                  <span>poll {t.polling_interval_seconds}s</span>
                  <span>·</span>
                  <span>min {t.min_ccv_threshold} CCV</span>
                </Row>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * 7-day pulse for one tracker card: viewers now, 24h/7d peaks, and an
 * hourly sparkline. Turns the Discover landing page into a portfolio view
 * — three games comparable at a glance — instead of a list of configs.
 */
function TrackerPulseStrip({ pulse }: { pulse: TrackerPulse | null | undefined }) {
  const stats = useMemo(() => {
    const buckets = pulse?.buckets ?? [];
    if (buckets.length === 0) return null;
    const now = buckets[buckets.length - 1]?.total_ccv ?? 0;
    const last24 = buckets.slice(-24);
    const peak24 = last24.reduce((m, b) => Math.max(m, b.total_ccv), 0);
    const peak7d = buckets.reduce((m, b) => Math.max(m, b.total_ccv), 0);
    return { now, peak24, peak7d, buckets };
  }, [pulse]);

  if (pulse === undefined) {
    return <div style={{ height: 62, marginTop: 12, borderRadius: 6, background: 'var(--bg-hover)', opacity: 0.5 }} />;
  }
  if (pulse === null || !stats) return null;

  const W = 260;
  const H = 30;
  const max = Math.max(stats.peak7d, 1);
  const pts = stats.buckets
    .map((b, i) => {
      const x = (i / Math.max(stats.buckets.length - 1, 1)) * W;
      const y = H - (b.total_ccv / max) * (H - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Col gap={8} style={{ marginTop: 14 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: H, display: 'block' }}
        aria-label="7-day viewership sparkline"
        role="img"
      >
        <polyline
          points={pts}
          fill="none"
          stroke="var(--red)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <Row gap={14} style={{ fontSize: 11.5, color: 'var(--fg-muted)' }} wrap>
        <span>
          <b style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(stats.now)}</b> now
        </span>
        <span>
          <b style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(stats.peak24)}</b> 24h peak
        </span>
        <span>
          <b style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(stats.peak7d)}</b> 7d peak
        </span>
      </Row>
    </Col>
  );
}
