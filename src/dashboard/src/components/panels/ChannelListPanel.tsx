import { useState, useCallback } from 'react';
import { Card, Button, PlatformBadge, StatusBadge, LoadingOverlay } from '@/components/common';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import * as api from '@/services/api';
import { formatDate, tierLabel, getStreamUrl } from '@/utils/formatters';
import type { Channel, BroadcastDay } from '@/types/api';

// ── Sort types & helpers ────────────────────────────────────────────────

type SortField = 'display_name' | 'platform' | 'tier' | 'days' | 'source' | 'is_active' | 'added_at';
type SortDir = 'asc' | 'desc';
interface SortState { field: SortField; dir: SortDir }

const TIER_ORDER: Record<string, number> = { official: 0, partner: 1, community: 2, player: 3, watch_party: 4 };

function sortChannels(channels: Channel[], { field, dir }: SortState): Channel[] {
  const d = dir === 'asc' ? 1 : -1;
  return [...channels].sort((a, b) => {
    switch (field) {
      case 'display_name': return d * a.display_name.localeCompare(b.display_name);
      case 'platform': return d * a.platform.localeCompare(b.platform);
      case 'tier': return d * ((TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99));
      case 'source': return d * (a.source ?? '').localeCompare(b.source ?? '');
      case 'days': {
        // 0 assigned days = "All Days" → treat as highest count for sorting
        const aLen = (a.broadcast_day_ids ?? []).length || 999;
        const bLen = (b.broadcast_day_ids ?? []).length || 999;
        return d * (aLen - bLen);
      }
      case 'is_active': return d * (Number(b.is_active) - Number(a.is_active));
      case 'added_at': return d * (new Date(a.added_at).getTime() - new Date(b.added_at).getTime());
      default: return 0;
    }
  });
}

// ── Component ───────────────────────────────────────────────────────────

interface ChannelListPanelProps {
  seriesId: string | undefined;
  broadcastDays: BroadcastDay[];
  refreshKey?: number;
}

