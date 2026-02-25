import { useState, useCallback } from 'react';
import { Card, Button, PlatformBadge, LoadingOverlay } from '@/components/common';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
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
}

export function DiscoveryFeedPanel({
  seriesId,
  lastDiscoveryResult,
}: DiscoveryFeedPanelProps) {
  const { hasRole } = useAuth();
  const canEdit = hasRole('editor');
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

  // Sort by added_at descending (most recent first)
  const sorted = [...(channels ?? [])].sort(
    (a, b) => new Date(b.added_at).getTime() - new Date(a.added_at).getTime(),
  );

  // Take most recent 50
  const recent = sorted.slice(0, 50);

  const action = lastDiscoveryResult ? (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span>
        +{lastDiscoveryResult.added} new
      </span>
      <span className="text-gray-700">|</span>
      <span>{formatTimeAgo(lastDiscoveryResult.timestamp)}</span>
    </div>
  ) : null;

  return (
    <Card
      title="Discovery Feed"
      subtitle={`${sorted.length} auto-discovered channels`}
      action={action}
    >
      {loading && recent.length === 0 ? (
        <LoadingOverlay />
      ) : recent.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">
          No discovered streams yet. Start discovery to find new channels.
        </p>
      ) : (
        <div className="max-h-[400px] overflow-y-auto space-y-1.5">
          {recent.map((ch) => (
            <DiscoveryRow
              key={ch.id}
              channel={ch}
              seriesId={seriesId}
              onRefresh={refetch}
              canEdit={canEdit}
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
}: {
  channel: Channel;
  seriesId: string;
  onRefresh: () => void;
  canEdit: boolean;
}) {
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<'approved' | 'blocked' | null>(null);

  const handlePromote = useCallback(async () => {
    setActing(true);
    setActionError(null);
    try {
      await api.promoteChannel(channel.id, 'secondary');
      setActionDone('approved');
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to approve';
      setActionError(msg);
      console.error('[Discovery] Promote failed:', msg);
    } finally {
      setActing(false);
    }
  }, [channel.id, onRefresh]);

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

  const streamUrl = getStreamUrl(channel.platform, channel.channel_identifier);
  const streamTitle = (channel.metadata?.stream_title as string) ?? null;
  const discoveredCCV = (channel.metadata?.discovered_ccv as number) ?? null;

  // Channels are now inserted as inactive (pending approval).
  // Show Approve/Block when: not yet acted on AND still in community tier (pending).
  const isPending = !actionDone && channel.tier === 'community';
  // A channel that was previously blocked shows as inactive + blocked in blocklist
  const wasBlocked = !actionDone && !channel.is_active && channel.tier !== 'community';

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
          {wasBlocked && (
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
        <span>{formatTimeAgo(channel.added_at)}</span>
        {actionError && (
          <span className="ml-1 text-accent-red">&middot; {actionError}</span>
        )}
      </div>
    </div>
  );
}
