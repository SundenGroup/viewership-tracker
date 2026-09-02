/**
 * YouTube review queue (editors).
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * YouTube can't tell us which game a stream belongs to — topicDetails
 * returns the same generic topics for PUBG PC and PUBG Mobile. So the
 * poller routes every unknown channel here instead of guessing, and one
 * click records a decision that sticks forever.
 *
 * Pending channels are NOT being counted while they sit here — silence
 * beats a wrong number. But they ARE being recorded: the poller banks
 * their viewership in a quarantine table, and approving a channel
 * backfills it retroactively (denying discards it).
 *
 * The queue is paged and filtered server-side (195 pending rows used to
 * be one endless list), rows can be ticked for a bulk decision, and a
 * reason filter doubles as "apply to everyone with this reason".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  stickyThStyle,
  IconExternal,
  LoadingBlock,
  SegmentedControl,
} from '@/components/design';
import { fmtCompact, fmtRelative } from '@/design/format';

/** Distinct minutes of banked viewership → "3h 12m" / "42m". */
const fmtHeldMinutes = (min: number): string =>
  min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;

type Tab = api.YouTubeGatingDecision;
type SortCol = 'ccv' | 'seen' | 'name';
const PAGE_SIZE = 50;
const HELP_KEY = 'discover_review_help_open';

function SortTh({
  col,
  sort,
  onSort,
  children,
  align = 'left',
  width,
  sticky,
}: {
  col: SortCol;
  sort: SortCol;
  onSort: (col: SortCol) => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  width?: number;
  sticky?: boolean;
}) {
  const active = sort === col;
  return (
    <th style={{ ...thStyle, ...(sticky ? stickyThStyle : {}), textAlign: align, ...(width ? { width } : {}) }}>
      <button
        type="button"
        onClick={() => onSort(col)}
        title={`Sort by ${typeof children === 'string' ? children.toLowerCase() : 'this column'}`}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: active ? 'var(--fg)' : 'inherit',
          font: 'inherit',
          letterSpacing: 'inherit',
          textTransform: 'inherit',
        }}
      >
        {children}
        <span aria-hidden style={{ fontSize: 9, opacity: active ? 1 : 0.35 }}>
          {active ? (col === 'name' ? '▲' : '▼') : '▾'}
        </span>
      </button>
    </th>
  );
}