export function ChannelListPanel({ seriesId, broadcastDays, refreshKey = 0 }: ChannelListPanelProps) {
  const { hasRole } = useAuth();
  const canEdit = hasRole('editor');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [expanded, setExpanded] = useLocalStorage<boolean>('cvt:channelListExpanded', false);
  const [sort, setSort] = useLocalStorage<SortState>('cvt:channelListSort', { field: 'display_name', dir: 'asc' });

  const handleSort = useCallback((field: SortField) => {
    setSort((prev) => ({
      field,
      dir: prev.field === field && prev.dir === 'asc' ? 'desc' : 'asc',
    }));
  }, [setSort]);

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

  const sorted = sortChannels(filtered, sort);

  // Build a quick lookup: dayId → label
  const dayLabelMap = new Map(broadcastDays.map((d) => [d.id, d.label]));

  const action = (
    <div className="flex items-center gap-2">
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
    <Card title={`Channels (${filtered.length})`} action={action} collapsible storageKey="cvt:panel:channelList">
      {loading && !channels ? (
        <LoadingOverlay />
      ) : error ? (
        <p className="text-sm text-accent-red">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">
          No channels found.
        </p>
      ) : (
        <div className={`overflow-y-auto ${expanded ? 'max-h-[calc(100vh-12rem)]' : 'max-h-96'}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700/50 text-xs text-gray-500">
                {([
                  ['display_name', 'Channel'],
                  ['platform', 'Platform'],
                  ['tier', 'Tier'],
                ] as [SortField, string][]).map(([field, label]) => (
                  <th
                    key={field}
                    className="pb-2 text-left font-medium cursor-pointer select-none hover:text-gray-300 transition-colors"
                    onClick={() => handleSort(field)}
                  >
                    {label}
                    {sort.field === field && (
                      <span className="ml-1 text-clutch-red">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </th>
                ))}
                <th
                  className="pb-2 text-left font-medium cursor-pointer select-none hover:text-gray-300 transition-colors"
                  onClick={() => handleSort('days')}
                >
                  Days
                  {sort.field === 'days' && (
                    <span className="ml-1 text-clutch-red">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </th>
                {([
                  ['source', 'Source'],
                  ['is_active', 'Status'],
                  ['added_at', 'Added'],
                ] as [SortField, string][]).map(([field, label]) => (
                  <th
                    key={field}
                    className="pb-2 text-left font-medium cursor-pointer select-none hover:text-gray-300 transition-colors"
                    onClick={() => handleSort(field)}
                  >
                    {label}
                    {sort.field === field && (
                      <span className="ml-1 text-clutch-red">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </th>
                ))}
                {canEdit && <th className="pb-2 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  seriesId={seriesId}
                  broadcastDays={broadcastDays}
                  dayLabelMap={dayLabelMap}
                  onRefresh={refetch}
                  canEdit={canEdit}
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
  broadcastDays,
  dayLabelMap,
  onRefresh,
  canEdit,
}: {
  channel: Channel;
  seriesId: string;
  broadcastDays: BroadcastDay[];
  dayLabelMap: Map<string, string>;
  onRefresh: () => void;
  canEdit: boolean;
}) {
  const [acting, setActing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLang, setEditLang] = useState(channel.language ?? '');
  const [editRegion, setEditRegion] = useState(channel.region ?? '');
  const [editTier, setEditTier] = useState(channel.tier ?? 'community');
  const [editDisplayName, setEditDisplayName] = useState(channel.display_name);
  const [editDayIds, setEditDayIds] = useState<Set<string>>(
    new Set(channel.broadcast_day_ids ?? []),
  );

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
      // Update channel properties
      await api.updateChannel(channel.id, {
        display_name: editDisplayName,
        language: editLang || undefined,
        region: editRegion || undefined,
        tier: editTier,
      });

      // Update day assignments
      const currentDayIds = new Set(channel.broadcast_day_ids ?? []);
      const newDayIdsArray = Array.from(editDayIds);
      const daysChanged =
        currentDayIds.size !== editDayIds.size ||
        newDayIdsArray.some((id) => !currentDayIds.has(id));

      if (daysChanged) {
        await api.updateChannelDays(channel.id, newDayIdsArray);
      }

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
    setEditDayIds(new Set(channel.broadcast_day_ids ?? []));
    setEditing(false);
  };

  const toggleEditDay = (dayId: string) => {
    setEditDayIds((prev) => {
      const next = new Set(prev);
      if (next.has(dayId)) {
        next.delete(dayId);
      } else {
        next.add(dayId);
      }
      return next;
    });
  };

  // Render assigned days as pills
  const assignedDayIds = channel.broadcast_day_ids ?? [];
  const daysPills =
    assignedDayIds.length === 0 ? (
      <span className="text-[10px] text-gray-600">All Days</span>
    ) : (
      <div className="flex flex-wrap gap-0.5">
        {assignedDayIds.map((id) => (
          <span
            key={id}
            className="rounded-full bg-navy-700 px-1.5 py-0.5 text-[9px] text-gray-400"
          >
            {dayLabelMap.get(id) ?? 'Unknown'}
          </span>
        ))}
      </div>
    );

  if (canEdit && editing) {
    return (
      <tr className="border-b border-navy-700/30 last:border-0 bg-navy-800/50">
        <td colSpan={8} className="py-3 px-2">
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
                  <option value="player">Player</option>
                  <option value="watch_party">Watch Party</option>
                </select>
              </div>
            </div>

            {/* Broadcast Day Assignments */}
            {broadcastDays.length > 0 && (
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500">
                  Broadcast Days
                  <span className="ml-1 normal-case font-normal text-gray-600">(empty = all days)</span>
                </label>
                <div className="flex flex-wrap gap-1">
                  {broadcastDays.map((day) => (
                    <label
                      key={day.id}
                      className={`cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                        editDayIds.has(day.id)
                          ? 'border-clutch-red bg-clutch-red/20 text-clutch-red'
                          : 'border-navy-700 bg-navy-800 text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="hidden"
                        checked={editDayIds.has(day.id)}
                        onChange={() => toggleEditDay(day.id)}
                      />
                      {day.label}
                      {day.status === 'live' && (
                        <span className="ml-0.5 text-accent-green">{'\u25CF'}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

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
      <td className="py-2">{daysPills}</td>
      <td className="py-2 text-xs text-gray-500">
        {channel.source === 'auto_discovered' ? 'Auto' : 'Manual'}
      </td>
      <td className="py-2">
        <StatusBadge status={channel.is_active ? 'active' : 'stopped'} />
      </td>
      <td className="py-2 text-xs text-gray-500">{formatDate(channel.added_at)}</td>
      {canEdit && (
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
              <div className="flex flex-col items-end gap-1">
                <p className="text-[10px] leading-tight text-amber-400">
                  Deleting removes all historical data.
                  <br />
                  Consider disabling instead to preserve it.
                </p>
                <div className="flex gap-1">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleRemove}
                    loading={acting}
                  >
                    Delete permanently
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancel
                  </Button>
                </div>
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
      )}
    </tr>
  );
}
