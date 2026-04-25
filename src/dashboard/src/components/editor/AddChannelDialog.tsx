/**
 * AddChannelDialog — operator-facing modal for adding channels to the
 * current series. Two tabs: "Add one" and "Bulk import".
 *
 * Platform is picked by the user (no URL auto-detection) — keeps the
 * channel_identifier exactly as typed so YouTube handles, channel IDs,
 * Steam vanity slugs etc. all flow through unchanged.
 */

import { useEffect, useMemo, useState } from 'react';
import * as api from '@/services/api';
import { Row, Col, IconX, IconPlus } from '@/components/design';
import type {
  Platform,
  ChannelTier,
  CreateChannel,
  BroadcastDay,
} from '@/types/api';

export interface AddChannelDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  broadcastDays: BroadcastDay[];
  onAdded: () => void;
}

const PLATFORMS: Array<{ id: Platform; label: string }> = [
  { id: 'twitch', label: 'Twitch' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'kick', label: 'Kick' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'steam', label: 'Steam' },
  { id: 'trovo', label: 'Trovo' },
  { id: 'chzzk', label: 'CHZZK' },
  { id: 'soop', label: 'SOOP' },
];

const TIERS: Array<{ id: ChannelTier; label: string }> = [
  { id: 'official', label: 'Official' },
  { id: 'partner', label: 'Partner' },
  { id: 'player', label: 'Player POV' },
  { id: 'community', label: 'Community' },
  { id: 'watch_party', label: 'Watch Party' },
];

type Mode = 'one' | 'bulk';