export function DiscoverYouTubeGating({
  slug,
  expanded = true,
  onExpand,
  onChanged,
}: {
  slug: string;
  /** False on the Channels tab — collapses to a one-line nudge. */
  expanded?: boolean;
  onExpand?: () => void;
  /** Called with the pending count after every load so the tab badge stays right. */
  onChanged?: (pending: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [reason, setReason] = useState<string>('');
  const [minCcv, setMinCcv] = useState<number>(0);
  const [sort, setSort] = useState<SortCol>('ccv');
  const [data, setData] = useState<api.YouTubeGatingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<api.YouTubeTrackerConfig>({});
  const [saving, setSaving] = useState(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HELP_KEY) !== '0';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);

  // Filters change → back to page 1, selection cleared.
  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [tab, debouncedQ, reason, minCcv, sort]);

  const load = useCallback(async () => {
    try {
      const res = await api.getYouTubeGating(slug, tab, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        q: debouncedQ || undefined,
        reason: reason || undefined,
        minCcv: minCcv || undefined,
        sort,
      });
      setData(res);
      setError(null);
      onChanged?.(res.counts.pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the review queue');
    }
  }, [slug, tab, page, debouncedQ, reason, minCcv, sort, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const settlementNotice = (res: api.YouTubeGatingRow & api.YouTubeGatingSettlement) => {
    if (res.promoted && res.promoted.promoted > 0) {
      return (
        `Backfilled ${fmtHeldMinutes(res.promoted.minutes)} of held viewership retroactively` +
        (res.promoted.skipped > 0 ? `; ${res.promoted.skipped} non-matching held rows discarded.` : '.')
      );
    }
    if (res.promoted && res.promoted.skipped > 0) {
      return (
        `None of the held streams matched this game's vocabulary: ${res.promoted.skipped} held rows discarded. ` +
        `If that title should count, add its wording to the matching rules.`
      );
    }
    if ((res.discarded_snapshots ?? 0) > 0) {
      return `Discarded the viewership held for this channel (${res.discarded_snapshots} rows).`;
    }
    return null;
  };

  const decide = async (
    channelIdentifier: string,
    decision: 'allow' | 'deny' | 'reset',
    scope: api.YouTubeGatingScope = 'matching',
  ) => {
    setBusy(channelIdentifier);
    setNotice(null);
    try {
      const res = await api.decideYouTubeGating(slug, channelIdentifier, decision, undefined, scope);
      await load();
      if (res && typeof res === 'object' && !('ok' in res)) {
        if (res.promotion_error) setError(res.promotion_error);
        else setNotice(settlementNotice(res));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  const bulk = async (
    decision: 'allow' | 'deny' | 'reset',
    scope: api.YouTubeGatingScope,
    target: { channelIdentifiers?: string[]; reason?: string },
  ) => {
    setBusy('bulk');
    setNotice(null);
    setArmed(null);
    try {
      const res = await api.bulkDecideYouTubeGating(slug, {
        decision,
        scope,
        channelIdentifiers: target.channelIdentifiers,
        reason: target.reason,
        fromDecision: tab,
      });
      setSelected(new Set());
      await load();
      const failed = res.results.filter((r) => !r.ok || r.promotion_error);
      setNotice(
        `${decision === 'reset' ? 'Reset' : decision === 'allow' ? 'Now tracking' : 'Excluded'} ${res.applied} of ${res.total} channel${res.total === 1 ? '' : 's'}` +
          (failed.length > 0 ? `; ${failed.length} need a look (see server logs).` : '.'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk decision failed');
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts ?? { allow: 0, deny: 0, pending: 0 };
  const cfg = data?.config ?? {};
  const rows = data?.rows ?? [];
  const total = data?.total ?? rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const reasons = data?.reasons ?? [];
  const reasonCount = useMemo(
    () => reasons.find((r) => r.reason === reason)?.count ?? 0,
    [reasons, reason],
  );
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.channel_identifier));

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) rows.forEach((r) => next.delete(r.channel_identifier));
      else rows.forEach((r) => next.add(r.channel_identifier));
      return next;
    });
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  // On the Channels tab the queue is a one-line marker — an unworked queue
  // is silently uncounted viewership, so it must stay findable.
  if (!expanded) {
    if (counts.pending === 0) return null;
    return (
      <button
        type="button"
        onClick={onExpand}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          padding: '9px 12px',
          fontSize: 12,
          cursor: 'pointer',
          borderRadius: 8,
          color: 'var(--fg-muted)',
          background: 'var(--bg-sunken)',
          border: '1px solid var(--border)',
        }}
      >
        <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{counts.pending}</span>
        YouTube {counts.pending === 1 ? 'channel is' : 'channels are'} waiting for review, not
        being counted until you decide.
        <span style={{ marginLeft: 'auto', color: 'var(--red)', fontWeight: 500 }}>Open the Review tab →</span>
      </button>
    );
  }

  const bulkButtons = (target: { channelIdentifiers?: string[]; reason?: string }, n: number, key: string) => (
    <Row gap={6} align="center" wrap>
      {tab !== 'allow' && (
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy != null}
          onClick={() => void bulk('allow', 'matching', target)}
          style={{ cursor: 'pointer', color: 'var(--live)' }}
          title="Count only the streams whose title matches this game"
        >
          Track matching · {n}
        </button>
      )}
      <button
        type="button"
        className="btn btn-xs"
        disabled={busy != null}
        onClick={() => void bulk('allow', 'all', target)}
        style={{ cursor: 'pointer', color: 'var(--live)' }}
        title="Count everything these channels stream in Gaming"
      >
        Track all · {n}
      </button>
      {tab !== 'deny' && (
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy != null}
          onClick={() => {
            if (armed === key) void bulk('deny', 'matching', target);
            else {
              setArmed(key);
              setTimeout(() => setArmed((a) => (a === key ? null : a)), 4000);
            }
          }}
          style={{ cursor: 'pointer', color: 'var(--danger)' }}
        >
          {armed === key ? `Click again to exclude ${n}` : `Exclude · ${n}`}
        </button>
      )}
      {tab !== 'pending' && (
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy != null}
          onClick={() => void bulk('reset', 'matching', target)}
          style={{ cursor: 'pointer' }}
        >
          Undo · {n}
        </button>
      )}
    </Row>
  );

  return (
    <Section
      title="YouTube channel review"
      eyebrow="Review queue"
      right={
        <Row gap={8} align="center" wrap>
          <SegmentedControl
            ariaLabel="Decision bucket"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pending', label: `Pending · ${counts.pending}` },
              { value: 'allow', label: `Tracked · ${counts.allow}` },
              { value: 'deny', label: `Excluded · ${counts.deny}` },
            ]}
          />
          <RangePill active={editing} onClick={() => (editing ? setEditing(false) : openEditor())}>
            {editing ? 'Close rules' : 'Edit rules'}
          </RangePill>
        </Row>
      }
    >
      {!data?.enabled && data && (
        <div style={{ fontSize: 12, color: 'var(--warn)' }}>
          YouTube tracking is off for this tracker. Decisions here take effect once it's enabled.
        </div>
      )}

      <details
        open={helpOpen}
        onToggle={(e) => {
          const open = (e.currentTarget as HTMLDetailsElement).open;
          setHelpOpen(open);
          try {
            localStorage.setItem(HELP_KEY, open ? '1' : '0');
          } catch {
            /* private mode */
          }
        }}
        style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}
      >
        <summary style={{ cursor: 'pointer', color: 'var(--fg)', fontWeight: 500, fontSize: 12 }}>
          How review works
        </summary>
        <div style={{ marginTop: 6 }}>
          YouTube doesn't say which game a stream is playing, so channels wait here until you decide.
          Pending channels are not counted in this tracker's numbers, but their viewership is banked
          while they wait: approving counts it retroactively from the moment they appeared, excluding
          discards it. Holds are kept while a channel keeps appearing; a channel not seen for 14 days
          loses them.
          <br />
          <b>Track matching</b> is for a variety streamer: only their streams whose title matches this
          game count. <b>Track all</b> is for a dedicated channel (an org or a tournament channel):
          everything they stream in Gaming counts.
          {!editing && (cfg.include?.length || cfg.exclude?.length) ? (
            <>
              {' '}
              Matching on{' '}
              <b>{[...(cfg.strongPhrases ?? []), ...(cfg.strongTags ?? []), ...(cfg.include ?? [])].join(', ')}</b>
              {cfg.exclude?.length ? <> · dropped if the title says <b>{cfg.exclude.join(', ')}</b></> : null}.
            </>
          ) : null}
        </div>
      </details>

      {editing && (
        <div className="card" style={{ padding: 14, display: 'grid', gap: 12, background: 'var(--bg-sunken)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            These lists <b>are</b> the gating rules. A stream from a “Track matching” channel counts
            only when its title contains one of these terms, so adding an event name here (a new
            tournament, a new abbreviation) is how you keep that channel's coverage current.
            Comma-separated.
          </div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            {listField('include', 'Include', 'Names and abbreviations for this game. The main matching list')}
            {listField('strongPhrases', 'Strong phrases', 'Distinctive enough to auto-approve an unknown channel')}
            {listField('strongTags', 'Strong tags', 'Exact creator tags: corroborate identity, never the stream')}
            {listField('exclude', 'Exclude', 'In the title → dropped, even from an approved channel')}
            {listField('queries', 'Discovery searches', 'What we search YouTube Live for (free, no quota)')}
          </div>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            {numField('autoAllowWeakBelowCcv', 'Auto-allow below', 'Weak matches under this CCV skip review (0 = review everything)')}
            {numField('alwaysReviewAboveCcv', 'Always review above', 'Above this CCV a human confirms, however strong the match')}
            {numField('discoveryIntervalSeconds', 'Discovery every (s)', 'Live-search scrape cadence: 120s floor')}
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
            <button type="button" className="btn btn-xs" disabled={saving} onClick={() => setEditing(false)} style={{ cursor: 'pointer' }}>
              Cancel
            </button>
          </Row>
        </div>
      )}

      {/* Filters: search · reason cluster · minimum peak */}
      <Row gap={10} align="center" wrap>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search channel or title"
          aria-label="Search the queue"
          style={{ ...inp, width: 220, padding: '5px 10px', borderRadius: 999 }}
        />
        <select
          className="pill-select"
          data-active={reason !== ''}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
          style={{ maxWidth: 360, textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-sans)' }}
        >
          <option value="">All reasons</option>
          {reasons.map((r) => (
            <option key={r.reason} value={r.reason}>
              {r.reason} ({r.count})
            </option>
          ))}
        </select>
        <select
          className="pill-select"
          data-active={minCcv > 0}
          value={minCcv}
          onChange={(e) => setMinCcv(Number(e.target.value))}
          aria-label="Minimum peak seen"
        >
          <option value={0}>Any size</option>
          <option value={100}>100+ peak</option>
          <option value={500}>500+ peak</option>
          <option value={2000}>2,000+ peak</option>
        </select>
        <span className="tabular" style={{ fontSize: 11, color: 'var(--fg-dim)', marginLeft: 'auto' }}>
          {total.toLocaleString('en-US')} channel{total === 1 ? '' : 's'}
        </span>
      </Row>

      {/* Bulk bars: everything ticked, or everything sharing the chosen reason */}
      {selected.size > 0 && (
        <Row gap={10} align="center" wrap className="card" style={{ padding: '8px 12px', background: 'var(--bg-sunken)' }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{selected.size} selected</span>
          {bulkButtons({ channelIdentifiers: [...selected] }, selected.size, 'selected')}
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => setSelected(new Set())}
            style={{ cursor: 'pointer', marginLeft: 'auto' }}
          >
            Clear
          </button>
        </Row>
      )}
      {selected.size === 0 && reason !== '' && reasonCount > 0 && (
        <Row gap={10} align="center" wrap className="card" style={{ padding: '8px 12px', background: 'var(--bg-sunken)' }}>
          <span style={{ fontSize: 12 }}>
            Everyone with this reason: <b>{reasonCount}</b>
          </span>
          {bulkButtons({ reason }, reasonCount, 'reason')}
        </Row>
      )}

      {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
      {notice && <div style={{ fontSize: 12, color: 'var(--info)' }}>{notice}</div>}

      {!data && !error && <LoadingBlock minHeight={120} />}

      {data && rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '10px 0' }}>
          {q || reason || minCcv
            ? 'Nothing matches these filters.'
            : tab === 'pending'
              ? 'Nothing waiting for review.'
              : `No ${tab === 'allow' ? 'tracked' : 'excluded'} channels yet.`}
        </div>
      )}

      {data && rows.length > 0 && (
        <TableScroll>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...thStyle, ...stickyThStyle, width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    aria-label="Select every channel on this page"
                  />
                </th>
                <SortTh col="name" sort={sort} onSort={setSort} sticky>Channel</SortTh>
                <th style={{ ...thStyle, ...stickyThStyle }}>Sample stream</th>
                <SortTh col="ccv" sort={sort} onSort={setSort} align="right" width={90} sticky>
                  Peak seen
                </SortTh>
                <SortTh col="seen" sort={sort} onSort={setSort} width={104} sticky>
                  Last seen
                </SortTh>
                <th style={{ ...thStyle, ...stickyThStyle, textAlign: 'right', width: 250 }}>Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  style={{
                    borderBottom: '1px solid var(--border-faint)',
                    background: selected.has(r.channel_identifier) ? 'var(--bg-sunken)' : 'transparent',
                  }}
                >
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.channel_identifier)}
                      onChange={() => toggleOne(r.channel_identifier)}
                      aria-label={`Select ${r.display_name ?? r.channel_identifier}`}
                    />
                  </td>
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
                    <div title={r.sample_title ?? ''} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                    {r.reason && <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>{r.reason}</div>}
                    {r.decision === 'pending' && (r.held_minutes ?? 0) > 0 && (
                      <div
                        style={{ fontSize: 10.5, color: 'var(--info)' }}
                        title={
                          'Viewership recorded while this channel waits for review' +
                          (r.held_from ? ` (since ${new Date(r.held_from).toLocaleString()})` : '') +
                          '. Approve → counted retroactively. Exclude → discarded.'
                        }
                      >
                        {fmtHeldMinutes(r.held_minutes!)} of viewership banked: nothing lost while you decide
                      </div>
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
                    <Row gap={6} justify="flex-end" wrap>
                      {!(r.decision === 'allow' && r.scope === 'matching') && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy != null}
                          onClick={() => void decide(r.channel_identifier, 'allow', 'matching')}
                          style={{ cursor: 'pointer', color: 'var(--live)' }}
                          title="Count only this channel's streams that match this game. Use for variety streamers"
                        >
                          Track matching
                        </button>
                      )}
                      {!(r.decision === 'allow' && r.scope === 'all') && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy != null}
                          onClick={() => void decide(r.channel_identifier, 'allow', 'all')}
                          style={{ cursor: 'pointer', color: 'var(--live)' }}
                          title="Count everything this channel streams in Gaming. Use for an org or tournament channel that only broadcasts this game"
                        >
                          Track all
                        </button>
                      )}
                      {r.decision !== 'deny' && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy != null}
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
                          disabled={busy != null}
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

      {pageCount > 1 && (
        <Row gap={10} align="center" justify="center">
          {page > 0 && (
            <RangePill active={false} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ‹ Prev
            </RangePill>
          )}
          <span className="tabular" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Page {page + 1} of {pageCount} · {total.toLocaleString('en-US')} channels
          </span>
          {page + 1 < pageCount && (
            <RangePill active={false} onClick={() => setPage((p) => p + 1)}>
              Next ›
            </RangePill>
          )}
        </Row>
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
