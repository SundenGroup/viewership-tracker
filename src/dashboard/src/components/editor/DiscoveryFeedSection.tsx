/**
 * Discovery feed — auto-discovered candidates awaiting action.
 *
 * Mirrors the legacy DiscoveryFeedPanel behavior exactly:
 *
 *   Filter:
 *     - Only channels where source === 'auto_discovered'
 *     - Active channels always kept (pending approval flow)
 *     - Inactive channels kept when:
 *         · they have metadata.last_seen_at  (re-surfaced by discovery), OR
 *         · they have metadata.auto_paused,   OR
 *         · they are in the series blocklist (so we can show "Blocked")
 *
 *   Per-row state (in priority order):
 *     - Pending     — active + tier === 'community' → [Approve] [Block]
 *     - Blocked     — inactive + in blocklist        → "BLOCKED" label
 *     - Re-enable   — inactive + last_seen_at        → [Re-enable]
 *                     (previously promoted or auto-paused)
 *
 *   Sort chips (Recent / Viewers / Platform / Name / Lang) + source filter
 *   dropdown + "Clear all" header action — all preserved from legacy.
 */

import { useCallback, useMemo, useState } from 'react';
import type { Channel } from '@/types/api';
import {
  CollapsibleSection,
  Col,
  Row,
  PlatformPip,
  IconX,
  IconExternal,
} from '@/components/design';
import { fmtCompact, fmtRelative } from '@/design/format';
import * as api from '@/services/api';

type SortKey = 'recent' | 'viewers' | 'platform' | 'name' | 'lang';

export interface DiscoveryFeedSectionProps {
  seriesId: string;
  channels: Channel[];
  defaultTier: string;
  /** Series metadata.blocklist — identifiers that have been explicitly blocked. */
  blocklist?: string[];
  onMutate: () => void;
}

