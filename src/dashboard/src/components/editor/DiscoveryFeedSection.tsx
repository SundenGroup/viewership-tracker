/**
 * Discovery feed — auto-paused candidates with "Re-enable" CTA.
 *
 * Per design v4:
 * - Sort chip group (Recent · Viewers · Platform · Name · Lang)
 * - Source dropdown filter (All + discovery sources)
 * - Clear-all header action
 * - Each row shows an orange "Auto-paused" badge, viewer count, title/handle/ago
 * - Right-side Re-enable btn-primary (promotes the channel, toggles active)
 */

import { useMemo, useState } from 'react';
import type { Channel } from '@/types/api';
import {
  CollapsibleSection,
  Col,
  Row,
  Pill,
  PlatformPip,
  IconX,
  IconExternal,
} from '@/components/design';
import { fmtCompact, fmtRelative } from '@/design/format';
import { getPlatform } from '@/design/platforms';
import * as api from '@/services/api';

type SortKey = 'recent' | 'viewers' | 'platform' | 'name' | 'lang';

export interface DiscoveryFeedSectionProps {
  seriesId: string;
  channels: Channel[];
  defaultTier: string;
  onMutate: () => void;
}

export function DiscoveryFeedSection({
  seriesId,
  channels,
  defaultTier,
  onMutate,
}: DiscoveryFeedSectionProps) {
  const [sort, setSort] = useState<SortKey>('recent');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [clearing, setClearing] = useState(false);

  // Only show channels that are currently auto-paused / pending review.
  const autoPausedRows = useMemo(() => {
    return channels
      .filter((c) => {
        const md = c.metadata as { auto_paused?: boolean; source?: string };
        const autoPaused = md?.auto_paused === true;
        const pendingAutoDiscovered = c.source === 'auto_discovered' && !c.is_active;
        return autoPaused || pendingAutoDiscovered;
      })
      .map((c) => {
        const md = c.metadata as {
          stream_title?: string;
          discovered_ccv?: number;
          source?: string;
          last_seen_at?: string;
          auto_paused_reason?: string;
          paused_at?: string;
        };
        return {
          id: c.id,
          name: c.display_name,
          handle: c.channel_identifier,
          platform: c.platform,
          viewers: Number(md.discovered_ccv ?? 0) || 0,
          title: md.stream_title ?? '',
          lang: c.language ?? '',
          source: md.source ?? 'keyword',
          reason: md.auto_paused_reason ?? '',
          pausedAt: md.paused_at ?? md.last_seen_at ?? c.added_at,
          addedAt: c.added_at,
        };
      });
  }, [channels]);

  const sourceOptions = useMemo(
    () => Array.from(new Set(autoPausedRows.map((r) => r.source))).sort(),
    [autoPausedRows],
  );

  const filtered = useMemo(() => {
    if (sourceFilter === 'all') return autoPausedRows;
    return autoPausedRows.filter((r) => r.source === sourceFilter);
  }, [autoPausedRows, sourceFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sort) {
        case 'viewers':
          return b.viewers - a.viewers;
        case 'platform':
          return (a.platform ?? '').localeCompare(b.platform ?? '');
        case 'name':
          return a.name.localeCompare(b.name);
        case 'lang':
          return a.lang.localeCompare(b.lang);
        case 'recent':
        default:
          return b.pausedAt.localeCompare(a.pausedAt);
      }
    });
    return arr;
  }, [filtered, sort]);

  const handleReEnable = async (rowId: string) => {
    try {
      // Promote to the series' default tier + toggle active so it lands in Channels.
      await api.promoteChannel(rowId, defaultTier);
      await api.toggleChannelActive(rowId, true);
      onMutate();
    } catch {
      /* ignore */
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm('Clear all auto-paused discovery candidates?')) return;
    setClearing(true);
    try {
      await api.clearDiscoveryFeed(seriesId);
      onMutate();
    } catch {
      /* ignore */
    } finally {
      setClearing(false);
    }
  };

  return (
    <CollapsibleSection
      storageKey="ct-discovery"
      eyebrow="Discovery feed"
      title={`${autoPausedRows.length} auto-discovered channels`}
      right={
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={handleClearAll}
          disabled={clearing || autoPausedRows.length === 0}
          style={{ color: 'var(--fg-muted)' }}
        >
          <IconX size={11} /> Clear all
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
            {(['recent', 'viewers', 'platform', 'name', 'lang'] as SortKey[]).map((s) => (
              <SortPill key={s} active={sort === s} onClick={() => setSort(s)} label={capitalise(s)} />
            ))}
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
          const platformName = getPlatform(r.platform)?.name ?? r.platform;
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
                  <Pill>{platformName ?? '—'}</Pill>
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
                      style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}
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
                        textTransform: 'uppercase',
                      }}
                    >
                      {r.lang}
                    </span>
                  )}
                  <span
                    style={{
                      background: 'color-mix(in oklab, var(--warn) 16%, transparent)',
                      color: 'var(--warn)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      borderRadius: 3,
                    }}
                  >
                    Auto-paused
                  </span>
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
                  {r.title || <span style={{ fontStyle: 'italic' }}>no title</span>}
                  {r.handle ? ` · ${r.handle}` : ''} · {fmtRelative(r.pausedAt)}
                  {r.reason ? ` · ${r.reason}` : ''}
                </div>
              </Col>

              <button
                type="button"
                className="btn btn-xs btn-primary"
                style={{ padding: '6px 14px' }}
                onClick={() => handleReEnable(r.id)}
              >
                Re-enable
              </button>
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="placeholder" style={{ margin: 12, height: 80 }}>
            No auto-paused candidates
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

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
