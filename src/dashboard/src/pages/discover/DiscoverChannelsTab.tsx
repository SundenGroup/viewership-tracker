import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/services/api';
import { Row, RangePill, Section, IconFilter, IconDownload } from '@/components/design';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { LeaderboardTable, FreshnessIndicator, type LeaderboardRow } from './DiscoverDetailPage';

const POLL_INTERVAL_MS = 30_000;
type PlatformFilter = 'all' | 'twitch' | 'kick' | 'youtube';
type DateMode = 'now' | '24h' | '7d' | 'custom';
type SortKey = 'ccv' | 'lang';

const PAGE_SIZE = 50;

export function DiscoverChannelsTab({ slug }: { slug: string }) {
  // Filters/pagination are mirrored into URL search params so views are
  // shareable — state initializes from the URL on mount, then a sync
  // effect below writes changes back (merging, never clobbering ?q/&tab).
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [platform, setPlatform] = useState<PlatformFilter>(() => {
    const p = searchParams.get('platform');
    return p === 'twitch' || p === 'kick' || p === 'youtube' ? p : 'all';
  });
  const [lang, setLang] = useState<string>(() => searchParams.get('language') ?? 'all');
  const [sort, setSort] = useState<SortKey>('ccv');
  const [dateMode, setDateMode] = useState<DateMode>(() => {
    const m = searchParams.get('mode');
    return m === '24h' || m === '7d' || m === 'custom' ? m : 'now';
  });
  const [fromDate, setFromDate] = useState<string>(() => searchParams.get('from') ?? '');
  const [toDate, setToDate] = useState<string>(() => searchParams.get('to') ?? '');
  const [page, setPage] = useState(() => {
    const raw = Number(searchParams.get('page') ?? '1');
    return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) - 1 : 0;
  });
  const [total, setTotal] = useState<number | null>(null);
  const [rangeLangOptions, setRangeLangOptions] = useState<string[]>([]);

  // State → URL (replace, merged) so pasted links reproduce the view.
  // Defaults are omitted to keep URLs clean; page is 1-based in the URL.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        const setOrDelete = (key: string, value: string | null) => {
          if (value === null || value === '') p.delete(key);
          else p.set(key, value);
        };
        setOrDelete('mode', dateMode === 'now' ? null : dateMode);
        setOrDelete('from', dateMode === 'custom' ? fromDate : null);
        setOrDelete('to', dateMode === 'custom' ? toDate : null);
        setOrDelete('platform', platform === 'all' ? null : platform);
        setOrDelete('language', lang === 'all' ? null : lang);
        setOrDelete('page', page > 0 ? String(page + 1) : null);
        return p;
      },
      { replace: true },
    );
    // setSearchParams intentionally omitted: re-running on param identity
    // changes would rewrite the URL in a loop for no state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateMode, fromDate, toDate, platform, lang, page]);

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

  // Reset to page 1 whenever the range or a server-side filter changes —
  // but not on mount, or it would clobber a page restored from the URL.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          .then((r) => {
            if (cancelled) return;
            setRows(r);
            setLastUpdatedAt(Date.now());
          })
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
        setTotal(typeof res.total === 'number' ? res.total : null);
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
            avg_ccv: r.avg_ccv,
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

  // Prefer the server total ("Page X of Y"); fall back to the page-full
  // heuristic when an older backend omits it.
  const pageCount = total != null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const hasNextPage = !!range && (pageCount != null ? page + 1 < pageCount : (rows?.length ?? 0) === PAGE_SIZE);

  // Export the rows as currently displayed (filters + sort applied).
  const exportCsv = () => {
    if (filtered.length === 0) return;
    if (range) {
      downloadCsv(
        `${slug}-channels-range-${csvStamp()}.csv`,
        ['rank', 'channel', 'platform', 'language', 'peak_ccv', 'avg_ccv', 'hours_live', 'days_streamed'],
        filtered.map((r, i) => [
          i + 1 + page * PAGE_SIZE,
          r.channel?.display_name ?? r.channel_id,
          r.platform,
          r.language,
          r.concurrent_viewers,
          r.avg_ccv,
          r.minutes_live != null ? (r.minutes_live / 60).toFixed(1) : null,
          r.days_streamed,
        ]),
      );
    } else {
      downloadCsv(
        `${slug}-channels-live-${csvStamp()}.csv`,
        ['rank', 'channel', 'platform', 'language', 'ccv', 'stream_title'],
        filtered.map((r, i) => [
          i + 1,
          r.channel?.display_name ?? r.channel_id,
          r.platform,
          r.language,
          r.concurrent_viewers,
          r.stream_title,
        ]),
      );
    }
  };

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
          {(['all', 'twitch', 'kick', 'youtube'] as const).map((p) => (
            <RangePill key={p} active={platform === p} onClick={() => setPlatform(p)}>
              {p}
            </RangePill>
          ))}
          <span style={{ fontSize: 11, color: 'var(--fg-dim)', marginLeft: 6 }}>
            {range ? `${filtered.length} on page ${page + 1}` : `${filtered.length} live`}
          </span>
          {!range && <FreshnessIndicator at={lastUpdatedAt} />}
          <button
            type="button"
            className="btn btn-xs"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            style={{ cursor: 'pointer', marginLeft: 4 }}
          >
            <IconDownload size={11} /> CSV
          </button>
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
            <RangePill key={d} active={dateMode === d} onClick={() => setDateMode(d)}>
              {d === 'now' ? 'Now' : d === 'custom' ? 'Custom' : d}
            </RangePill>
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
          <RangePill active={sort === 'ccv'} onClick={() => setSort('ccv')}>
            Viewers
          </RangePill>
          <RangePill active={sort === 'lang'} onClick={() => setSort('lang')}>
            Lang
          </RangePill>
        </Row>
      </Row>

      {dateMode === 'custom' && !range && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          Pick a start and end date to load the range.
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

      {/* Table sits within the section padding (no edge bleed) so its left
          and right line up with the header + the rest of the page — matching
          the Live/overview leaderboard. */}
      <LeaderboardTable
        rows={filtered}
        trackerSlug={slug}
        metricLabel={range ? 'Peak viewers' : 'Viewers'}
        showRangeStats={!!range}
      />

      {/* Pagination — range mode only (live "now" is a single small set). */}
      {range && (page > 0 || hasNextPage) && (
        <Row gap={10} align="center" justify="center">
          {page > 0 && (
            <RangePill active={false} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ‹ Prev
            </RangePill>
          )}
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Page {page + 1}{pageCount != null ? ` of ${pageCount}` : ''}
            {total != null ? ` · ${total} streamers` : ''}
          </span>
          {hasNextPage && (
            <RangePill active={false} onClick={() => setPage((p) => p + 1)}>
              Next ›
            </RangePill>
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