export function DiscoveryFeedSection({
  seriesId,
  channels,
  defaultTier,
  blocklist = [],
  onMutate,
}: DiscoveryFeedSectionProps) {
  const [sort, setSort] = useState<SortKey>('recent');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // Keep a client-side "just acted" map so the row can render an
  // "Approved" / "Blocked" badge for a moment before the list refetches.
  const [acted, setActed] = useState<Record<string, 'approved' | 'blocked'>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const blocklistSet = useMemo(() => new Set(blocklist), [blocklist]);

  // ── Filter to the same set the legacy panel shows ───────────────────────
  const visibleChannels = useMemo(() => {
    return channels.filter((c) => {
      if (c.source !== 'auto_discovered') return false;
      if (c.is_active) return true;
      // Inactive channels: keep if blocked (we'll render a Blocked badge),
      // or if there's evidence they were re-discovered / auto-paused.
      if (blocklistSet.has(c.channel_identifier)) return true;
      const md = c.metadata as
        | { last_seen_at?: string; auto_paused?: boolean }
        | undefined;
      return !!md?.last_seen_at || !!md?.auto_paused;
    });
  }, [channels, blocklistSet]);

  const rows = useMemo(() => {
    return visibleChannels.map((c) => {
      const md = (c.metadata ?? {}) as {
        stream_title?: string;
        discovered_ccv?: number;
        source?: string;
        last_seen_at?: string;
        auto_paused?: boolean;
        auto_paused_reason?: string;
        paused_at?: string;
      };
      const inBlocklist = blocklistSet.has(c.channel_identifier);
      const autoPaused = !!md.auto_paused;
      const actedState = acted[c.id];

      // State machine mirrors legacy:
      //   pending  : active + tier='community' + not yet acted
      //   blocked  : inactive + inBlocklist
      //   disabled : inactive + has last_seen_at + (tier !== community OR autoPaused)
      //   (else)   : ignored by filter
      const isPending =
        !actedState && c.is_active && c.tier === 'community';
      const isBlocked = !actedState && !c.is_active && inBlocklist;
      const isDisabled =
        !actedState &&
        !c.is_active &&
        !inBlocklist &&
        !!md.last_seen_at &&
        (c.tier !== 'community' || autoPaused);

      return {
        id: c.id,
        name: c.display_name,
        handle: c.channel_identifier,
        platform: c.platform,
        viewers: Number(md.discovered_ccv ?? 0) || 0,
        title: md.stream_title ?? '',
        lang: (c.language ?? '').toUpperCase(),
        source: md.source ?? 'keyword',
        reason: md.auto_paused_reason ?? '',
        pausedAt: md.paused_at ?? md.last_seen_at ?? c.added_at,
        addedAt: c.added_at,
        tier: c.tier,
        autoPaused,
        isPending,
        isBlocked,
        isDisabled,
        actedState,
      };
    });
  }, [visibleChannels, acted, blocklistSet]);

  const sourceOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.source))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    if (sourceFilter === 'all') return rows;
    return rows.filter((r) => r.source === sourceFilter);
  }, [rows, sourceFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sort) {
        case 'viewers':
          return b.viewers - a.viewers;
        case 'platform':
          return (
            (a.platform ?? '').localeCompare(b.platform ?? '') ||
            a.name.localeCompare(b.name)
          );
        case 'name':
          return a.name.localeCompare(b.name);
        case 'lang':
          return (
            (a.lang || 'ZZZ').localeCompare(b.lang || 'ZZZ') ||
            b.viewers - a.viewers
          );
        case 'recent':
        default:
          // Re-surfaced channels (with last_seen_at) first, then added_at desc.
          return (
            (b.pausedAt || b.addedAt).localeCompare(
              a.pausedAt || a.addedAt,
            ) || 0
          );
      }
    });
    return arr;
  }, [filtered, sort]);

  // ── Row actions ─────────────────────────────────────────────────────────

  const setRowBusy = (id: string, v: boolean) =>
    setBusy((m) => ({ ...m, [id]: v }));

  const handleApprove = useCallback(
    async (id: string) => {
      setRowBusy(id, true);
      setRowError((m) => ({ ...m, [id]: '' }));
      try {
        await api.promoteChannel(id, defaultTier);
        setActed((m) => ({ ...m, [id]: 'approved' }));
        onMutate();
      } catch (err) {
        setRowError((m) => ({
          ...m,
          [id]: err instanceof Error ? err.message : 'Failed to approve',
        }));
      } finally {
        setRowBusy(id, false);
      }
    },
    [defaultTier, onMutate],
  );

  const handleBlock = useCallback(
    async (id: string) => {
      setRowBusy(id, true);
      setRowError((m) => ({ ...m, [id]: '' }));
      try {
        await api.blockChannel(seriesId, id);
        setActed((m) => ({ ...m, [id]: 'blocked' }));
        onMutate();
      } catch (err) {
        setRowError((m) => ({
          ...m,
          [id]: err instanceof Error ? err.message : 'Failed to block',
        }));
      } finally {
        setRowBusy(id, false);
      }
    },
    [seriesId, onMutate],
  );

  // Re-enable re-promotes to the channel's existing tier (not defaultTier)
  // so a Partner that was disabled comes back as Partner, not community.
  const handleReEnable = useCallback(
    async (id: string, tier: string) => {
      setRowBusy(id, true);
      setRowError((m) => ({ ...m, [id]: '' }));
      try {
        await api.promoteChannel(id, tier || defaultTier);
        setActed((m) => ({ ...m, [id]: 'approved' }));
        onMutate();
      } catch (err) {
        setRowError((m) => ({
          ...m,
          [id]: err instanceof Error ? err.message : 'Failed to re-enable',
        }));
      } finally {
        setRowBusy(id, false);
      }
    },
    [defaultTier, onMutate],
  );

  const handleClearAll = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await api.clearDiscoveryFeed(seriesId);
      onMutate();
    } catch {
      /* ignore */
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }, [seriesId, confirmClear, onMutate]);

  return (
    <CollapsibleSection
      storageKey="ct-discovery"
      eyebrow="Discovery feed"
      title={`${rows.length} auto-discovered channels`}
      right={
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={handleClearAll}
          onBlur={() => setConfirmClear(false)}
          disabled={clearing || rows.length === 0}
          style={{
            color: confirmClear ? 'white' : 'var(--fg-muted)',
            background: confirmClear ? 'var(--danger)' : undefined,
            border: confirmClear ? '1px solid var(--danger)' : undefined,
          }}
        >
          <IconX size={11} />{' '}
          {clearing ? 'Clearing…' : confirmClear ? 'Confirm?' : 'Clear all'}
        </button>
      }
    >
      {/* Sort chip group + source dropdown */}
      <Row justify="space-between" style={{ marginBottom: 10 }} wrap>
        <Row gap={8}>
          <span className="eyebrow" style={{ fontSize: 10 }}>
            Sort
          </span>
          <Row gap={4}>
            {(['recent', 'viewers', 'platform', 'name', 'lang'] as SortKey[]).map(
              (s) => (
                <SortPill
                  key={s}
                  active={sort === s}
                  onClick={() => setSort(s)}
                  label={capitalise(s)}
                />
              ),
            )}
          </Row>
        </Row>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontSize: 11,
            padding: '4px 8px',
            borderRadius: 4,
          }}
        >
          <option value="all">All sources</option>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Row>

      {/* Rows */}
      <div style={{ maxHeight: 480, overflowY: 'auto' }}>
        {sorted.map((r) => {
          const isBusy = !!busy[r.id];
          const error = rowError[r.id];
          return (
            <div
              key={r.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                alignItems: 'center',
                gap: 16,
                padding: '10px 4px',
                borderBottom: '1px solid var(--border-faint)',
              }}
            >
              <Col gap={6} style={{ minWidth: 0 }}>
                <Row gap={8} wrap style={{ minWidth: 0 }}>
                  <Row gap={4}>
                    <PlatformPip id={r.platform} size={10} />
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 260,
                      }}
                    >
                      {r.name}
                    </span>
                    <a
                      href={channelUrl(r.platform, r.handle)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'var(--fg-dim)',
                        display: 'inline-flex',
                      }}
                    >
                      <IconExternal size={11} />
                    </a>
                  </Row>
                  {r.lang && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: 'var(--fg-muted)',
                        padding: '2px 6px',
                        borderRadius: 3,
                        background: 'var(--bg-sunken)',
                        letterSpacing: '0.08em',
                      }}
                    >
                      {r.lang}
                    </span>
                  )}
                  {r.autoPaused && (
                    <StatusChip tone="warn" label="Auto-paused" />
                  )}
                  {r.isPending && <StatusChip tone="info" label="Pending" />}
                  {r.isBlocked && <StatusChip tone="danger" label="Blocked" />}
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                      marginLeft: 'auto',
                    }}
                  >
                    {fmtCompact(r.viewers)} viewers
                  </span>
                </Row>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--fg-dim)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.title || undefined}
                >
                  {r.title || (
                    <span style={{ fontStyle: 'italic' }}>no title</span>
                  )}
                  {r.handle ? ` · ${r.handle}` : ''} · {fmtRelative(r.pausedAt)}
                  {r.reason ? ` · ${r.reason}` : ''}
                  {error && (
                    <span style={{ color: 'var(--danger)' }}> · {error}</span>
                  )}
                </div>
              </Col>

              <Row gap={6}>
                {r.actedState === 'approved' && (
                  <StatusChip tone="live" label="Approved" />
                )}
                {r.actedState === 'blocked' && (
                  <StatusChip tone="danger" label="Blocked" />
                )}
                {r.isPending && !r.actedState && (
                  <>
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      style={{ padding: '6px 12px' }}
                      onClick={() => handleApprove(r.id)}
                      disabled={isBusy}
                    >
                      {isBusy ? '…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs"
                      style={{
                        padding: '6px 12px',
                        background: 'transparent',
                        color: 'var(--danger)',
                        border: '1px solid var(--danger)',
                      }}
                      onClick={() => handleBlock(r.id)}
                      disabled={isBusy}
                    >
                      {isBusy ? '…' : 'Block'}
                    </button>
                  </>
                )}
                {r.isDisabled && !r.actedState && (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    style={{ padding: '6px 14px' }}
                    onClick={() => handleReEnable(r.id, r.tier)}
                    disabled={isBusy}
                  >
                    {isBusy ? '…' : 'Re-enable'}
                  </button>
                )}
              </Row>
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="placeholder" style={{ margin: 12, height: 80 }}>
            No auto-discovered channels
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function StatusChip({
  tone,
  label,
}: {
  tone: 'warn' | 'info' | 'danger' | 'live';
  label: string;
}) {
  const toneVar =
    tone === 'warn'
      ? 'var(--warn)'
      : tone === 'danger'
        ? 'var(--danger)'
        : tone === 'live'
          ? 'var(--live)'
          : 'var(--info)';
  return (
    <span
      style={{
        background: `color-mix(in oklab, ${toneVar} 16%, transparent)`,
        color: toneVar,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 3,
      }}
    >
      {label}
    </span>
  );
}

function SortPill({
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
        fontSize: 10.5,
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

function capitalise(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function channelUrl(platform: string | null, id: string): string {
  switch (platform) {
    case 'twitch':
      return `https://twitch.tv/${id}`;
    case 'youtube':
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
