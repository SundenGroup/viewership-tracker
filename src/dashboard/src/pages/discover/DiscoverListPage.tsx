import { useEffect, useState } from 'react';
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

/**
 * /discover — landing page listing all game trackers.
 *
 * Grid of card-style tiles. Empty state guides admin to /discover/admin/new.
 */
export function DiscoverListPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [trackers, setTrackers] = useState<GameTracker[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            Continuous viewership tracking per game on Twitch and Kick.
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
                    {t.status === 'active' ? '● Live' : t.status}
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
              </Col>
              <Row gap={10} style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-dim)' }}>
                <span>poll {t.polling_interval_seconds}s</span>
                <span>·</span>
                <span>min {t.min_ccv_threshold} CCV</span>
              </Row>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
