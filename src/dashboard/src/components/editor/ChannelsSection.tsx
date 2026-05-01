/**
 * Channels — curated list. Sits below the Leaderboard on Editor Desktop.
 *
 * Per design v4 "Channels & Discovery" spec:
 * - Filter pills (All / Active / Inactive) in the header, red-background for active
 * - 9-column table
 * - Inline row editor drawer that opens beneath the pencil-clicked row
 * - Days chip block (empty = all days) with red chips for selected days
 * - Save / Cancel / Disable (or Enable) / Delete wired to real API
 */

import { useMemo, useState } from 'react';
import type { BroadcastDay, Channel, ChannelTier, SeriesWithStages } from '@/types/api';
import {
  CollapsibleSection,
  Col,
  Row,
  Pill,
  PlatformPip,
  IconEdit,
  IconExternal,
  IconTrash,
  IconPlus,
  SortHeader,
  useSortable,
} from '@/components/design';
import { fmtDateLong } from '@/design/format';
import { getPlatform } from '@/design/platforms';
import * as api from '@/services/api';
import { AddChannelDialog } from './AddChannelDialog';

type Filter = 'all' | 'active' | 'inactive';

const TIER_LABELS: Record<ChannelTier, string> = {
  official: 'Official',
  partner: 'Partner',
  player: 'Player POV',
  community: 'Community',
  watch_party: 'Watch Party',
};

const TIER_OPTIONS: ChannelTier[] = [
  'official',
  'partner',
  'player',
  'community',
  'watch_party',
];

const PLATFORM_TONES: Record<string, 'red' | 'default'> = {
  twitch: 'red',
};

/** Column template — matches v4 spec. */
const COLS = '1.4fr 90px 64px 110px 90px 90px 100px 110px 130px';

export interface ChannelsSectionProps {
  seriesId: string;
  seriesDetail: SeriesWithStages | null;
  channels: Channel[];
  /** Fires after a server-side mutation so the parent can refetch. */
  onMutate: () => void;
}

