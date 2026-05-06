import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTrackerSearchRow } from '@/services/api';
import {
  Row,
  Col,
  Pill,
  PlatformPip,
  IconSearch,
  IconX,
} from '@/components/design';
import { fmtCompact } from '@/design/format';
import { Avatar } from './DiscoverDetailPage';

interface Props {
  slug: string;
  /** Hint for the input placeholder. */
  placeholder?: string;
}

const DEBOUNCE_MS = 250;

/**
 * Search streams within a tracker by title or channel name. Live
 * dropdown of matches, click a row to jump to that streamer's channel
 * page. Shows last-seen + most recent title + peak CCV per match.
 */
export function DiscoverSearch({ slug, placeholder }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<GameTrackerSearchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search.
  useEffect(() => {
    if (query.trim().length < 2) {
      setRows(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      let cancelled = false;
      api
        .searchGameTracker(slug, query.trim(), 30, 30)
        .then((res) => {
          if (cancelled) return;
          setRows(res.rows);
          setError(null);
          setLoading(false);
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setError(err.message);
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [slug, query]);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', maxWidth: 460 }}>
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 12,
            color: 'var(--fg-dim)',
            display: 'inline-flex',
            alignItems: 'center',
            pointerEvents: 'none',
          }}
        >
          <IconSearch size={13} />
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder ?? 'Search titles or channels (e.g. "drops")'}
          style={{
            width: '100%',
            padding: '8px 32px 8px 32px',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setRows(null);
            }}
            aria-label="Clear search"
            style={{
              position: 'absolute',
              right: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              border: 'none',
              background: 'transparent',
              color: 'var(--fg-dim)',
              cursor: 'pointer',
            }}
          >
            <IconX size={12} />
          </button>
        )}
      </div>

      {open && (rows !== null || loading || error) && (
        <div
          className="card shadow-lg"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: 420,
            overflowY: 'auto',
            zIndex: 10,
            padding: 0,
          }}
        >
          {loading && rows === null && (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-muted)' }}>Searching…</div>
          )}
          {error && (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--red)' }}>{error}</div>
          )}
          {rows !== null && rows.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-muted)' }}>
              No matches in the last 30 days.
            </div>
          )}
          {rows !== null && rows.length > 0 && (
            <>
              <div
                style={{
                  padding: '8px 14px',
                  fontSize: 10,
                  color: 'var(--fg-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  borderBottom: '1px solid var(--border-faint)',
                }}
              >
                {rows.length} match{rows.length === 1 ? '' : 'es'}
              </div>
              <Col gap={0}>
                {rows.map((r) => {
                  if (!r.channel) return null;
                  const profilePic = r.channel.metadata.profile_image_url as string | undefined;
                  const lastSeen = new Date(r.last_seen);
                  const ageMins = Math.floor((Date.now() - lastSeen.getTime()) / 60_000);
                  return (
                    <Link
                      key={r.channel_id}
                      to={`/discover/${slug}/channel/${r.channel_id}`}
                      onClick={() => setOpen(false)}
                      style={{
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <div
                        style={{
                          padding: '10px 14px',
                          borderBottom: '1px solid var(--border-faint)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--bg-sunken)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        <Avatar src={profilePic ?? null} name={r.channel.display_name} size={28} />
                        <Col gap={2} style={{ minWidth: 0, flex: 1 }}>
                          <Row gap={6} align="center" style={{ minWidth: 0 }}>
                            <PlatformPip id={r.channel.platform} size={11} />
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: 'var(--fg)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {r.channel.display_name}
                            </span>
                            <Pill tone={r.matched_field === 'title' ? 'red' : 'default'}>
                              {r.matched_field}
                            </Pill>
                          </Row>
                          {r.stream_title && (
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--fg-muted)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {r.stream_title}
                            </div>
                          )}
                        </Col>
                        <Col gap={2} style={{ alignItems: 'flex-end' }}>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              fontVariantNumeric: 'tabular-nums',
                              color: 'var(--fg)',
                              fontWeight: 600,
                            }}
                          >
                            {fmtCompact(r.peak_ccv)}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              color: 'var(--fg-dim)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            {ageMins < 60
                              ? `${ageMins}m ago`
                              : ageMins < 60 * 24
                              ? `${Math.floor(ageMins / 60)}h ago`
                              : `${Math.floor(ageMins / (60 * 24))}d ago`}
                          </span>
                        </Col>
                      </div>
                    </Link>
                  );
                })}
              </Col>
            </>
          )}
        </div>
      )}
    </div>
  );
}