export function AddChannelDialog({
  open,
  onClose,
  seriesId,
  broadcastDays,
  onAdded,
}: AddChannelDialogProps) {
  const [mode, setMode] = useState<Mode>('one');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Single-add fields
  const [platform, setPlatform] = useState<Platform>('twitch');
  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tier, setTier] = useState<ChannelTier>('community');
  const [region, setRegion] = useState('EU');
  const [language, setLanguage] = useState('EN');
  const [multiStream, setMultiStream] = useState(false);
  const [selectedDayIds, setSelectedDayIds] = useState<Set<string>>(new Set());

  // Bulk-add fields
  const [bulkText, setBulkText] = useState('');

  // Reset state on open
  useEffect(() => {
    if (!open) return;
    setMode('one');
    setBusy(false);
    setError(null);
    setSuccess(null);
    setPlatform('twitch');
    setIdentifier('');
    setDisplayName('');
    setTier('community');
    setRegion('EU');
    setLanguage('EN');
    setMultiStream(false);
    setSelectedDayIds(new Set());
    setBulkText('');
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const sortedDays = useMemo(
    () => [...broadcastDays].sort((a, b) => a.date.localeCompare(b.date)),
    [broadcastDays],
  );

  const toggleDay = (id: string) => {
    setSelectedDayIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddOne = async () => {
    const id = identifier.trim();
    if (!id) {
      setError('Channel handle required');
      return;
    }
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const data: CreateChannel = {
        platform,
        channel_identifier: id,
        display_name: displayName.trim() || id,
        language: language.trim() || undefined,
        region: region.trim() || undefined,
        tier,
        is_active: true,
        broadcast_day_ids: selectedDayIds.size > 0 ? Array.from(selectedDayIds) : undefined,
        ...(platform === 'youtube' && multiStream
          ? { metadata: { multi_stream: true } }
          : {}),
      };
      await api.createChannel(seriesId, data);
      setSuccess(`Added ${id}`);
      onAdded();
      // Clear identifier so the operator can immediately type the next one
      setIdentifier('');
      setDisplayName('');
      setMultiStream(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add channel');
    } finally {
      setBusy(false);
    }
  };

  const handleBulk = async () => {
    const lines = bulkText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError('Add one or more channel handles, one per line');
      return;
    }
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const channels: CreateChannel[] = lines.map((line) => ({
        platform,
        channel_identifier: line,
        display_name: line,
        language: language.trim() || undefined,
        region: region.trim() || undefined,
        tier,
        is_active: true,
      }));
      const broadcastDayIds = selectedDayIds.size > 0 ? Array.from(selectedDayIds) : undefined;
      const result = await api.bulkCreateChannels(seriesId, channels, broadcastDayIds);
      const created = result.created?.length ?? 0;
      const skipped = lines.length - created;
      setSuccess(
        `Added ${created} channel${created === 1 ? '' : 's'}${skipped > 0 ? ` · ${skipped} skipped` : ''}`,
      );
      onAdded();
      setBulkText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk import failed');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const fieldStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
    fontSize: 13,
    padding: '8px 10px',
    borderRadius: 6,
    width: '100%',
    outline: 'none',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--fg-dim)',
    marginBottom: 6,
    display: 'block',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'color-mix(in oklab, var(--bg) 60%, rgba(0,0,0,0.55))',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 720,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <Row
          justify="space-between"
          align="flex-start"
          style={{
            padding: '18px 22px 14px',
            borderBottom: '1px solid var(--border-faint)',
          }}
        >
          <Col gap={3} style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Add channel</h3>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Manually track a channel, or bulk-import a list.
            </div>
          </Col>
          <button
            onClick={onClose}
            className="btn"
            style={{ padding: 5, background: 'transparent', border: 'none' }}
            title="Close"
          >
            <IconX size={14} />
          </button>
        </Row>

        <div style={{ padding: '16px 22px', overflowY: 'auto' }}>
          <div
            style={{
              display: 'inline-flex',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 2,
              marginBottom: 18,
            }}
          >
            {(['one', 'bulk'] as Mode[]).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                    background: active ? 'var(--red)' : 'transparent',
                    color: active ? '#fff' : 'var(--fg-muted)',
                    transition: 'background 140ms',
                  }}
                >
                  {m === 'one' ? 'Add one' : 'Bulk import'}
                </button>
              );
            })}
          </div>

          {/* Platform — shared between modes */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
              style={fieldStyle}
            >
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {mode === 'one' ? (
            <>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Channel handle / ID</label>
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={
                    platform === 'twitch'
                      ? 'pubg_emea_en'
                      : platform === 'youtube'
                        ? '@PUBG or UCxxxxxxxxxxxxxxxxxxxxx (handle, channel ID, or watch?v=… for a single stream)'
                        : platform === 'kick'
                          ? 'channel slug'
                          : platform === 'tiktok'
                            ? '@username'
                            : platform === 'steam'
                              ? '76561198… or vanity name'
                              : 'username'
                  }
                  style={fieldStyle}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Display name (optional)</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Defaults to the handle"
                  style={fieldStyle}
                />
              </div>
              {platform === 'youtube' && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    marginBottom: 14,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={multiStream}
                    onChange={(e) => setMultiStream(e.target.checked)}
                  />
                  Multi-stream channel — track all simultaneous live streams
                </label>
              )}
            </>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Channel handles · one per line</label>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={8}
                placeholder={
                  'pubg_emea_en\npubg_emea_ru\nneLLe\n…'
                }
                style={{
                  ...fieldStyle,
                  fontFamily: 'var(--font-mono)',
                  resize: 'vertical',
                }}
              />
              <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 6 }}>
                All entries get the platform, category, region and language picked above.
              </div>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div>
              <label style={labelStyle}>Category</label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as ChannelTier)}
                style={fieldStyle}
              >
                {TIERS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Region</label>
              <input
                type="text"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="EU / NA / APAC …"
                style={fieldStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Language</label>
              <input
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="EN"
                maxLength={5}
                style={fieldStyle}
              />
            </div>
          </div>

          {sortedDays.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Broadcast days</label>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 8,
                }}
              >
                {sortedDays.map((d) => {
                  const sel = selectedDayIds.has(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleDay(d.id)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 999,
                        fontSize: 11.5,
                        fontWeight: 500,
                        border: '1px solid',
                        borderColor: sel ? 'var(--red)' : 'var(--border)',
                        background: sel ? 'color-mix(in oklab, var(--red) 18%, transparent)' : 'transparent',
                        color: sel ? 'var(--red)' : 'var(--fg-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      {d.label}
                      {d.status === 'live' ? ' ●' : ''}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 6 }}>
                Empty = all days
              </div>
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>
              {error}
            </div>
          )}
          {success && !error && (
            <div style={{ fontSize: 12, color: 'var(--ok, #4caf50)', marginBottom: 10 }}>
              {success}
            </div>
          )}
        </div>

        <Row
          justify="flex-end"
          gap={8}
          style={{
            padding: '12px 22px',
            borderTop: '1px solid var(--border-faint)',
            background: 'var(--bg-raised)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--fg)',
              fontSize: 13,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={mode === 'one' ? handleAddOne : handleBulk}
            disabled={busy}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--red)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <IconPlus size={12} />
            {busy ? 'Adding…' : mode === 'one' ? 'Add channel' : 'Add channels'}
          </button>
        </Row>
      </div>
    </div>
  );
}
