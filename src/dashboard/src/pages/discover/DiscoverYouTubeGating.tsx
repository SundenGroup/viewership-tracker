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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<api.YouTubeTrackerConfig>({});
  const [saving, setSaving] = useState(false);

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

  const decide = async (
    channelIdentifier: string,
    decision: 'allow' | 'deny' | 'reset',
    scope: api.YouTubeGatingScope = 'matching',
  ) => {
    setBusy(channelIdentifier);
    try {
      await api.decideYouTubeGating(slug, channelIdentifier, decision, undefined, scope);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts ?? { allow: 0, deny: 0, pending: 0 };
  const cfg = data?.config ?? {};

  const openEditor = () => {
    setDraft({ ...cfg });
    setEditing(true);
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      await api.saveYouTubeConfig(slug, draft);
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save rules');
    } finally {
      setSaving(false);
    }
  };

  /** Comma-separated field ⇄ string[]. Splitting on save keeps typing free. */
  const listField = (
    key: 'include' | 'strongPhrases' | 'strongTags' | 'exclude' | 'queries',
    label: string,
    hint: string,
  ) => (
    <div key={key}>
      <label style={lbl}>{label}</label>
      <input
        type="text"
        value={(draft[key] ?? []).join(', ')}
        onChange={(e) =>
          setDraft((d) => ({ ...d, [key]: e.target.value.split(',').map((v) => v.trim()) }))
        }
        style={inp}
      />
      <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: 3 }}>{hint}</div>
    </div>
  );

  const numField = (
    key: 'autoAllowWeakBelowCcv' | 'alwaysReviewAboveCcv' | 'discoveryIntervalSeconds' | 'maxRoster',
    label: string,
    hint: string,
  ) => (
    <div key={key}>
      <label style={lbl}>{label}</label>
      <input
        type="number"
        value={draft[key] ?? ''}
        onChange={(e) =>
          setDraft((d) => ({
            ...d,
            [key]: e.target.value === '' ? undefined : Number(e.target.value),
          }))
        }
        style={inp}
      />
      <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: 3 }}>{hint}</div>
    </div>
  );

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
          <RangePill active={editing} onClick={() => (editing ? setEditing(false) : openEditor())}>
            {editing ? 'Close rules' : 'Edit rules'}
          </RangePill>
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
        <br />
        <b>Track matching</b> — a variety streamer: only counts their streams whose title
        matches this game. <b>Track all</b> — a dedicated channel (an org or tournament
        channel): counts everything they stream in Gaming.
        {!editing && (cfg.include?.length || cfg.exclude?.length) ? (
          <>
            {' '}Matching on{' '}
            <b>{[...(cfg.strongPhrases ?? []), ...(cfg.strongTags ?? []), ...(cfg.include ?? [])].join(', ')}</b>
            {cfg.exclude?.length ? <> · dropped if the title says <b>{cfg.exclude.join(', ')}</b></> : null}
            .
          </>
        ) : null}
      </div>

      {editing && (
        <div
          className="card"
          style={{ padding: 14, display: 'grid', gap: 12, background: 'var(--bg-sunken)' }}
        >
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            These lists <b>are</b> the gating rules. A stream from a “Track matching” channel counts
            only when its title contains one of these terms, so adding an event name here (a new
            tournament, a new abbreviation) is how you keep that channel's coverage current.
            Comma-separated.
          </div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            {listField('include', 'Include', 'Names and abbreviations for this game — the main matching list')}
            {listField('strongPhrases', 'Strong phrases', 'Distinctive enough to auto-approve an unknown channel')}
            {listField('strongTags', 'Strong tags', 'Exact creator tags — corroborate identity, never the stream')}
            {listField('exclude', 'Exclude', 'In the title → dropped, even from an approved channel')}
            {listField('queries', 'Discovery searches', 'What we search YouTube Live for (free, no quota)')}
          </div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            {numField('autoAllowWeakBelowCcv', 'Auto-allow below', 'Weak matches under this CCV skip review (0 = review everything)')}
            {numField('alwaysReviewAboveCcv', 'Always review above', 'Above this CCV a human confirms, however strong the match')}
            {numField('discoveryIntervalSeconds', 'Discovery every (s)', 'Live-search scrape cadence — 120s floor')}
            {numField('maxRoster', 'Max roster', 'Ceiling on streams polled per cycle')}
          </div>
          <Row gap={8}>
            <button
              type="button"
              className="btn btn-xs"
              disabled={saving}
              onClick={() => void saveConfig()}
              style={{ cursor: 'pointer', color: 'var(--live)' }}
            >
              {saving ? 'Saving…' : 'Save rules'}
            </button>
            <button
              type="button"
              className="btn btn-xs"
              disabled={saving}
              onClick={() => setEditing(false)}
              style={{ cursor: 'pointer' }}
            >
              Cancel
            </button>
          </Row>
        </div>
      )}

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
                <th style={{ ...thStyle, textAlign: 'right', width: 240 }}>Decision</th>
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
                    {r.decision === 'allow' && (
                      <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                        tracking {r.scope === 'all' ? 'all their streams' : 'matching streams only'}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, ...numTdStyle }}>{fmtCompact(r.sample_ccv ?? 0)}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: 'var(--fg-dim)' }}>
                    {r.last_seen_at ? fmtRelative(r.last_seen_at) : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <Row gap={6} justify="flex-end">
                      {!(r.decision === 'allow' && r.scope === 'matching') && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy === r.channel_identifier}
                          onClick={() => void decide(r.channel_identifier, 'allow', 'matching')}
                          style={{ cursor: 'pointer', color: 'var(--live)' }}
                          title="Count only this channel's streams that match this game — use for variety streamers"
                        >
                          Track matching
                        </button>
                      )}
                      {!(r.decision === 'allow' && r.scope === 'all') && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy === r.channel_identifier}
                          onClick={() => void decide(r.channel_identifier, 'allow', 'all')}
                          style={{ cursor: 'pointer', color: 'var(--live)' }}
                          title="Count everything this channel streams in Gaming — use for an org or tournament channel that only broadcasts this game"
                        >
                          Track all
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

const lbl: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 4,
};

const inp: React.CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  fontSize: 12.5,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
};
