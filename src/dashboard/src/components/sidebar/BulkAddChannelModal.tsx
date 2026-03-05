import { useState, useCallback, useEffect } from 'react';
import { Modal, Button, FormField } from '@/components/common';
import { Select } from '@/components/common/Select';
import { TextArea } from '@/components/common/TextArea';
import { useMutation } from '@/hooks/useMutation';
import * as api from '@/services/api';
import type { Platform, ChannelTier, BulkChannelResult, CreateChannel, BroadcastDay } from '@/types/api';

interface BulkAddChannelModalProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  broadcastDays: BroadcastDay[];
  onSuccess: () => void;
}

const PLATFORM_OPTIONS = [
  { value: 'twitch', label: 'Twitch' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'kick', label: 'Kick' },
  { value: 'tiktok', label: 'TikTok' },
];

const TIER_OPTIONS = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'community', label: 'Community' },
  { value: 'watch_party', label: 'Watch Party' },
];

/**
 * Parse a URL or raw identifier into platform + channel_identifier.
 * Supports:
 *   https://twitch.tv/channelname
 *   https://youtube.com/@channelname
 *   https://youtube.com/c/channelname
 *   https://kick.com/channelname
 *   https://tiktok.com/@channelname
 *   raw identifier → uses defaultPlatform
 */
function parseChannelLine(
  line: string,
  defaultPlatform: Platform,
): { platform: Platform; identifier: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/^\/+|\/+$/g, '');

    if (host.includes('twitch.tv') && path) {
      return { platform: 'twitch', identifier: path.split('/')[0] ?? path };
    }
    if (host.includes('youtube.com') && path) {
      // Handle @username or /c/username or /channel/id
      const parts = path.split('/');
      const first = parts[0] ?? '';
      if (first.startsWith('@')) {
        return { platform: 'youtube', identifier: first };
      }
      if ((first === 'c' || first === 'channel') && parts[1]) {
        return { platform: 'youtube', identifier: parts[1] };
      }
      return { platform: 'youtube', identifier: first };
    }
    if (host.includes('kick.com') && path) {
      return { platform: 'kick', identifier: path.split('/')[0] ?? path };
    }
    if (host.includes('tiktok.com') && path) {
      const name = path.split('/')[0] ?? '';
      return { platform: 'tiktok', identifier: name.startsWith('@') ? name : `@${name}` };
    }
  } catch {
    // Not a URL, treat as raw identifier
  }

  return { platform: defaultPlatform, identifier: trimmed };
}

export function BulkAddChannelModal({
  open,
  onClose,
  seriesId,
  broadcastDays,
  onSuccess,
}: BulkAddChannelModalProps) {
  const [input, setInput] = useState('');
  const [defaultPlatform, setDefaultPlatform] = useState<Platform>('twitch');
  const [defaultTier, setDefaultTier] = useState<ChannelTier>('community');
  const [selectedDayIds, setSelectedDayIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkChannelResult | null>(null);

  // Auto-select live days when tier is community or watch_party
  useEffect(() => {
    if (defaultTier === 'community' || defaultTier === 'watch_party') {
      const liveDayIds = broadcastDays
        .filter((d) => d.status === 'live')
        .map((d) => d.id);
      if (liveDayIds.length > 0) {
        setSelectedDayIds(new Set(liveDayIds));
      }
    } else {
      setSelectedDayIds(new Set());
    }
  }, [defaultTier, broadcastDays]);

  const bulkCreate = useCallback(
    (channels: CreateChannel[]) =>
      api.bulkCreateChannels(
        seriesId,
        channels,
        selectedDayIds.size > 0 ? Array.from(selectedDayIds) : undefined,
      ),
    [seriesId, selectedDayIds],
  );

  const { mutate, loading, error, reset } = useMutation<BulkChannelResult, [CreateChannel[]]>(bulkCreate);

  const handleSubmit = async () => {
    const lines = input.split('\n');
    const channels: CreateChannel[] = [];

    for (const line of lines) {
      const parsed = parseChannelLine(line, defaultPlatform);
      if (!parsed) continue;
      channels.push({
        platform: parsed.platform,
        channel_identifier: parsed.identifier,
        display_name: parsed.identifier.replace(/^@/, ''),
        tier: defaultTier,
      });
    }

    if (channels.length === 0) return;

    const res = await mutate(channels);
    if (res) {
      setResult(res);
      onSuccess();
    }
  };

  const handleClose = () => {
    setInput('');
    setResult(null);
    setSelectedDayIds(new Set());
    reset();
    onClose();
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

  const lineCount = input.split('\n').filter((l) => l.trim()).length;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bulk Add Channels"
      maxWidth="max-w-xl"
      footer={
        result ? (
          <Button variant="primary" onClick={handleClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={loading}
              disabled={lineCount === 0}
            >
              Add {lineCount} Channel{lineCount !== 1 ? 's' : ''}
            </Button>
          </>
        )
      }
    >
      {result ? (
        /* ── Result summary ──────────────────────────────────────────── */
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-green/20">
              <svg className="h-5 w-5 text-accent-green" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-200">
                {result.created.length} channel{result.created.length !== 1 ? 's' : ''} added
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-accent-orange">
                  {result.errors.length} error{result.errors.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-lg bg-navy-800 p-3">
              {result.errors.map((err, i) => (
                <p key={i} className="text-xs text-accent-red">
                  {typeof err === 'string' ? err : JSON.stringify(err)}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ── Input form ──────────────────────────────────────────────── */
        <div className="space-y-3">
          <FormField label="Channel URLs or identifiers (one per line)" required>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`https://twitch.tv/shroud\nhttps://youtube.com/@valorant\nkick_username`}
              rows={8}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Default platform">
              <Select
                options={PLATFORM_OPTIONS}
                value={defaultPlatform}
                onChange={(e) => setDefaultPlatform(e.target.value as Platform)}
              />
            </FormField>
            <FormField label="Default tier">
              <Select
                options={TIER_OPTIONS}
                value={defaultTier}
                onChange={(e) => setDefaultTier(e.target.value as ChannelTier)}
              />
            </FormField>
          </div>

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

          <p className="text-[11px] text-gray-600">
            URLs from Twitch, YouTube, Kick, and TikTok will auto-detect the platform.
            Raw identifiers use the default platform selected above.
          </p>

          {error && <p className="text-xs text-accent-red">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
