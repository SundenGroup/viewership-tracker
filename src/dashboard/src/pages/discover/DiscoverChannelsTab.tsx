import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/services/api';
import {
  Row,
  RangePill,
  Section,
  IconDownload,
  RangeControl,
  LoadingBlock,
  EmptyState,
  SegmentedControl,
  resolveRange,
  parseRangeKey,
  type RangeKey,
} from '@/components/design';
import { downloadCsv, csvStamp } from '@/utils/csv';
import { RetentionNote } from '@/components/discover/RetentionNote';
import { LeaderboardTable, FreshnessIndicator, type LeaderboardRow } from './DiscoverDetailPage';
import { languageFullName } from '@/utils/formatters';

const POLL_INTERVAL_MS = 30_000;
type SortKey = 'ccv' | 'lang';

/** Every window this surface supports — shares the ?range vocabulary with Trends. */
const RANGE_CHOICES: RangeKey[] = ['now', '1h', '6h', '24h', '7d', '30d', 'custom'];

const PAGE_SIZE = 50;

export function DiscoverChannelsTab({
  slug,
  platform,
  retainRawDays,
}: {
  slug: string;
  /** Shared page-level filter (also drives Live + Trends). */
  platform: string;
  onPlatformChange?: (p: string) => void;
  /** Tracker's raw retention, for the note under long ranges. */
  retainRawDays?: number | null;
}) {
  // Filters/pagination are mirrored into URL search params so views are
  // shareable — state initializes from the URL on mount, then a sync
  // effect below writes changes back (merging, never clobbering ?q/&tab).
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const [lang, setLang] = useState<string>(() => searchParams.get('language') ?? 'all');
  const [sort, setSort] = useState<SortKey>('ccv');
  const [dateMode, setDateMode] = useState<RangeKey>(() =>
    // `mode` is the pre-unification param name — keep old links working.
    parseRangeKey(searchParams.get('range') ?? searchParams.get('mode'), RANGE_CHOICES, 'now'),
  );
  const [fromDate, setFromDate] = useState<string>(() => searchParams.get('from') ?? '');
  const [toDate, setToDate] = useState<string>(() => searchParams.get('to') ?? '');
  const [page, setPage] = useState(() => {
    const raw = Number(searchParams.get('page') ?? '1');
    return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) - 1 : 0;
  });
  const [total, setTotal] = useState<number | null>(null);
  const [langOptions, setLangOptions] = useState<string[]>([]);

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
        p.delete('mode'); // legacy param, superseded by ?range
        setOrDelete('range', dateMode === 'now' ? null : dateMode);
        setOrDelete('from', dateMode === 'custom' ? fromDate : null);
        setOrDelete('to', dateMode === 'custom' ? toDate : null);
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
  const range = useMemo(
    () => resolveRange(dateMode, fromDate, toDate),
    [dateMode, fromDate, toDate],
  );
  const rangeHours = range ? (range.to.getTime() - range.from.getTime()) / 3_600_000 : 0;

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

  // Language list for the dropdown, independent of the active filter:
  // the range's breakdown, or the last 24h when looking at "now".
  useEffect(() => {
    let cancelled = false;
    const to = range?.to ?? new Date();
    const from = range?.from ?? new Date(to.getTime() - 24 * 3_600_000);
    api
      .getGameTrackerBreakdown(slug, from, to)
      .then((b) => {
        if (cancelled) return;
        setLangOptions(
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
      // Live board — server-side platform/language filters + paging, so
      // every live channel is reachable (the plain call stops at 200).
      const refresh = () =>
        api
          .getGameTrackerLeaderboardPage(slug, {
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
            platform: platform !== 'all' ? platform : undefined,
            language: lang !== 'all' ? lang : undefined,
          })
          .then((r) => {
            if (cancelled) return;
            setRows(r.rows);
            setTotal(r.total);
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
            stream_title: r.peak_title,
            platform: r.platform,
            language: r.language,
            timestamp: '',
            channel: r.channel,
            minutes_live: r.minutes_live,
            days_streamed: r.days_streamed,
            avg_ccv: r.avg_ccv,
            // Period grade, not "last grade" — see rangeGradesFor().
            last_grade: r.range_grade,
            last_score: r.range_grade_score,
            grade_sessions: r.range_grade_sessions,
          })),
        );
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [slug, rangeKey, range, lang, platform, page]);

  // Filters are server-side in both modes; sort reorders the current page.
  const filtered = useMemo(() => {
    const out = [...(rows ?? [])];
    out.sort((a, b) => {
      if (sort === 'lang') {
        const la = a.language?.toLowerCase() ?? '~';
        const lb = b.language?.toLowerCase() ?? '~';
        if (la !== lb) return la.localeCompare(lb);
        return b.concurrent_viewers - a.concurrent_viewers;
      }
      return b.concurrent_viewers - a.concurrent_viewers;
    });
    return out;
  }, [rows, sort]);

  const pageCount = total != null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const hasNextPage = pageCount != null ? page + 1 < pageCount : (rows?.length ?? 0) === PAGE_SIZE;
  const hasFilters = platform !== 'all' || lang !== 'all';

  // Export the rows as currently displayed (filters + sort applied).
  const exportCsv = () => {
    if (filtered.length === 0) return;
    if (range) {
      downloadCsv(
        `${slug}-channels-range-${csvStamp()}.csv`,
        ['rank', 'channel', 'platform', 'language', 'peak_ccv', 'avg_ccv', 'hours_watched', 'hours_live', 'days_streamed'],
        filtered.map((r, i) => [
          i + 1 + page * PAGE_SIZE,
          r.channel?.display_name ?? r.channel_id,
          r.platform,
          r.language,
          r.concurrent_viewers,
          r.avg_ccv,
          // hours watched = avg CCV × airtime — the sum of everyone's minutes
          r.avg_ccv != null && r.minutes_live != null
            ? ((r.avg_ccv * r.minutes_live) / 60).toFixed(1)
            : null,
          r.minutes_live != null ? (r.minutes_live / 60).toFixed(1) : null,
          r.days_streamed,
        ]),
      );
    } else {
      downloadCsv(
        `${slug}-channels-live-${csvStamp()}.csv`,
        ['rank', 'channel', 'platform', 'language', 'ccv', 'stream_title'],
        filtered.map((r, i) => [
          i + 1 + page * PAGE_SIZE,
          r.channel?.display_name ?? r.channel_id,
          r.platform,
          r.language,
          r.concurrent_viewers,
          r.stream_title,
        ]),
      );
    }
  };

  const countLabel =
    total != null
      ? range
        ? `${total.toLocaleString('en-US')} streamers`
        : `${total.toLocaleString('en-US')} live${hasFilters ? ' with these filters' : ''}`
      : null;

  return (
    <Section
      title="All channels"
      eyebrow={range ? 'Over range' : 'Live now'}
      compact
      right={
        <Row gap={8} align="center">
          {countLabel && (
            <span className="tabular" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{countLabel}</span>
          )}
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
      {/* Toolbar: window · language · sort — one row, one vocabulary */}
      <Row gap={14} align="center" style={{ flexWrap: 'wrap' }}>
        <RangeControl
          options={RANGE_CHOICES}
          value={dateMode}
          onChange={setDateMode}
          customFrom={fromDate}
          customTo={toDate}
          onCustomFrom={setFromDate}
          onCustomTo={setToDate}
        />

        <Row gap={6} align="center">
          <span className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
            Language
          </span>
          <select
            className="pill-select"
            data-active={lang !== 'all'}
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label="Language"
          >
            <option value="all">All</option>
            {langOptions.map((l) => (
              <option key={l} value={l}>
                {languageFullName(l)}
              </option>
            ))}
            {lang !== 'all' && !langOptions.includes(lang) && (
              <option value={lang}>{languageFullName(lang)}</option>
            )}
          </select>
        </Row>

        <Row gap={6} align="center">
          <span className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
            Sort
          </span>
          <SegmentedControl
            ariaLabel="Sort"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'ccv', label: 'Viewers' },
              { value: 'lang', label: 'Language' },
            ]}
          />
        </Row>
      </Row>

      <RetentionNote retainRawDays={retainRawDays} hours={rangeHours} />

      {dateMode === 'custom' && !range && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          Pick a start and end date to load the range.
        </div>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

      {/* Loading first, empty only after the fetch actually returned empty. */}
      {rows === null && !error && !(dateMode === 'custom' && !range) ? (
        <LoadingBlock />
      ) : filtered.length === 0 && rows !== null ? (
        <EmptyState>
          {range
            ? 'No channels streamed in this window' + (hasFilters ? ' with these filters.' : '.')
            : 'No channels are live right now' + (hasFilters ? ' with these filters.' : '.')}
        </EmptyState>
      ) : (
        <LeaderboardTable
          rows={filtered}
          trackerSlug={slug}
          metricLabel={range ? 'Peak viewers' : 'Viewers'}
          showRangeStats={!!range}
          showRangeGrade={!!range}
          showUptime={!range}
          rankOffset={page * PAGE_SIZE}
          sticky
        />
      )}

      {/* Pagination — both modes; the live board is no longer capped at 200. */}
      {(page > 0 || hasNextPage) && (
        <Row gap={10} align="center" justify="center">
          {page > 0 && (
            <RangePill active={false} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ‹ Prev
            </RangePill>
          )}
          <span className="tabular" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Page {page + 1}{pageCount != null ? ` of ${pageCount}` : ''}
            {countLabel ? ` · ${countLabel}` : ''}
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
