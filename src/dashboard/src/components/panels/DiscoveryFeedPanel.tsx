import { useState, useCallback } from 'react';
import { Card, Button, PlatformBadge, LoadingOverlay } from '@/components/common';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import * as api from '@/services/api';
import { formatTimeAgo, getStreamUrl } from '@/utils/formatters';
import type { Channel, DiscoveryResult } from '@/types/api';

// ── Shared external-link icon ───────────────────────────────────────────────

function ExternalLinkIcon({ className = 'h-3 w-3' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5zm7.25-.75a.75.75 0 01.75-.75h3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0V6.31l-5.47 5.47a.75.75 0 01-1.06-1.06l5.47-5.47H12.25a.75.75 0 01-.75-.75z"
        clipRule="evenodd"
      />
    </svg>
  );
}

interface DiscoveryFeedPanelProps {
  seriesId: string | undefined;
  lastDiscoveryResult: DiscoveryResult | null;
  defaultTier?: string;
  blocklist?: string[];
}

export function DiscoveryFeedPanel({
  seriesId,
  lastDiscoveryResult,
  defaultTier = 'watch_party',
  blocklist = [],
}: DiscoveryFeedPanelProps) {
  const { hasRole } = useAuth();
  const canEdit = hasRole('editor');
  const [expanded, setExpanded] = useLocalStorage<boolean>('cvt:discoveryExpanded', false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sortBy, setSortBy] = useLocalStorage<'recent' | 'viewers' | 'platform' | 'name' | 'lang'>('cvt:discoverySortBy', 'recent');
  const { data: channels, loading, refetch } = useApi(
    () =>
      seriesId
        ? api.listChannels(seriesId, { source: 'auto_discovered' })
        : Promise.resolve([]),
    [seriesId, lastDiscoveryResult?.timestamp],
  );

  if (!seriesId) {
    return (
      <Card title="Discovery Feed">
        <p className="py-8 text-center text-sm text-gray-500">
          Select a series to view discovered streams.
        </p>
      </Card>
    );
  }

  // Filter out stale disabled channels, then sort by selected criteria
  const sorted = [...(channels ?? [])]
    .filter((ch) => {
      // Hide disabled channels unless re-discovered streaming or auto-paused
      if (!ch.is_active && !blocklist.includes(ch.channel_identifier)) {
        return !!ch.metadata?.last_seen_at || !!ch.metadata?.auto_paused;
      }
      return true;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'viewers': {
          const aCcv = (a.metadata?.discovered_ccv as number) ?? 0;
          const bCcv = (b.metadata?.discovered_ccv as number) ?? 0;
          return bCcv - aCcv; // Highest first
        }
        case 'platform':
          return (a.platform ?? '').localeCompare(b.platform ?? '') || (a.display_name ?? '').localeCompare(b.display_name ?? '');
        case 'name':
          return (a.display_name ?? '').localeCompare(b.display_name ?? '');
        case 'lang':
          return (a.language ?? 'zzz').localeCompare(b.language ?? 'zzz') || ((b.metadata?.discovered_ccv as number) ?? 0) - ((a.metadata?.discovered_ccv as number) ?? 0);
        case 'recent':
        default: {
          // Re-surfaced channels (with last_seen_at) sort first by last_seen_at
          const aLive = a.metadata?.last_seen_at as string | undefined;
          const bLive = b.metadata?.last_seen_at as string | undefined;
          if (aLive && !bLive) return -1;
          if (!aLive && bLive) return 1;
          if (aLive && bLive) return new Date(bLive).getTime() - new Date(aLive).getTime();
          return new Date(b.added_at).getTime() - new Date(a.added_at).getTime();
        }
      }
    });

  // Take most recent 100
  const recent = sorted.slice(0, 100);

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    if (!seriesId) return;
    setClearing(true);
    try {
      await api.clearDiscoveryFeed(seriesId);
      refetch();
    } catch {
      // Silently fail
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  const action = (
    <div className="flex items-center gap-2">
      {lastDiscoveryResult && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>+{lastDiscoveryResult.added} new</span>
          {(lastDiscoveryResult.resurfaced ?? 0) > 0 && (
            <span>+{lastDiscoveryResult.resurfaced} updated</span>
          )}
          <span className="text-gray-700">|</span>
          <span>{formatTimeAgo(lastDiscoveryResult.timestamp)}</span>
        </div>
      )}
      {canEdit && sorted.length > 0 && (
        <button
          onClick={handleClear}
          onBlur={() => setConfirmClear(false)}
          disabled={clearing}
          className={`rounded px-2 py-0.5 text-xs transition-colors ${
            confirmClear
              ? 'bg-accent-red text-white'
              : 'bg-navy-700 text-gray-400 hover:text-gray-200'
          }`}
        >
          {clearing ? 'Clearing...' : confirmClear ? 'Confirm?' : 'Clear All'}
        </button>
      )}
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="rounded p-1 text-gray-500 transition-colors hover:bg-navy-700 hover:text-gray-300"
        title={expanded ? 'Compact view' : 'Expanded view'}
      >
        {expanded ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06L5.44 6.5H3.75a.75.75 0 000 1.5h4a.75.75 0 00.75-.75v-4a.75.75 0 00-1.5 0v1.69L3.78 1.72a.75.75 0 00-.5-.5zM16.72 17.78a.75.75 0 001.06-1.06L14.56 13.5h1.69a.75.75 0 000-1.5h-4a.75.75 0 00-.75.75v4a.75.75 0 001.5 0v-1.69l3.22 3.22a.75.75 0 00.5.5z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M13.28 7.78a.75.75 0 001.06-1.06l-3.22-3.22h1.69a.75.75 0 000-1.5h-4a.75.75 0 00-.75.75v4a.75.75 0 001.5 0V5.06l3.22 3.22a.75.75 0 00.5.5zM6.72 12.22a.75.75 0 00-1.06 1.06l3.22 3.22H7.19a.75.75 0 000 1.5h4a.75.75 0 00.75-.75v-4a.75.75 0 00-1.5 0v1.69l-3.22-3.22a.75.75 0 00-.5-.5z" clipRule="evenodd" />
          </svg>
        )}
      </button>
    </div>
  );

  return (
    <Card
      title="Discovery Feed"
      subtitle={`${sorted.length} auto-discovered channels`}
      action={action}
      collapsible
      storageKey="cvt:panel:discovery"
    >
      {/* Sort controls */}
      {sorted.length > 0 && (
        <div className="mb-2 flex items-center gap-1">
          <span className="mr-1 text-[10px] text-gray-600">Sort:</span>
          {([
            ['recent', 'Recent'],
            ['viewers', 'Viewers'],
            ['platform', 'Platform'],
            ['name', 'Name'],
            ['lang', 'Lang'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                sortBy === key
                  ? 'bg-accent-red/20 text-accent-red'
                  : 'text-gray-500 hover:bg-navy-700 hover:text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {loading && recent.length === 0 ? (
        <LoadingOverlay />
      ) : recent.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">
          No discovered streams yet. Start discovery to find new channels.
        </p>
      ) : (
        <div className={`overflow-y-auto space-y-1.5 ${expanded ? 'max-h-[calc(100vh-12rem)]' : 'max-h-[400px]'}`}>
          {recent.map((ch) => (
            <DiscoveryRow
              key={ch.id}
              channel={ch}
              seriesId={seriesId}
              onRefresh={refetch}
              canEdit={canEdit}
              defaultTier={defaultTier}
              blocklist={blocklist}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Individual row ───────────────────────────────────────────────────────

function DiscoveryRow({
  channel,
  seriesId,
  onRefresh,
  canEdit,
  defaultTier,
  blocklist,
}: {
  channel: Channel;
  seriesId: string;
  onRefresh: () => void;
  canEdit: boolean;
  defaultTier: string;
  blocklist: string[];
}) {
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<'approved' | 'blocked' | null>(null);

  const handlePromote = useCallback(async () => {
    setActing(true);
    setActionError(null);
    try {
      await api.promoteChannel(channel.id, defaultTier);
      setActionDone('approved');
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to approve';
      setActionError(msg);
      console.error('[Discovery] Promote failed:', msg);
    } finally {
      setActing(false);
    }
  }, [channel.id, defaultTier, onRefresh]);

  const handleBlock = useCallback(async () => {
    setActing(true);
    setActionError(null);
    try {
      await api.blockChannel(seriesId, channel.id);
      setActionDone('blocked');
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to block';
      setActionError(msg);
      console.error('[Discovery] Block failed:', msg);
    } finally {
      setActing(false);
    }
  }, [channel.id, seriesId, onRefresh]);

  // Re-enable a disabled channel at its existing tier
  const handleReEnable = useCallback(async () => {
    setActing(true);
    setActionError(null);
    try {
      await api.promoteChannel(channel.id, channel.tier);
      setActionDone('approved');
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to re-enable';
      setActionError(msg);
      console.error('[Discovery] Re-enable failed:', msg);
    } finally {
      setActing(false);
    }
  }, [channel.id, channel.tier, onRefresh]);

  const streamUrl = getStreamUrl(channel.platform, channel.channel_identifier);
  const streamTitle = (channel.metadata?.stream_title as string) ?? null;
  const discoveredCCV = (channel.metadata?.discovered_ccv as number) ?? null;

  // Channels are now inserted as inactive (pending approval).
  // Show Approve/Block when: not yet acted on AND still in community tier (pending).
  const isPending = !actionDone && channel.tier === 'community';
  // Distinguish between blocked (in blocklist) and disabled (just deactivated)
  const inBlocklist = blocklist.includes(channel.channel_identifier);
  const isBlocked = !actionDone && !channel.is_active && inBlocklist;
  const isAutoPaused = !actionDone && !channel.is_active && !!channel.metadata?.auto_paused;
  const isDisabled = !actionDone && !channel.is_active && !inBlocklist
    && !!channel.metadata?.last_seen_at
    && (channel.tier !== 'community' || isAutoPaused);

  return (
    <div className="rounded-lg bg-navy-800/40 px-3 py-2 hover:bg-navy-800/60 transition-colors">
      {/* Top row: platform, name, link, language, CCV */}
      <div className="flex items-center gap-3 min-w-0">
        <PlatformBadge platform={channel.platform} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-gray-200">
              {channel.display_name}
            </span>
            {streamUrl && (
              <a
                href={streamUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-gray-600 hover:text-accent-cyan transition-colors"
                title="Open stream"
              >
                <ExternalLinkIcon className="h-3 w-3" />
              </a>
            )}
            {channel.language && (
              <span className="shrink-0 rounded bg-navy-700 px-1.5 py-0.5 text-[10px] text-gray-500">
                {channel.language.toUpperCase()}
              </span>
            )}
            {isAutoPaused && (
              <span className="shrink-0 rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-400">
                Auto-paused
              </span>
            )}
            {discoveredCCV !== null && discoveredCCV > 0 && (
              <span className="shrink-0 text-[10px] text-gray-500">
                {discoveredCCV.toLocaleString()} viewers
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 ml-2 shrink-0">
          {actionDone === 'approved' && (
            <span className="text-[10px] font-bold uppercase text-accent-green">
              Approved
            </span>
          )}
          {actionDone === 'blocked' && (
            <span className="text-[10px] font-bold uppercase text-accent-red">
              Blocked
            </span>
          )}
          {canEdit && isPending && (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={handlePromote}
                loading={acting}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleBlock}
                loading={acting}
              >
                Block
              </Button>
            </>
          )}
          {canEdit && isDisabled && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleReEnable}
              loading={acting}
            >
              Re-enable
            </Button>
          )}
          {isBlocked && (
            <span className="text-[10px] font-bold uppercase text-accent-red">
              Blocked
            </span>
          )}
        </div>
      </div>

      {/* Bottom row: stream title + metadata */}
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-600 pl-8">
        {streamTitle && (
          <>
            <span className="truncate text-gray-500 italic max-w-[320px]">
              {streamTitle}
            </span>
            <span>&middot;</span>
          </>
        )}
        <span>{channel.channel_identifier}</span>
        <span>&middot;</span>
        <span>{formatTimeAgo((channel.metadata?.last_seen_at as string) ?? channel.added_at)}</span>
        {actionError && (
          <span className="ml-1 text-accent-red">&middot; {actionError}</span>
        )}
      </div>
    </div>
  );
}
