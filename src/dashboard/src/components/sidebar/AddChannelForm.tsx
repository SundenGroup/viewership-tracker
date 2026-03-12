import { useState, useCallback, useEffect } from 'react';
import { Button, FormField } from '@/components/common';
import { Select } from '@/components/common/Select';
import { TextInput } from '@/components/common/TextInput';
import { useMutation } from '@/hooks/useMutation';
import * as api from '@/services/api';
import type { Platform, ChannelTier, Channel, BroadcastDay } from '@/types/api';

interface AddChannelFormProps {
  seriesId: string;
  broadcastDays: BroadcastDay[];
  onSuccess: () => void;
}

const PLATFORM_OPTIONS = [
  { value: 'twitch', label: 'Twitch' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'kick', label: 'Kick' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'steam', label: 'Steam' },
];

const TIER_OPTIONS = [
  { value: 'official', label: 'Official' },
  { value: 'partner', label: 'Partner' },
  { value: 'community', label: 'Community' },
  { value: 'player', label: 'Player' },
  { value: 'watch_party', label: 'Watch Party' },
];

const INITIAL_FORM = {
  platform: 'twitch' as Platform,
  channel_identifier: '',
  display_name: '',
  language: '',
  region: '',
  tier: 'community' as ChannelTier,
};

export function AddChannelForm({ seriesId, broadcastDays, onSuccess }: AddChannelFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [selectedDayIds, setSelectedDayIds] = useState<Set<string>>(new Set());

  // Auto-select live days when tier is community or watch_party
  useEffect(() => {
    if (form.tier === 'community' || form.tier === 'watch_party') {
      const liveDayIds = broadcastDays
        .filter((d) => d.status === 'live')
        .map((d) => d.id);
      if (liveDayIds.length > 0) {
        setSelectedDayIds(new Set(liveDayIds));
      }
    } else {
      setSelectedDayIds(new Set());
    }
  }, [form.tier, broadcastDays]);

  const createChannel = useCallback(
    (data: typeof INITIAL_FORM) =>
      api.createChannel(seriesId, {
        platform: data.platform,
        channel_identifier: data.channel_identifier,
        display_name: data.display_name || data.channel_identifier,
        language: data.language || undefined,
        region: data.region || undefined,
        tier: data.tier,
        is_active: true,
        broadcast_day_ids: selectedDayIds.size > 0 ? Array.from(selectedDayIds) : undefined,
      }),
    [seriesId, selectedDayIds],
  );

  const { mutate, loading, error } = useMutation<Channel, [typeof INITIAL_FORM]>(createChannel);

  const handleSubmit = async () => {
    if (!form.channel_identifier.trim()) return;
    const result = await mutate(form);
    if (result) {
      setForm(INITIAL_FORM);
      setSelectedDayIds(new Set());
      onSuccess();
    }
  };

  const updateField = <K extends keyof typeof INITIAL_FORM>(
    key: K,
    value: (typeof INITIAL_FORM)[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleDay = (dayId: string) => {
    setSelectedDayIds((prev) => {
      const next = new Set(prev);
      if (next.has(dayId)) {
        next.delete(dayId);
      } else {
        next.add(dayId);
      }
      return next;
    });
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-1.5 px-4 py-2 text-xs text-clutch-red transition-colors hover:text-[#ff4070]"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
            clipRule="evenodd"
          />
        </svg>
        Add Channel
      </button>
    );
  }

  return (
    <div className="space-y-2.5 px-4 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-400">Add Channel</span>
        <button
          onClick={() => setExpanded(false)}
          className="text-gray-600 transition-colors hover:text-gray-400"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      <FormField label="Platform">
        <Select
          options={PLATFORM_OPTIONS}
          value={form.platform}
          onChange={(e) => updateField('platform', e.target.value as Platform)}
        />
      </FormField>

      <FormField label={form.platform === 'youtube' ? 'Channel / Stream' : form.platform === 'steam' ? 'Steam ID / Profile' : 'Channel ID'} required>
        <TextInput
          value={form.channel_identifier}
          onChange={(e) => updateField('channel_identifier', e.target.value)}
          placeholder={
            form.platform === 'youtube'
              ? 'handle, channel URL, or live stream URL'
              : form.platform === 'twitch'
                ? 'e.g. shroud'
                : form.platform === 'kick'
                  ? 'e.g. channel slug'
                  : form.platform === 'steam'
                    ? 'e.g. 76561198082857351 or vanity name'
                    : 'e.g. username'
          }
        />
        {form.platform === 'youtube' && (
          <p className="mt-1 text-[9px] leading-tight text-gray-600">
            Accepts: @handle, channel URL, or a specific live stream URL
            (youtube.com/watch?v=...)
          </p>
        )}
        {form.platform === 'steam' && (
          <p className="mt-1 text-[9px] leading-tight text-gray-600">
            Accepts: Steam64 ID, vanity name, or profile URL
            (steamcommunity.com/id/... or /profiles/...)
          </p>
        )}
      </FormField>

      <FormField label="Display Name">
        <TextInput
          value={form.display_name}
          onChange={(e) => updateField('display_name', e.target.value)}
          placeholder="Optional, defaults to ID"
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2">
        <FormField label="Language">
          <TextInput
            value={form.language}
            onChange={(e) => updateField('language', e.target.value)}
            placeholder="en"
            maxLength={5}
          />
        </FormField>
        <FormField label="Region">
          <TextInput
            value={form.region}
            onChange={(e) => updateField('region', e.target.value)}
            placeholder="NA"
          />
        </FormField>
      </div>

      <FormField label="Tier">
        <Select
          options={TIER_OPTIONS}
          value={form.tier}
          onChange={(e) => updateField('tier', e.target.value as ChannelTier)}
        />
      </FormField>

      {/* Broadcast Day Selector */}
      {broadcastDays.length > 0 && (
        <FormField label="Broadcast Days">
          <p className="mb-1.5 text-[9px] text-gray-600">
            Leave empty for all days
          </p>
          <div className="flex flex-wrap gap-1">
            {broadcastDays.map((day) => (
              <label
                key={day.id}
                className={`cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                  selectedDayIds.has(day.id)
                    ? 'border-clutch-red bg-clutch-red/20 text-clutch-red'
                    : 'border-navy-700 bg-navy-800 text-gray-500 hover:text-gray-300'
                }`}
              >
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selectedDayIds.has(day.id)}
                  onChange={() => toggleDay(day.id)}
                />
                {day.label}
                {day.status === 'live' && (
                  <span className="ml-0.5 text-accent-green">{'\u25CF'}</span>
                )}
              </label>
            ))}
          </div>
        </FormField>
      )}

      {error && <p className="text-xs text-accent-red">{error}</p>}

      <Button
        variant="primary"
        size="sm"
        onClick={handleSubmit}
        loading={loading}
        disabled={!form.channel_identifier.trim()}
        className="w-full"
      >
        Add Channel
      </Button>
    </div>
  );
}
