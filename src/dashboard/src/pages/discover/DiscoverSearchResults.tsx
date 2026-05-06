import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '@/services/api';
import type { GameTrackerSearchRow } from '@/services/api';
import {
  Row,
  Col,
  Section,
  Pill,
  PlatformPip,
  ChannelNameWithLink,
  IconSearch,
  IconX,
} from '@/components/design';
import { fmtCompact } from '@/design/format';
import { Avatar } from './DiscoverDetailPage';

type SortKey = 'last_seen' | 'peak_ccv';

/**
 * Full-page search results for /discover/:slug?q=…
 *
 * Renders a Section with a results table — same row layout as the
 * leaderboard but with extra "matched on" labeling and last-seen
 * recency. Click a row → channel page.
 */
export function DiscoverSearchResults({ slug, query }: { slug: string; query: string }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<GameTrackerSearchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('last_seen');

  useEffect(() => {
    if (query.trim().length < 2) {
      setRows(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .searchGameTracker(slug, query.trim(), 30, 100)
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
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
  }, [slug, query]);

  const sortedRows = useMemo(() => {
    if (!rows) return null;
    const out = [...rows];
    if (sortKey === 'peak_ccv') {
      out.sort((a, b) => b.peak_ccv - a.peak_ccv);
    } else {
      out.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());
    }
    return out;
  }, [rows, sortKey]);

  const titleMatches = rows?.filter((r) => r.matched_field === 'title').length ?? 0;
  const channelMatches = rows?.filter((r) => r.matched_field === 'channel').length ?? 0;

  return (
    <Section
      title={
        <Row gap={8} align="baseline">
          <span style={{ fontSize: 18, fontWeight: 600 }}>
            <IconSearch size={14} />{' '}
            <span style={{ marginLeft: 6 }}>Results for &ldquo;{query}&rdquo;</span>
          </span>
        </Row>
      }
      eyebrow="SEARCH"
      right={
        <Row gap={8} align="center">
          {rows && (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {rows.length} match{rows.length === 1 ? '' : 'es'}
              {titleMatches > 0 && channelMatches > 0 && (
                <span style={{ color: 'var(--fg-dim)' }}>
                  {' '}
                  ({titleMatches} title, {channelMatches} channel)
                </span>
              )}
            </span>
          )}
          <button
            type="button"
            onClick={() => navigate(`/discover/${slug}`)}
            aria-label="Clear search"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              fontSize: 11,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
            }}
          >
            <IconX size={11} /> clear
          </button>
        </Row>
      }
      style={{ padding: 0 }}
    >
      {loading && rows === null && (
        <div style={{ padding: 24, color: 'var(--fg-muted)', fontSize: 13 }}>Searching…</div>
      )}
      {error && (
        <div style={{ padding: 24, color: 'var(--red)', fontSize: 13 }}>{error}</div>
      )}
      {sortedRows && sortedRows.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg-muted)' }}>
          No matches for &ldquo;{query}&rdquo; in the last 30 days.
        </div>
      )}
      {sortedRows && sortedRows.length > 0 && (
        <div style={{ margin: -16, marginTop: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...thStyle, width: 36 }}>#</th>
                <th style={{ ...thStyle, width: 56 }}></th>
                <th style={thStyle}>Channel</th>
                <th style={{ ...thStyle, width: 80 }}>Match</th>
                <th
                  style={{ ...thStyle, textAlign: 'right', width: 110, cursor: 'pointer' }}
                  onClick={() => setSortKey('peak_ccv')}
                >
                  Peak CCV {sortKey === 'peak_ccv' && '↓'}
                </th>
                <th
                  style={{ ...thStyle, textAlign: 'right', width: 100, cursor: 'pointer' }}
                  onClick={() => setSortKey('last_seen')}
                >
                  Last seen {sortKey === 'last_seen' && '↓'}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) => {
                if (!row.channel) return null;
                const profilePic = row.channel.metadata.profile_image_url as string | undefined;
                const ageMins = Math.floor((Date.now() - new Date(row.last_seen).getTime()) / 60_000);
                const onClick = () =>
                  navigate(`/discover/${slug}/channel/${row.channel_id}`);
                return (
                  <tr
                    key={row.channel_id}
                    onClick={onClick}
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
                      <PlatformPip id={row.channel.platform} size={12} />
                    </td>
                    <td style={tdStyle}>
                      <Row gap={10} align="center">
                        <Avatar
                          src={profilePic ?? null}
                          name={row.channel.display_name}
                          size={32}
                        />
                        <Col gap={2} style={{ minWidth: 0, flex: 1 }}>
                          <div onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                            <ChannelNameWithLink
                              name={row.channel.display_name}
                              platform={row.channel.platform}
                              channelIdentifier={row.channel.channel_identifier}
                            />
                          </div>
                          <div
                            title={row.stream_title ?? ''}
                            style={{
                              fontSize: 11,
                              color: 'var(--fg-dim)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 560,
                            }}
                          >
                            {row.stream_title ?? '—'}
                          </div>
                        </Col>
                      </Row>
                    </td>
                    <td style={tdStyle}>
                      <Pill tone={row.matched_field === 'title' ? 'red' : 'default'}>
                        {row.matched_field}
                      </Pill>
                    </td>
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
                      {fmtCompact(row.peak_ccv)}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        color: 'var(--fg-dim)',
                        fontSize: 11,
                      }}
                    >
                      {ageMins < 60
                        ? `${ageMins}m ago`
                        : ageMins < 60 * 24
                        ? `${Math.floor(ageMins / 60)}h ago`
                        : `${Math.floor(ageMins / (60 * 24))}d ago`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 6px',
  textAlign: 'left',
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const tdStyle: React.CSSProperties = {
  padding: '12px 6px',
};
