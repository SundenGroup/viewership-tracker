import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '@/services/api';
import { Row } from '@/components/design';

interface GameLookupResult {
  twitch: Array<{ id: string; name: string }>;
  kick: Array<{ id: string; name: string }>;
}

/**
 * /discover/admin/new   — create a new game tracker.
 * /discover/admin/edit/:slug — edit an existing one (same form, prefilled).
 *
 * Uses the existing /api/series/games/lookup endpoint to resolve the
 * Twitch + Kick category IDs from a search term, mirroring the Series
 * setup workflow.
 */
export function DiscoverAdminNew() {
  const navigate = useNavigate();
  const { slug: editSlug } = useParams<{ slug?: string }>();
  const isEdit = !!editSlug;

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState<'active' | 'paused'>('active');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<GameLookupResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [twitchPick, setTwitchPick] = useState<{ id: string; name: string } | null>(null);
  const [kickPick, setKickPick] = useState<{ id: string; name: string } | null>(null);
  const [minCcv, setMinCcv] = useState(10);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);

  // Edit mode: load the existing tracker and prefill the form.
  useEffect(() => {
    if (!editSlug) return;
    let cancelled = false;
    setLoading(true);
    api
      .getGameTracker(editSlug)
      .then((t) => {
        if (cancelled) return;
        setName(t.name);
        setSlug(t.slug);
        setStatus(t.status === 'paused' ? 'paused' : 'active');
        setMinCcv(t.min_ccv_threshold);
        setTwitchPick(
          t.twitch_game_id ? { id: t.twitch_game_id, name: t.twitch_game_name ?? t.twitch_game_id } : null,
        );
        setKickPick(
          t.kick_category_id != null
            ? { id: String(t.kick_category_id), name: t.kick_category_slug ?? String(t.kick_category_id) }
            : null,
        );
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editSlug]);

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const handleNameChange = (v: string) => {
    setName(v);
    if (!slug || slug === slugify(name)) setSlug(slugify(v));
  };

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const result = await fetch(
        `/api/series/games/lookup?name=${encodeURIComponent(searchTerm)}`,
        { credentials: 'include' },
      );
      if (!result.ok) {
        throw new Error(`Lookup failed: ${result.status}`);
      }
      const json = (await result.json()) as GameLookupResult;
      setSearchResults(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim()) {
      setError('Name and slug are required');
      return;
    }
    if (!twitchPick && !kickPick) {
      setError('Pick at least one platform mapping');
      return;
    }
    setSubmitting(true);
    setError(null);
    const payload = {
      name: name.trim(),
      slug: slug.trim(),
      status,
      twitch_game_id: twitchPick?.id ?? null,
      twitch_game_name: twitchPick?.name ?? null,
      kick_category_id: kickPick ? Number(kickPick.id) : null,
      kick_category_slug: kickPick?.name ?? null,
      min_ccv_threshold: minCcv,
    };
    try {
      if (isEdit && editSlug) {
        const tracker = await api.updateGameTracker(editSlug, payload);
        navigate(`/discover/${tracker.slug}`);
      } else {
        const tracker = await api.createGameTracker(payload);
        navigate(`/discover/${tracker.slug}`);
      }
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '32px 24px', maxWidth: 800, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
        {isEdit ? 'Edit game tracker' : 'New game tracker'}
      </h1>
      <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontSize: 13, marginBottom: 24 }}>
        {isEdit
          ? 'Update this tracker’s name, platform mappings, threshold or status. Re-search only if you need to change the platform IDs.'
          : 'Continuously track all live streams of a game on Twitch (Kick to follow). Fill in the details and pick the right platform IDs.'}
      </p>

      {loading && (
        <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 13 }}>Loading tracker…</div>
      )}

      {error && (
        <div
          style={{
            padding: 12,
            borderRadius: 6,
            background: 'color-mix(in oklab, var(--red) 12%, transparent)',
            color: 'var(--red)',
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>
          1. Name
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="PUBG: Battlegrounds"
              style={inp}
            />
          </div>
          <div>
            <label style={lbl}>Slug (URL)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))}
              placeholder="pubg-battlegrounds"
              style={inp}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>
          2. {isEdit ? 'Platform IDs' : 'Find platform IDs'}
        </h3>
        {(twitchPick || kickPick) && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {twitchPick && (
              <span style={currentPickStyle}>
                Twitch: <strong>{twitchPick.name}</strong>{' '}
                <span style={{ color: 'var(--fg-dim)', fontFamily: 'monospace' }}>#{twitchPick.id}</span>
              </span>
            )}
            {kickPick && (
              <span style={currentPickStyle}>
                Kick: <strong>{kickPick.name}</strong>{' '}
                <span style={{ color: 'var(--fg-dim)', fontFamily: 'monospace' }}>#{kickPick.id}</span>
              </span>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            placeholder="Search game / category name (e.g. PUBG)"
            style={{ ...inp, flex: 1 }}
          />
          <button
            type="button"
            className="btn"
            onClick={handleSearch}
            disabled={searching || !searchTerm.trim()}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {searchResults && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
            <PlatformPickList
              label="Twitch"
              results={searchResults.twitch}
              picked={twitchPick}
              onPick={setTwitchPick}
            />
            <PlatformPickList
              label="Kick"
              results={searchResults.kick}
              picked={kickPick}
              onPick={setKickPick}
            />
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>
          3. Polling
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
          <div>
            <label style={lbl}>Minimum CCV threshold</label>
            <input
              type="number"
              min={1}
              value={minCcv}
              onChange={(e) => setMinCcv(Math.max(1, Number(e.target.value)))}
              style={inp}
            />
            <p style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 4 }}>
              Streams below this CCV won't be tracked. 10 is a sensible default.
            </p>
          </div>
          <div>
            <label style={lbl}>Status</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['active', 'paused'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="btn"
                  onClick={() => setStatus(s)}
                  style={{
                    flex: 1,
                    textTransform: 'capitalize',
                    borderColor: status === s ? 'var(--red)' : 'var(--border)',
                    color: status === s ? 'var(--red)' : 'var(--fg-muted)',
                    background: status === s
                      ? 'color-mix(in oklab, var(--red) 10%, transparent)'
                      : 'var(--bg-sunken)',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 4 }}>
              Paused trackers stop discovering and polling until re-activated.
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" onClick={() => navigate('/discover')}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={submitting || (!twitchPick && !kickPick) || !name.trim() || !slug.trim()}
        >
          {submitting
            ? isEdit
              ? 'Saving…'
              : 'Creating…'
            : isEdit
              ? 'Save changes'
              : 'Create tracker'}
        </button>
      </div>
    </div>
  );
}

function PlatformPickList({
  label,
  results,
  picked,
  onPick,
}: {
  label: string;
  results: Array<{ id: string; name: string }>;
  picked: { id: string; name: string } | null;
  onPick: (v: { id: string; name: string } | null) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-muted)', marginBottom: 6 }}>
        {label} ({results.length})
      </div>
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        {results.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: 'var(--fg-dim)' }}>No matches</div>
        )}
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(picked?.id === r.id ? null : r)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 12px',
              fontSize: 12,
              border: 'none',
              borderBottom: '1px solid var(--border-faint)',
              background:
                picked?.id === r.id
                  ? 'color-mix(in oklab, var(--red) 15%, transparent)'
                  : 'transparent',
              color: picked?.id === r.id ? 'var(--red)' : 'var(--fg)',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 500 }}>{r.name}</div>
            <div style={{ fontSize: 10, color: 'var(--fg-dim)', fontFamily: 'monospace' }}>
              id={r.id}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 4,
};

const currentPickStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
};

const inp: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
};
