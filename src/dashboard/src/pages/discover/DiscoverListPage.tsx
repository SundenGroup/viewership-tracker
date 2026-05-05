import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTracker } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';

/**
 * /discover — list of all game trackers.
 *
 * Phase 1 layout: simple card grid. Phase 3 will replace this with the
 * publisher-friendly aesthetic per the plan.
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
    <div style={{ padding: '32px 24px', maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            Discover
          </h1>
          <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontSize: 13 }}>
            Continuous viewership tracking per game, across Twitch
            <span style={{ color: 'var(--fg-dim)' }}> (Kick + YouTube to follow)</span>.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate('/discover/admin/new')}
          >
            New tracker
          </button>
        )}
      </div>

      {error && (
        <div className="placeholder" style={{ color: 'var(--red)', marginBottom: 20 }}>
          Failed to load trackers: {error}
        </div>
      )}

      {trackers && trackers.length === 0 && (
        <div className="placeholder" style={{ padding: '60px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
            No game trackers yet.
            {isAdmin && (
              <>
                {' '}
                <Link to="/discover/admin/new" style={{ color: 'var(--red)' }}>
                  Create one
                </Link>{' '}
                to start.
              </>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
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
                padding: 18,
                cursor: 'pointer',
                transition: 'transform 0.1s',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: 'var(--fg)',
                  }}
                >
                  {t.name}
                </div>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background:
                      t.status === 'active'
                        ? 'color-mix(in oklab, #10b981 20%, transparent)'
                        : 'color-mix(in oklab, var(--fg-dim) 20%, transparent)',
                    color: t.status === 'active' ? '#10b981' : 'var(--fg-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t.status}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                }}
              >
                {t.twitch_game_name && (
                  <div>
                    <span style={{ color: 'var(--fg-dim)' }}>Twitch:</span>{' '}
                    {t.twitch_game_name}
                  </div>
                )}
                {t.kick_category_slug && (
                  <div>
                    <span style={{ color: 'var(--fg-dim)' }}>Kick:</span>{' '}
                    {t.kick_category_slug}
                  </div>
                )}
                <div style={{ color: 'var(--fg-dim)', marginTop: 4 }}>
                  poll every {t.polling_interval_seconds}s · min {t.min_ccv_threshold} CCV
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
