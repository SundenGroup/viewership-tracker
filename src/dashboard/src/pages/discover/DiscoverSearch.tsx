import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTrackerSearchRow } from '@/services/api';
import {
  Row,
  Col,
  Pill,
  PlatformPip,
  IconSearch,
  IconSparkle,
  IconX,
} from '@/components/design';
import { fmtCompact, fmtRelative } from '@/design/format';
import { Avatar } from './DiscoverDetailPage';
import type { DiscoverAskController } from '@/components/discover/DiscoverAskBox';

interface Props {
  slug: string;
  /** When provided, the box is an omnibox: search AND natural-language Ask. */
  ask?: DiscoverAskController;
  /** Hint for the input placeholder. */
  placeholder?: string;
}

const DEBOUNCE_MS = 250;
const DROPDOWN_LIMIT = 10;

/** Heuristic: does the query read like a question rather than a term? */
function looksLikeQuestion(q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t.split(/\s+/).length >= 4) return true;
  return /^(top|how|what|who|which|when|compare|most|best|average|avg|peak|total)\b/.test(t);
}

/**
 * The Discover omnibox: ONE input for both literal search and Ask AI.
 *
 * Typing → instant dropdown of channel/title matches (as before).
 * Enter → full search results page. The dropdown carries a pinned
 * "✦ Ask AI" action (also ⌘/Ctrl+Enter) that routes the raw text to the
 * natural-language Ask instead — replacing the confusing twin-input
 * layout where Ask and Search sat side by side looking identical.
 */
export function DiscoverSearch({ slug, ask, placeholder }: Props) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const [rows, setRows] = useState<GameTrackerSearchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep input in sync if the URL query changes (e.g. user hits back).
  useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);

  // Debounced search — used to populate the dropdown preview.
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
        .searchGameTracker(slug, query.trim(), 30, DROPDOWN_LIMIT)
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

  const submitSearch = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    setOpen(false);
    // A search takeover replaces the body — clear any lingering Ask card
    // so the two result surfaces can't stack.
    ask?.dismiss();
    navigate(`/discover/${slug}?q=${encodeURIComponent(trimmed)}`);
  };

  const submitAsk = (q: string) => {
    const trimmed = q.trim();
    if (!ask || trimmed.length < 2 || ask.pending) return;
    setOpen(false);
    ask.submit(trimmed);
  };

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const askable = !!ask && query.trim().length >= 2;
  const questionish = askable && looksLikeQuestion(query);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', maxWidth: 520 }}>
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
          ref={ask?.inputRef}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if ((e.metaKey || e.ctrlKey) && ask) submitAsk(query);
              else submitSearch(query);
            } else if (e.key === 'Escape') {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={
            placeholder ??
            (ask
              ? 'Search channels & titles, or ask — e.g. "top 10 turkish streamers in may"'
              : 'Search titles or channels (e.g. "drops")')
          }
          aria-label={ask ? 'Search or ask about this game' : 'Search titles or channels'}
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
        {ask?.pending ? (
          <span style={{ position: 'absolute', right: 10, display: 'inline-flex' }}>
            <PendingDots />
          </span>
        ) : (
          query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setRows(null);
                if (urlQuery) navigate(`/discover/${slug}`);
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
          )
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
            <div style={{ padding: 14, fontSize: 12, color: 'var(--danger)' }}>{error}</div>
          )}
          {rows !== null && rows.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-muted)' }}>
              No channel or title matches in the last 30 days.
              {questionish && ' Looks like a question — try Ask below.'}
            </div>
          )}
          {rows !== null && rows.length > 0 && (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 14px',
                  fontSize: 10,
                  color: 'var(--fg-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  borderBottom: '1px solid var(--border-faint)',
                }}
              >
                <span>
                  Top {rows.length}
                  {rows.length === DROPDOWN_LIMIT ? '+' : ''} match
                  {rows.length === 1 ? '' : 'es'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                  Enter for full results
                </span>
              </div>
              <Col gap={0}>
                {rows.map((r) => {
                  if (!r.channel) return null;
                  const profilePic = r.channel.metadata.profile_image_url as string | undefined;
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
                              {r.matched_field === 'title' ? 'in title' : 'channel'}
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
                            {fmtRelative(r.last_seen)}
                          </span>
                        </Col>
                      </div>
                    </Link>
                  );
                })}
              </Col>
            </>
          )}

          {/* Pinned actions: Ask AI (when wired) + full search results.
              Always in the same order/place so muscle memory forms. */}
          {askable && (
            <button
              type="button"
              onClick={() => submitAsk(query)}
              disabled={ask?.pending}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: 'none',
                borderTop: '1px solid var(--border-faint)',
                background: questionish
                  ? 'color-mix(in oklab, var(--info) 8%, transparent)'
                  : 'transparent',
                color: 'var(--info)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-sunken)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = questionish
                  ? 'color-mix(in oklab, var(--info) 8%, transparent)'
                  : 'transparent';
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <IconSparkle size={12} />
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  Ask AI: &ldquo;{query.trim()}&rdquo;
                </span>
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)', flexShrink: 0 }}>
                ⌘⏎
              </span>
            </button>
          )}
          {rows !== null && rows.length > 0 && (
            <button
              type="button"
              onClick={() => submitSearch(query)}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: 'none',
                borderTop: '1px solid var(--border-faint)',
                background: 'transparent',
                color: 'var(--red)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-sunken)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              See all matches for &ldquo;{query.trim()}&rdquo; →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline three-dot shimmer shown while an Ask question is compiling. */
function PendingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }} aria-label="Thinking…">
      <style>{`@keyframes discoverAskDotPulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }`}</style>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--fg-muted)',
            animation: `discoverAskDotPulse 1.1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </span>
  );
}
