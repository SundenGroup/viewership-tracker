/**
 * YouTube gating review queue (admin only).
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * YouTube can't tell us which game a stream belongs to — topicDetails
 * returns the same generic topics for PUBG PC and PUBG Mobile. So the
 * poller routes every unknown channel here instead of guessing, and one
 * click records a decision that sticks forever.
 *
 * Pending channels are NOT being counted while they sit here. That's the
 * point: silence beats a wrong number.
 */

import { useCallback, useEffect, useState } from 'react';
import * as api from '@/services/api';
import {
  Row,
  Col,
  Section,
  RangePill,
  TableScroll,
  thStyle,
  tdStyle,
  numTdStyle,
  IconExternal,
} from '@/components/design';
import { fmtCompact, fmtRelative } from '@/design/format';

type Tab = api.YouTubeGatingDecision;

export function DiscoverYouTubeGating({ slug }: { slug: string }) {
  const [tab, setTab] = useState<Tab>('pending');
  const [data, setData] = useState<api.YouTubeGatingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getYouTubeGating(slug, tab));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gating queue');
    }
  }, [slug, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (channelIdentifier: string, decision: 'allow' | 'deny' | 'reset') => {
    setBusy(channelIdentifier);
    try {
      await api.decideYouTubeGating(slug, channelIdentifier, decision);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts ?? { allow: 0, deny: 0, pending: 0 };
  const cfg = data?.config ?? {};

  return (
    <Section
      title="YouTube channel review"
      eyebrow="GATING"
      right={
        <Row gap={6} align="center" wrap>
          {(['pending', 'allow', 'deny'] as Tab[]).map((t) => (
            <RangePill key={t} active={tab === t} onClick={() => setTab(t)}>
              {t === 'pending' ? `Review ${counts.pending}` : `${t} ${counts[t]}`}
            </RangePill>
          ))}
        </Row>
      }
    >
      {!data?.enabled && (
        <div style={{ fontSize: 12, color: 'var(--warn)' }}>
          YouTube tracking is off for this tracker — decisions here take effect once it's enabled.
        </div>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
        YouTube doesn't say which game a stream is playing, so channels wait here until you
        decide. <b>Pending channels are not counted</b> in this tracker's numbers.
        {(cfg.include?.length || cfg.exclude?.length) && (
          <>
            {' '}Rules —{' '}
            {cfg.include?.length ? <>title must contain <b>{cfg.include.join(', ')}</b></> : null}
            {cfg.include?.length && cfg.exclude?.length ? '; ' : ''}
            {cfg.exclude?.length ? <>auto-denied if it contains <b>{cfg.exclude.join(', ')}</b></> : null}
            .
          </>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}

      {data && data.rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '10px 0' }}>
          {tab === 'pending'
            ? 'Nothing waiting for review.'
            : `No ${tab === 'allow' ? 'allowed' : 'denied'} channels yet.`}
        </div>
      )}

      {data && data.rows.length > 0 && (
        <TableScroll>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={thStyle}>Channel</th>
                <th style={thStyle}>Last seen streaming</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 90 }}>Peak seen</th>
                <th style={{ ...thStyle, width: 96 }}>Seen</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 170 }}>Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
                  <td style={tdStyle}>
                    <Col gap={2} style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{r.display_name ?? r.channel_identifier}</span>
                      <a
                        href={`https://www.youtube.com/channel/${r.channel_identifier}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mono"
                        style={{
                          fontSize: 10.5,
                          color: 'var(--fg-dim)',
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        {r.channel_identifier} <IconExternal size={10} />
                      </a>
                    </Col>
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--fg-muted)', maxWidth: 340 }}>
                    <div
                      title={r.sample_title ?? ''}
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {r.sample_video_id ? (
                        <a
                          href={`https://www.youtube.com/watch?v=${r.sample_video_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'inherit' }}
                        >
                          {r.sample_title ?? '—'}
                        </a>
                      ) : (
                        r.sample_title ?? '—'
                      )}
                    </div>
                    {r.reason && (
                      <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>{r.reason}</div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, ...numTdStyle }}>{fmtCompact(r.sample_ccv ?? 0)}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: 'var(--fg-dim)' }}>
                    {r.last_seen_at ? fmtRelative(r.last_seen_at) : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <Row gap={6} justify="flex-end">
                      {r.decision !== 'allow' && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy === r.channel_identifier}
                          onClick={() => void decide(r.channel_identifier, 'allow')}
                          style={{ cursor: 'pointer', color: 'var(--live)' }}
                        >
                          Track
                        </button>
                      )}
                      {r.decision !== 'deny' && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy === r.channel_identifier}
                          onClick={() => void decide(r.channel_identifier, 'deny')}
                          style={{ cursor: 'pointer', color: 'var(--danger)' }}
                        >
                          Exclude
                        </button>
                      )}
                      {r.decision !== 'pending' && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy === r.channel_identifier}
                          onClick={() => void decide(r.channel_identifier, 'reset')}
                          style={{ cursor: 'pointer' }}
                          title={r.decided_by ? `Decided by ${r.decided_by}` : undefined}
                        >
                          Undo
                        </button>
                      )}
                    </Row>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}