export function ChannelsSection({
  seriesId,
  seriesDetail,
  channels,
  onMutate,
}: ChannelsSectionProps) {
  const [filter, setFilter] = useState<Filter>('active');
  const [editingId, setEditingId] = useState<string | null>(null);

  // The Channels tab is for the curated, operator-managed channel set.
  // Show:
  //   • any active channel (regardless of source)
  //   • any manual channel even if deactivated (operator deliberately
  //     added it)
  //   • any auto-discovered channel that was once approved and is now
  //     auto_paused — e.g. tracked during a day, paused after day end.
  //     These appear here with a "Re-enable" affordance so operators
  //     can resurface them for the next broadcast day.
  // Hide:
  //   • auto-discovered channels that have NEVER been approved (no
  //     auto_paused flag), since those are raw discovery candidates
  //     and belong in the Discovery Feed. Otherwise the tab fills up
  //     with junk matched on a single keyword (PASTOR matched "PAS",
  //     "ne pas", etc.).
  const curated = useMemo(
    () =>
      channels.filter((c) => {
        if (c.is_active) return true;
        if (c.source !== 'auto_discovered') return true;
        const meta = (c.metadata ?? {}) as Record<string, unknown>;
        return meta.auto_paused === true;
      }),
    [channels],
  );

  const counts = useMemo(
    () => ({
      all: curated.length,
      active: curated.filter((c) => c.is_active).length,
      inactive: curated.filter((c) => !c.is_active).length,
    }),
    [curated],
  );

  const filtered = useMemo(() => {
    if (filter === 'all') return curated;
    if (filter === 'active') return curated.filter((c) => c.is_active);
    return curated.filter((c) => !c.is_active);
  }, [curated, filter]);

  // Augment rows with derived sort keys (days count, status as number,
  // null-safe platform/region/source/language) so any column header
  // returns a sensible order.
  const sortable = useMemo(
    () =>
      filtered.map((c) => ({
        ...c,
        _days: c.broadcast_day_ids?.length ?? 0,
        _status: c.is_active ? 1 : 0,
        _platform: (c.platform ?? '').toString(),
        _region: (c.region ?? '').toString(),
        _source: (c.source ?? '').toString(),
        _tier: (c.tier ?? '').toString(),
        _name: (c.display_name ?? '').toString(),
      })),
    [filtered],
  );
  type SortableRow = typeof sortable[number];
  const lb = useSortable<SortableRow>(sortable, 'added_at', 'desc');
  const sorted = lb.sorted;

  const broadcastDays = useMemo<BroadcastDay[]>(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.flatMap((s) => s.broadcast_days);
  }, [seriesDetail]);

  const countText =
    filter === 'all'
      ? `${counts.all} total`
      : filter === 'active'
        ? `${counts.active} active`
        : `${counts.inactive} inactive`;

  // ── Mutations ────────────────────────────────────────────────────────

  const handleToggleActive = async (c: Channel) => {
    try {
      await api.toggleChannelActive(c.id, !c.is_active);
      onMutate();
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (c: Channel) => {
    if (!window.confirm(`Delete ${c.display_name}? This can't be undone.`)) return;
    try {
      await api.deleteChannel(c.id);
      onMutate();
    } catch {
      /* ignore */
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  const [addOpen, setAddOpen] = useState(false);

  return (
    <CollapsibleSection
      storageKey="ct-channels"
      eyebrow="Channels"
      title={countText}
      right={
        <Row gap={6} align="center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAddOpen(true);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 10px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--red)',
              color: '#fff',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <IconPlus size={11} /> Add channel
          </button>
          {(['all', 'active', 'inactive'] as Filter[]).map((f) => (
            <FilterPill
              key={f}
              active={filter === f}
              onClick={() => setFilter(f)}
              label={f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Inactive'}
            />
          ))}
        </Row>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          gap: 0,
          padding: '0 4px 6px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_name">Channel</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_platform">Platform</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_region">Region</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_tier">Category</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_days">Days</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_source">Source</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="_status">Status</SortHeader>
        <SortHeader sort={lb.sort as string} dir={lb.dir} onClick={lb.toggle as (k: string) => void} id="added_at">Added</SortHeader>
        <ColHead align="right">Actions</ColHead>
      </div>

      <div style={{ maxHeight: 480, overflowY: 'auto' }}>
        {sorted.map((c) => {
          const isEditing = editingId === c.id;
          const tone = PLATFORM_TONES[c.platform ?? ''] ?? 'default';
          const platformName = getPlatform(c.platform)?.name ?? c.platform;
          const dayCount = c.broadcast_day_ids?.length ?? 0;

          return (
            <div key={c.id}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: COLS,
                  alignItems: 'center',
                  padding: '9px 4px',
                  borderBottom: isEditing ? 'none' : '1px solid var(--border-faint)',
                  fontSize: 12.5,
                  background: isEditing ? 'var(--bg-sunken)' : 'transparent',
                  borderTopLeftRadius: isEditing ? 6 : 0,
                  borderTopRightRadius: isEditing ? 6 : 0,
                }}
              >
                {/* Channel */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <PlatformPip id={c.platform} />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.display_name}
                      <a
                        href={channelUrl(c)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <IconExternal size={11} />
                      </a>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: 'var(--fg-dim)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.channel_identifier}
                    </div>
                  </div>
                </div>

                {/* Platform */}
                <div>
                  <Pill tone={tone}>{platformName}</Pill>
                </div>

                {/* Region */}
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: 'var(--fg-muted)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  {c.region?.toUpperCase() || '—'}
                </div>

                {/* Tier */}
                <div style={{ fontSize: 12, color: 'var(--fg)' }}>
                  {TIER_LABELS[c.tier]}
                </div>

                {/* Days */}
                <div
                  style={{
                    fontSize: 12,
                    color: dayCount > 0 ? 'var(--fg)' : 'var(--fg-dim)',
                  }}
                >
                  {dayCount > 0 ? `${dayCount} day${dayCount === 1 ? '' : 's'}` : 'All Days'}
                </div>

                {/* Source */}
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  {c.source === 'manual' ? 'Manual' : 'Discovery'}
                </div>

                {/* Status */}
                <Row gap={6}>
                  <span
                    className="dot"
                    style={{
                      background: c.is_active ? 'var(--live)' : 'var(--fg-faint)',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: c.is_active ? 'var(--live)' : 'var(--fg-dim)',
                    }}
                  >
                    {c.is_active ? 'Active' : 'Inactive'}
                  </span>
                </Row>

                {/* Added */}
                <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {fmtDateLong(c.added_at)}
                </div>

                {/* Actions */}
                <Row gap={6} justify="flex-end">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    title="Edit"
                    onClick={() => setEditingId(isEditing ? null : c.id)}
                    style={{
                      color: isEditing ? 'var(--red)' : 'var(--fg-muted)',
                      padding: 4,
                    }}
                  >
                    <IconEdit size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => handleToggleActive(c)}
                    title={c.is_active ? 'Disable' : 'Enable'}
                    style={{
                      fontSize: 10.5,
                      color: c.is_active ? 'var(--fg-muted)' : 'var(--live)',
                      padding: '2px 6px',
                    }}
                  >
                    {c.is_active ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    title="Delete"
                    onClick={() => handleDelete(c)}
                    style={{ color: 'var(--danger)', padding: 4 }}
                  >
                    <IconTrash size={12} />
                  </button>
                </Row>
              </div>

              {/* Inline row editor drawer */}
              {isEditing && (
                <InlineRowEditor
                  channel={c}
                  broadcastDays={broadcastDays}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    onMutate();
                  }}
                />
              )}
            </div>
          );
        })}

        {sorted.length === 0 && (
          <div className="placeholder" style={{ margin: 12, height: 80 }}>
            No channels match this filter
          </div>
        )}
      </div>

      <AddChannelDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        seriesId={seriesId}
        broadcastDays={broadcastDays}
        onAdded={onMutate}
      />
    </CollapsibleSection>
  );
}

// ── Inline row editor ──────────────────────────────────────────────────

function InlineRowEditor({
  channel,
  broadcastDays,
  onCancel,
  onSaved,
}: {
  channel: Channel;
  broadcastDays: BroadcastDay[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(channel.display_name);
  const [language, setLanguage] = useState(channel.language ?? '');
  const [region, setRegion] = useState(channel.region ?? '');
  const [tier, setTier] = useState<ChannelTier>(channel.tier);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(
    () => new Set(channel.broadcast_day_ids ?? []),
  );
  const [saving, setSaving] = useState(false);

  const toggleDay = (id: string) => {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateChannel(channel.id, {
        display_name: displayName.trim() || channel.display_name,
        language: language.trim() || undefined,
        region: region.trim() || undefined,
        tier,
      });
      await api.updateChannelDays(channel.id, Array.from(selectedDays));
      onSaved();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        background: 'var(--bg-sunken)',
        borderBottomLeftRadius: 6,
        borderBottomRightRadius: 6,
        borderBottom: '1px solid var(--border-faint)',
        padding: '12px 16px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* 4-column field grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Field label="Display name">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={fieldStyle}
          />
        </Field>
        <Field label="Language">
          <input
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en / tr / ko …"
            style={fieldStyle}
          />
        </Field>
        <Field label="Region">
          <input
            type="text"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="global / west / east …"
            style={fieldStyle}
          />
        </Field>
        <Field label="Category">
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as ChannelTier)}
            style={fieldStyle}
          >
            {TIER_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Broadcast days chips */}
      {broadcastDays.length > 0 && (
        <Col gap={6}>
          <div className="eyebrow" style={{ fontSize: 9 }}>
            Broadcast days (empty = all days)
          </div>
          <Row gap={6} wrap>
            {broadcastDays.map((d) => {
              const selected = selectedDays.has(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDay(d.id)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    background: selected
                      ? 'color-mix(in oklab, var(--red) 18%, transparent)'
                      : 'var(--bg-card)',
                    border: `1px solid ${
                      selected
                        ? 'color-mix(in oklab, var(--red) 60%, transparent)'
                        : 'var(--border)'
                    }`,
                    color: selected ? 'var(--red)' : 'var(--fg-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {d.label}
                </button>
              );
            })}
          </Row>
        </Col>
      )}

      {/* Actions */}
      <Row justify="flex-end" gap={8}>
        <button type="button" className="btn btn-xs" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-xs btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </Row>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function FilterPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontWeight: 600,
        background: active ? 'var(--red)' : 'transparent',
        border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
        color: active ? 'white' : 'var(--fg-muted)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function ColHead({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--fg-dim)',
        textAlign: align,
      }}
    >
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Col gap={4}>
      <div className="eyebrow" style={{ fontSize: 9 }}>
        {label}
      </div>
      {children}
    </Col>
  );
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--bg-card)',
  color: 'var(--fg)',
};

function channelUrl(c: Channel): string {
  const id = c.channel_identifier;
  switch (c.platform) {
    case 'twitch':
      return `https://twitch.tv/${id}`;
    case 'youtube':
      // YouTube identifiers can be UCxxx channel ids or @handles or yt-video:IDs
      if (id.startsWith('yt-video:')) return `https://www.youtube.com/watch?v=${id.slice(9)}`;
      if (id.startsWith('@')) return `https://www.youtube.com/${id}`;
      return `https://www.youtube.com/channel/${id}`;
    case 'kick':
      return `https://kick.com/${id}`;
    case 'tiktok':
      return `https://www.tiktok.com/${id.startsWith('@') ? id : '@' + id}/live`;
    case 'steam':
      return `https://steamcommunity.com/broadcast/watch/${id}`;
    case 'soop':
      return `https://www.sooplive.co.kr/${id}`;
    case 'chzzk':
      return `https://chzzk.naver.com/${id}`;
    case 'trovo':
      return `https://trovo.live/${id}`;
    default:
      return '#';
  }
}
