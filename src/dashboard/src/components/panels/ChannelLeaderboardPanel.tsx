import { useMemo, useState, useEffect, useCallback } from 'react';
import { Card, PlatformBadge, LoadingOverlay } from '@/components/common';
import { formatNumber, tierLabel, getStreamUrl } from '@/utils/formatters';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import * as api from '@/services/api';
import type { LiveCCVResponse, LeaderboardStats, ScopeLevel } from '@/types/api';

interface ChannelLeaderboardPanelProps {
  seriesId: string | undefined;
  liveCCV: LiveCCVResponse | null;
  loading: boolean;
  scope: { level: ScopeLevel; id: string };
  /** When set, calls public API instead of authenticated API. */
  publicShortName?: string;
  /** View Group filter: language codes. */
  languages?: string[];
  /** View Group filter: platform identifiers. */
  platforms?: string[];
}

// ── Tier badge colors ────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  official: 'bg-clutch-red/15 text-clutch-red border border-red-500/20',
  partner: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
  community: 'bg-navy-700 text-gray-400',
  player: 'bg-sky-500/15 text-sky-400 border border-sky-500/20',
  watch_party: 'bg-accent-purple/15 text-accent-purple border border-purple-500/20',
};

// ── Sort types & helpers ─────────────────────────────────────────────────

type LeaderboardSortField = 'displayName' | 'platform' | 'tier' | 'avgCCV' | 'peakCCV' | 'viewedHours' | 'liveCCV';
type SortDir = 'asc' | 'desc';
interface LeaderboardSortState { field: LeaderboardSortField; dir: SortDir }

const TIER_ORDER: Record<string, number> = { official: 0, partner: 1, community: 2, player: 3, watch_party: 4 };

type MergedEntry = LeaderboardStats & { liveCCV: number };

function sortLeaderboard(rows: MergedEntry[], { field, dir }: LeaderboardSortState): MergedEntry[] {
  const d = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (field) {
      case 'displayName': return d * a.displayName.localeCompare(b.displayName);
      case 'platform': return d * a.platform.localeCompare(b.platform);
      case 'tier': return d * ((TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99));
      case 'avgCCV': return d * (a.avgCCV - b.avgCCV);
      case 'peakCCV': return d * (a.peakCCV - b.peakCCV);
      case 'viewedHours': return d * (a.viewedHours - b.viewedHours);
      case 'liveCCV': return d * (a.liveCCV - b.liveCCV);
      default: return 0;
    }
  });
}

// ── Language helper ──────────────────────────────────────────────────────

function languageBadge(lang: string | null): string {
  if (!lang) return '';
  return lang.toUpperCase();
}

// ── Component ────────────────────────────────────────────────────────────

