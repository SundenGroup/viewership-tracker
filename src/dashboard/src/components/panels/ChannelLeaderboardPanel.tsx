import { useMemo } from 'react';
import { Card, PlatformBadge, LoadingOverlay } from '@/components/common';
import { formatNumber, tierLabel, getStreamUrl } from '@/utils/formatters';
import type { LiveCCVResponse } from '@/types/api';

interface ChannelLeaderboardPanelProps {
  liveCCV: LiveCCVResponse | null;
  loading: boolean;
}

// ── Tier badge colors ────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  primary: 'bg-clutch-red/15 text-clutch-red border border-red-500/20',
  secondary: 'bg-clutch-blue/15 text-accent-blue border border-blue-500/20',
  community: 'bg-navy-700 text-gray-400',
  watch_party: 'bg-accent-purple/15 text-accent-purple border border-purple-500/20',
};

// ── Language flag emoji lookup (common codes) ────────────────────────────

function languageBadge(lang: string | null): string {
  if (!lang) return '';
  return lang.toUpperCase();
}

// ── Component ────────────────────────────────────────────────────────────

export function ChannelLeaderboardPanel({ liveCCV, loading }: ChannelLeaderboardPanelProps) {
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
    const idx = Math.floor(values.length * 0.1); // top 10% = 90th percentile
    return values[idx] ?? 0;
  }, [sorted]);

  if (loading && !liveCCV) {
    return <Card title="Channel Leaderboard"><LoadingOverlay /></Card>;
  }

  if (sorted.length === 0) {
    return (
      <Card title="Channel Leaderboard">
        <p className="py-8 text-center text-sm text-gray-500">No channels streaming.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Channel Leaderboard"
      subtitle={`${sorted.length} channels ranked by CCV`}
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
                  {/* Rank */}
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

                  {/* Platform */}
                  <td className="py-2">
                    <PlatformBadge platform={ch.platform ?? 'unknown'} />
                  </td>

                  {/* Channel Name */}
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

                  {/* Language */}
                  <td className="py-2">
                    {ch.language && (
                      <span className="rounded bg-navy-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
                        {languageBadge(ch.language)}
                      </span>
                    )}
                  </td>

                  {/* CCV */}
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
