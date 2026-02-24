import { useState } from 'react';
import { Card, Button, PlatformBadge, StatusBadge, LoadingOverlay } from '@/components/common';
import { useApi } from '@/hooks/useApi';
import * as api from '@/services/api';
import { formatDate, tierLabel, getStreamUrl } from '@/utils/formatters';
import type { Channel } from '@/types/api';

interface ChannelListPanelProps {
  seriesId: string | undefined;
  refreshKey?: number;
}

export function ChannelListPanel({ seriesId, refreshKey = 0 }: ChannelListPanelProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const { data: channels, loading, error, refetch } = useApi(
    () => (seriesId ? api.listChannels(seriesId) : Promise.resolve([])),
    [seriesId, refreshKey],
  );

  if (!seriesId) {
    return (
      <Card title="Channels">
        <p className="text-sm text-gray-500">Select a series to manage channels.</p>
      </Card>
    );
  }

  const filtered = (channels ?? []).filter((ch) => {
    if (filter === 'active') return ch.is_active;
    if (filter === 'inactive') return !ch.is_active;
    return true;
  });

  const action = (
    <div className="flex gap-1">
      {(['all', 'active', 'inactive'] as const).map((f) => (
        <button
          key={f}
          onClick={() => setFilter(f)}
          className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${
            filter === f
              ? 'bg-clutch-red text-white'
              : 'bg-navy-700 text-gray-400 hover:text-gray-200'
          }`}
        >
          {f}
        </button>
      ))}
    </div>
  );

  return (
    <Card title={`Channels (${filtered.length})`} action={action}>
      {loading && !channels ? (
        <LoadingOverlay />
      ) : error ? (
        <p className="text-sm text-accent-red">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">
          No channels found.
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700/50 text-xs text-gray-500">
                <th className="pb-2 text-left font-medium">Channel</th>
                <th className="pb-2 text-left font-medium">Platform</th>
                <th className="pb-2 text-left font-medium">Tier</th>
                <th className="pb-2 text-left font-medium">Source</th>
                <th className="pb-2 text-left font-medium">Status</th>
                <th className="pb-2 text-left font-medium">Added</th>
                <th className="pb-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  seriesId={seriesId}
                  onRefresh={refetch}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ChannelRow({
  channel,
  seriesId,
  onRefresh,
}: {
  channel: Channel;
  seriesId: string;
  onRefresh: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLang, setEditLang] = useState(channel.language ?? '');
  const [editRegion, setEditRegion] = useState(channel.region ?? '');
  const [editTier, setEditTier] = useState(channel.tier ?? 'community');
  const [editDisplayName, setEditDisplayName] = useState(channel.display_name);

  const handleToggle = async () => {
    setActing(true);
    try {
      await api.toggleChannelActive(channel.id, !channel.is_active);
      onRefresh();
    } catch {
      // Silently fail
    } finally {
      setActing(false);
    }
  };

  const handleBlock = async () => {
    setActing(true);
    try {
      await api.blockChannel(seriesId, channel.id);
      onRefresh();
    } catch {
      // Silently fail
    } finally {
      setActing(false);
    }
  };

  const handleRemove = async () => {
    setActing(true);
    try {
      await api.deleteChannel(channel.id);
      onRefresh();
    } catch {
      // Silently fail
    } finally {
      setActing(false);
      setConfirmRemove(false);
    }
  };

  const handleSaveEdit = async () => {
    setActing(true);
    try {
      await api.updateChannel(channel.id, {
        display_name: editDisplayName,
        language: editLang || undefined,
        region: editRegion || undefined,
        tier: editTier,
      });
      setEditing(false);
      onRefresh();
    } catch {
      // Silently fail
    } finally {
      setActing(false);
    }
  };

  const handleCancelEdit = () => {
    setEditLang(channel.language ?? '');
    setEditRegion(channel.region ?? '');
    setEditTier(channel.tier ?? 'community');
    setEditDisplayName(channel.display_name);
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="border-b border-navy-700/30 last:border-0 bg-navy-800/50">
        <td colSpan={7} className="py-3 px-2">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <PlatformBadge platform={channel.platform} />
              <span className="text-gray-200 font-medium">{channel.channel_identifier}</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">Display Name</label>
                <input
                  type="text"
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  className="w-full rounded bg-navy-800 border border-navy-700 px-2 py-1 text-xs text-gray-200 focus:border-clutch-red/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">Language</label>
                <input
                  type="text"
                  value={editLang}
                  onChange={(e) => setEditLang(e.target.value)}
                  placeholder="e.g. en"
                  className="w-full rounded bg-navy-800 border border-navy-700 px-2 py-1 text-xs text-gray-200 focus:border-clutch-red/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">Region</label>
                <input
                  type="text"
                  value={editRegion}
                  onChange={(e) => setEditRegion(e.target.value)}
                  placeholder="e.g. NA"
                  className="w-full rounded bg-navy-800 border border-navy-700 px-2 py-1 text-xs text-gray-200 focus:border-clutch-red/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">Tier</label>
                <select
                  value={editTier}
                  onChange={(e) => setEditTier(e.target.value as Channel['tier'])}
                  className="w-full rounded bg-navy-800 border border-navy-700 px-2 py-1 text-xs text-gray-200 focus:border-clutch-red/50 focus:outline-none"
                >
                  <option value="official">Official</option>
                  <option value="partner">Partner</option>
                  <option value="community">Community</option>
                  <option value="watchparty">Watch Party</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={handleCancelEdit}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleSaveEdit} loading={acting}>Save</Button>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-navy-700/30 last:border-0 hover:bg-navy-800/30">
      <td className="py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-gray-200">{channel.display_name}</span>
          {(() => {
            const url = getStreamUrl(channel.platform, channel.channel_identifier);
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
          <span className="text-[10px] text-gray-600">
            {channel.channel_identifier}
          </span>
        </div>
      </td>
      <td className="py-2">
        <PlatformBadge platform={channel.platform} />
      </td>
      <td className="py-2 text-xs text-gray-400">{tierLabel(channel.tier)}</td>
      <td className="py-2 text-xs text-gray-500">
        {channel.source === 'auto_discovered' ? 'Auto' : 'Manual'}
      </td>
      <td className="py-2">
        <StatusBadge status={channel.is_active ? 'active' : 'stopped'} />
      </td>
      <td className="py-2 text-xs text-gray-500">{formatDate(channel.added_at)}</td>
      <td className="py-2 text-right">
        <div className="flex justify-end gap-1">
          <button
            onClick={() => setEditing(true)}
            className="text-gray-600 transition-colors hover:text-gray-300"
            title="Edit channel"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
            </svg>
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggle}
            loading={acting}
          >
            {channel.is_active ? 'Disable' : 'Enable'}
          </Button>
          {channel.source === 'auto_discovered' && channel.is_active && (
            <Button
              variant="danger"
              size="sm"
              onClick={handleBlock}
              loading={acting}
            >
              Block
            </Button>
          )}
          {confirmRemove ? (
            <div className="flex gap-1">
              <Button
                variant="danger"
                size="sm"
                onClick={handleRemove}
                loading={acting}
              >
                Confirm
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="text-gray-600 transition-colors hover:text-accent-red"
              title="Remove channel"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
