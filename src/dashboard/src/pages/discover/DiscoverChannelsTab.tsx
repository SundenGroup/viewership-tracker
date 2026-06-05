import { useEffect, useMemo, useState } from 'react';
import * as api from '@/services/api';
import { Row, Section, IconFilter } from '@/components/design';
import { LeaderboardTable, type LeaderboardRow } from './DiscoverDetailPage';

const POLL_INTERVAL_MS = 30_000;
type PlatformFilter = 'all' | 'twitch' | 'kick';
type DateMode = 'now' | '24h' | '7d' | 'custom';
type SortKey = 'ccv' | 'lang';

const PAGE_SIZE = 50;

export function DiscoverChannelsTab({ slug }: { slug: string }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [lang, setLang] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('ccv');
  const [dateMode, setDateMode] = useState<DateMode>('now');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [page, setPage] = useState(0);
  const [rangeLangOptions, setRangeLangOptions] = useState<string[]>([]);

  // Resolve the [from, to] window for range modes. Returns null for 'now'
  // (live mode) or an incomplete custom selection.
  const range = useMemo<{ from: Date; to: Date } | null>(() => {
    if (dateMode === 'now') return null;
    const now = new Date();
    if (dateMode === '24h') return { from: new Date(now.getTime() - 24 * 3600_000), to: now };
    if (dateMode === '7d') return { from: new Date(now.getTime() - 7 * 24 * 3600_000), to: now };
    // custom: full days, local time
    if (!fromDate || !toDate) return null;
    const from = new Date(`${fromDate}T00:00:00`);
    const to = new Date(`${toDate}T23:59:59`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
    return { from, to };
  }, [dateMode, fromDate, toDate]);

  const rangeKey = range ? `${range.from.toISOString()}|${range.to.toISOString()}` : 'now';

  // Reset to page 1 whenever the range or a server-side filter changes.
  useEffect(() => {
    setPage(0);
  }, [rangeKey, lang, platform]);

  // Range mode: load the full language list for the dropdown (independent of
  // the active language filter, which is now applied server-side).
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    api
      .getGameTrackerBreakdown(slug, range.from, range.to)
      .then((b) => {
        if (cancelled) return;
        setRangeLangOptions(
          b.language.map((l) => l.language?.toLowerCase()).filter((x): x is string => !!x).sort(),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, rangeKey, range]);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    if (!range) {
      // Live "active now" leaderboard — polls; filters applied client-side.
      const refresh = () =>
        api
          .getGameTrackerLeaderboard(slug, undefined, 200)
          .then((r) => !cancelled && setRows(r))
          .catch((err: Error) => !cancelled && setError(err.message));
      refresh();
      const handle = setInterval(refresh, POLL_INTERVAL_MS);
      return () => {
        cancelled = true;
        clearInterval(handle);
      };
    }

    // Range mode — server-side language/platform filters + offset pagination,
    // ranked by peak CCV over the window. Map to the live-row shape for the
    // shared table.
    setRows(null);
    api
      .getGameTrackerRangeLeaderboard(slug, range.from, range.to, PAGE_SIZE, {
        language: lang !== 'all' ? lang : undefined,
        platform: platform !== 'all' ? platform : undefined,
        offset: page * PAGE_SIZE,
      })
      .then((res) => {
        if (cancelled) return;
        setRows(
          res.rows.map((r) => ({
            channel_id: r.channel_id,
            concurrent_viewers: r.peak_ccv,
            stream_title: null,
            platform: r.platform,
            language: r.language,
            timestamp: '',
            channel: r.channel,
            minutes_live: r.minutes_live,
            days_streamed: r.days_streamed,
          })),
        );
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [slug, rangeKey, range, lang, platform, page]);

  // Language dropdown options: full range list in range mode; derived from the
  // live set otherwise.
  const languages = useMemo(() => {
    if (range) return rangeLangOptions;
    const set = new Set<string>();
    for (const r of rows ?? []) if (r.language) set.add(r.language.toLowerCase());
    return [...set].sort();
  }, [range, rangeLangOptions, rows]);

  // Live mode filters client-side; range mode is already filtered server-side.
  // Sort is applied client-side either way (reorders the current page).
  const filtered = useMemo(() => {
    let out = rows ?? [];
    if (!range) {
      out = out.filter(
        (r) =>
          (platform === 'all' || r.platform === platform) &&
          (lang === 'all' || (r.language?.toLowerCase() ?? '') === lang),
      );
    }
    out = [...out].sort((a, b) => {
      if (sort === 'lang') {
        const la = a.language?.toLowerCase() ?? '~';
        const lb = b.language?.toLowerCase() ?? '~';
        if (la !== lb) return la.localeCompare(lb);
        return b.concurrent_viewers - a.concurrent_viewers;
      }
      return b.concurrent_viewers - a.concurrent_viewers;
    });
    return out;
  }, [rows, platform, lang, sort, range]);

  const hasNextPage = !!range && (rows?.length ?? 0) === PAGE_SIZE;

  return (
    <Section
      title="All channels"
      eyebrow={range ? 'OVER RANGE' : 'ACTIVE NOW'}
      compact
      right={
        <Row gap={6} align="center">
          <span
            className="eyebrow"
            style={{ fontSize: 10, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <IconFilter size={11} />
            Platform
          </span>
          {(['all', 'twitch', 'kick'] as const).map((p) => (
            <Pill key={p} active={platform === p} onClick={() => setPlatform(p)}>
              {p}
            </Pill>
          ))}
          <span style={{ fontSize: 11, color: 'var(--fg-dim)', marginLeft: 6 }}>
            {range ? `${filtered.length} on page ${page + 1}` : `${filtered.length} live`}
          </span>
        </Row>
      }
    >
      {/* Toolbar: date range + language + sort */}
      <Row gap={14} align="center" style={{ flexWrap: 'wrap' }}>
        <Row gap={6} align="center">
          <span className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
            When
          </span>
          {(['now', '24h', '7d', 'custom'] as const).map((d) => (
            <Pill key={d} active={dateMode === d} onClick={() => setDateMode(d)}>
              {d === 'now' ? 'Now' : d === 'custom' ? 'Custom' : d}
            </Pill>
          ))}
          {dateMode === 'custom' && (
            <Row gap={4} align="center">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={dateInputStyle}
              />
              <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>→</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={dateInputStyle}
              />
            </Row>
          )}
        </Row>

        <Row gap={6} align="center">
          <span className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
            Language
          </span>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            style={dateInputStyle}
          >
            <option value="all">All</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </Row>

        <Row gap={6} align="center">
          <span className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
            Sort
          </span>
          <Pill active={sort === 'ccv'} onClick={() => setSort('ccv')}>
            CCV
          </Pill>
          <Pill active={sort === 'lang'} onClick={() => setSort('lang')}>
            Lang
          </Pill>
        </Row>
      </Row>

      {dateMode === 'custom' && !range && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          Pick a start and end date to load the range.
        </div>
      )}
      {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}

      {/* Table sits within the section padding (no edge bleed) so its left
          and right line up with the header + the rest of the page — matching
          the Live/overview leaderboard. */}
      <LeaderboardTable
        rows={filtered}
        trackerSlug={slug}
        metricLabel={range ? 'Peak CCV' : 'Live CCV'}
        showRangeStats={!!range}
      />

      {/* Pagination — range mode only (live "now" is a single small set). */}
      {range && (page > 0 || hasNextPage) && (
        <Row gap={10} align="center" justify="center">
          {page > 0 && (
            <Pill active={false} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ‹ Prev
            </Pill>
          )}
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Page {page + 1}</span>
          {hasNextPage && (
            <Pill active={false} onClick={() => setPage((p) => p + 1)}>
              Next ›
            </Pill>
          )}
        </Row>
      )}
    </Section>
  );
}

const dateInputStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-sunken)',
  color: 'var(--fg)',
};

function Pill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
        background: active
          ? 'var(--red-wash, color-mix(in oklab, var(--red) 12%, transparent))'
          : 'var(--bg-sunken)',
        color: active ? 'var(--red)' : 'var(--fg-muted)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