export function ChannelLeaderboardPanel({ seriesId, liveCCV, loading, scope, publicShortName, languages, platforms }: ChannelLeaderboardPanelProps) {
  const [expanded, setExpanded] = useLocalStorage<boolean>('cvt:leaderboardExpanded', false);
  const [sort, setSort] = useLocalStorage<LeaderboardSortState>('cvt:leaderboardSort', { field: 'peakCCV', dir: 'desc' });
  const [stats, setStats] = useState<LeaderboardStats[] | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const handleSort = useCallback((field: LeaderboardSortField) => {
    setSort((prev) => ({
      field,
      dir: prev.field === field && prev.dir === 'asc' ? 'desc' : 'asc',
    }));
  }, [setSort]);

  // Fetch aggregate stats when expanded
  const fetchStats = useCallback(async () => {
    if (!seriesId) return;
    setStatsLoading(true);
    try {
      const scopeEntityId = scope.level !== 'series' ? scope.id : undefined;
      const result = publicShortName
        ? await api.getPublicLeaderboard(publicShortName, scope.level, scopeEntityId, languages, platforms)
        : await api.getChannelLeaderboard(seriesId, scope.level, scopeEntityId, languages, platforms);
      setStats(result.channels);
    } catch {
      // Silently handle — expanded view will just show live data
    } finally {
      setStatsLoading(false);
    }
  }, [seriesId, scope.level, scope.id, publicShortName, languages, platforms]);

  useEffect(() => {
    if (expanded && seriesId) {
      fetchStats();
    }
  }, [expanded, fetchStats, seriesId]);

  // Sort channels descending by CCV
  const sorted = useMemo(() => {
    if (!liveCCV) return [];
    return [...liveCCV.channels].sort(
      (a, b) => b.concurrentViewers - a.concurrentViewers,
    );
  }, [liveCCV]);

  // Compute 90th percentile threshold
  const p90Threshold = useMemo(() => {
    if (sorted.length === 0) return 0;
    const values = sorted.map((ch) => ch.concurrentViewers);
    const idx = Math.floor(values.length * 0.1);
    return values[idx] ?? 0;
  }, [sorted]);

  // Build merged expanded data: aggregate stats + live CCV
  const mergedExpanded = useMemo(() => {
    if (!stats) return [];
    const liveLookup = new Map<string, number>();
    for (const ch of sorted) {
      liveLookup.set(ch.channelId, (liveLookup.get(ch.channelId) ?? 0) + ch.concurrentViewers);
    }
    return stats.map((s) => ({
      ...s,
      liveCCV: liveLookup.get(s.channelId) ?? 0,
    }));
  }, [stats, sorted]);

  // Apply sort to expanded data
  const sortedExpanded = useMemo(
    () => sortLeaderboard(mergedExpanded, sort),
    [mergedExpanded, sort],
  );

  if (loading && !liveCCV) {
    return <Card title="Channel Leaderboard"><LoadingOverlay /></Card>;
  }

  if (sorted.length === 0 && !expanded) {
    return (
      <Card title="Channel Leaderboard">
        <p className="py-8 text-center text-sm text-gray-500">No channels streaming.</p>
      </Card>
    );
  }

  // Scope label for subtitle
  const scopeLabel = scope.level === 'series' ? 'Series totals'
    : scope.level === 'stage' ? 'Stage totals'
    : 'Day totals';

  // Action button: expand/collapse
  const action = (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="rounded p-1 text-gray-500 hover:bg-navy-700 hover:text-gray-300 transition-colors"
        title={expanded ? 'Collapse' : 'Expand detailed stats'}
      >
        {expanded ? (
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832 6.29 12.77a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5A.75.75 0 012 10z" clipRule="evenodd" />
          </svg>
        )}
      </button>
    </div>
  );

  // ── Expanded view ──────────────────────────────────────────────────────

  if (expanded) {
    return (
      <Card
        title="Channel Leaderboard"
        subtitle={`${mergedExpanded.length || sorted.length} channels \u00b7 ${scopeLabel}`}
        action={action}
        collapsible
        storageKey="cvt:panel:leaderboard"
      >
        {statsLoading && !stats ? (
          <LoadingOverlay />
        ) : (
          <div className="max-h-[720px] overflow-y-auto -mx-5 px-5">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-navy-850 z-10">
                <tr className="border-b border-navy-700/50 text-xs text-gray-500">
                  <th className="pb-2 pr-2 text-left font-medium w-8">#</th>
                  {([
                    ['platform', 'Platform', 'text-left'],
                    ['displayName', 'Channel', 'text-left'],
                    ['tier', 'Tier', 'text-left'],
                    ['avgCCV', 'Avg CCV', 'text-right'],
                    ['peakCCV', 'Peak CCV', 'text-right'],
                    ['viewedHours', 'Viewed Hrs', 'text-right'],
                    ['liveCCV', 'Live CCV', 'text-right'],
                  ] as [LeaderboardSortField, string, string][]).map(([field, label, align]) => (
                    <th
                      key={field}
                      className={`pb-2 ${align} font-medium cursor-pointer select-none hover:text-gray-300 transition-colors`}
                      onClick={() => handleSort(field)}
                    >
                      {label}
                      {sort.field === field && (
                        <span className="ml-1 text-clutch-red">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedExpanded.map((ch, i) => (
                  <tr
                    key={ch.channelId}
                    className="border-b border-navy-700/30 last:border-0 hover:bg-navy-800/30 transition-colors"
                  >
                    <td className="py-2 pr-2">
                      <span
                        className={`
                          inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold
                          ${
                            i === 0
                              ? 'bg-yellow-500/20 text-yellow-400'
                              : i === 1
                                ? 'bg-gray-400/20 text-gray-300'
                                : i === 2
                                  ? 'bg-orange-500/20 text-orange-400'
                                  : 'text-gray-600'
                          }
                        `}
                      >
                        {i + 1}
                      </span>
                    </td>
                    <td className="py-2">
                      <PlatformBadge platform={ch.platform ?? 'unknown'} />
                    </td>
                    <td className="py-2">
                      <span className="font-medium text-gray-200">{ch.displayName}</span>
                    </td>
                    <td className="py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TIER_COLORS[ch.tier] ?? TIER_COLORS.community}`}>
                        {tierLabel(ch.tier)}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono text-gray-300">
                      {formatNumber(ch.avgCCV)}
                    </td>
                    <td className="py-2 text-right font-mono text-gray-300">
                      {formatNumber(ch.peakCCV)}
                    </td>
                    <td className="py-2 text-right font-mono text-gray-400">
                      {formatNumber(ch.viewedHours)}
                    </td>
                    <td className="py-2 text-right">
                      {ch.liveCCV > 0 ? (
                        <span className="font-mono font-bold text-accent-green">
                          {formatNumber(ch.liveCCV)}
                        </span>
                      ) : (
                        <span className="font-mono text-gray-600">{'\u2014'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  }

  // ── Compact view (default) ─────────────────────────────────────────────

  return (
    <Card
      title="Channel Leaderboard"
      subtitle={`${sorted.length} channels ranked by CCV`}
      action={action}
      collapsible
      storageKey="cvt:panel:leaderboard"
    >
      <div className="max-h-[480px] overflow-y-auto -mx-5 px-5">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-navy-850 z-10">
            <tr className="border-b border-navy-700/50 text-xs text-gray-500">
              <th className="pb-2 pr-2 text-left font-medium w-8">#</th>
              <th className="pb-2 text-left font-medium">Platform</th>
              <th className="pb-2 text-left font-medium">Channel</th>
              <th className="pb-2 text-left font-medium">Lang</th>
              <th className="pb-2 text-right font-medium">CCV</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((ch, i) => {
              const isTop = ch.concurrentViewers >= p90Threshold && p90Threshold > 0;
              return (
                <tr
                  key={ch.channelId}
                  className={`
                    border-b border-navy-700/30 last:border-0
                    transition-colors
                    ${isTop ? 'bg-accent-cyan/[0.04]' : 'hover:bg-navy-800/30'}
                  `}
                >
                  <td className="py-2 pr-2">
                    <span
                      className={`
                        inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold
                        ${
                          i === 0
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : i === 1
                              ? 'bg-gray-400/20 text-gray-300'
                              : i === 2
                                ? 'bg-orange-500/20 text-orange-400'
                                : 'text-gray-600'
                        }
                      `}
                    >
                      {i + 1}
                    </span>
                  </td>
                  <td className="py-2">
                    <PlatformBadge platform={ch.platform ?? 'unknown'} />
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`font-medium ${isTop ? 'text-accent-cyan' : 'text-gray-200'}`}>
                        {ch.displayName}
                      </span>
                      {(() => {
                        const url = getStreamUrl(ch.platform, ch.channelIdentifier);
                        return url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-gray-600 hover:text-accent-cyan transition-colors"
                            title="Open stream"
                          >
                            <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                              <path
                                fillRule="evenodd"
                                d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5zm7.25-.75a.75.75 0 01.75-.75h3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0V6.31l-5.47 5.47a.75.75 0 01-1.06-1.06l5.47-5.47H12.25a.75.75 0 01-.75-.75z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </a>
                        ) : null;
                      })()}
                    </div>
                  </td>
                  <td className="py-2">
                    {ch.language && (
                      <span className="rounded bg-navy-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
                        {languageBadge(ch.language)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <span
                      className={`font-mono font-bold ${
                        isTop ? 'text-accent-cyan' : 'text-gray-200'
                      }`}
                    >
                      {formatNumber(ch.concurrentViewers)}
                    </span>
                    {isTop && (
                      <span className="ml-1.5 text-[9px] font-bold uppercase text-accent-cyan/60">
                        top 10%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
