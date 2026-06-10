/**
 * StartPage — the authenticated "home" landing page shown when no series
 * is selected in the URL. Gives operators a real dashboard feel: a greeting,
 * live operational stats, filterable + searchable grid of series cards,
 * and a prominent "New series" CTA.
 */

import { useMemo, useState } from 'react';
import {
  Row,
  Col,
  IconPlus,
  IconSearch,
  IconBolt,
  PublicLinkButton,
} from '@/components/design';
import { fmtDateLong, fmtRelative } from '@/design/format';
import { useAuth } from '@/hooks/useAuth';
import { LiveNowStrip } from './home/LiveNowStrip';
import { QuickNavCards } from './home/QuickNavCards';
import type {
  TournamentSeries,
  TournamentStatus,
  OrchestratorStatus,
} from '@/types/api';

export interface StartPageProps {
  seriesList: TournamentSeries[];
  pollingStatus: OrchestratorStatus | null;
  onSeriesChange: (id: string) => void;
  onCreate: () => void;
}

type StatusFilter = 'all' | 'active' | 'draft' | 'completed';

export function StartPage({
  seriesList,
  pollingStatus,
  onSeriesChange,
  onCreate,
}: StartPageProps) {
  const { user, isAdmin, isEditor } = useAuth();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');

  // ── Derived ─────────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: seriesList.length,
      active: 0,
      draft: 0,
      completed: 0,
    };
    for (const s of seriesList) {
      if (s.status === 'active') c.active++;
      else if (s.status === 'draft') c.draft++;
      else if (s.status === 'completed') c.completed++;
    }
    return c;
  }, [seriesList]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return seriesList
      .filter((s) => (filter === 'all' ? true : s.status === filter))
      .filter((s) => {
        if (!needle) return true;
        return (
          s.name.toLowerCase().includes(needle) ||
          (s.short_name ?? '').toLowerCase().includes(needle) ||
          (s.game ?? '').toLowerCase().includes(needle) ||
          (s.partner ?? '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        // Active first, then draft, then completed — within each, newest updated first
        const order = { active: 0, draft: 1, completed: 2 };
        const oa = order[a.status as keyof typeof order] ?? 9;
        const ob = order[b.status as keyof typeof order] ?? 9;
        if (oa !== ob) return oa - ob;
        return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
      });
  }, [seriesList, filter, q]);

  const greeting = useMemo(() => greet(user?.display_name ?? null), [user]);
  const today = useMemo(() => fmtToday(), []);

  const pollingLabel =
    pollingStatus?.state === 'running'
      ? `Polling · ${pollingStatus.lastPollTime ? fmtRelative(pollingStatus.lastPollTime) : 'just now'}`
      : 'Polling stopped';

  // ── Render ──────────────────────────────────────────────────────────────
  // The global TopNav owns brand / nav / theme / user — StartPage renders
  // only its content body below it.

  return (
      <div
        style={{
          padding: '28px 32px 40px',
          maxWidth: 1200,
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
      {/* Hero */}
      <Row
        justify="space-between"
        align="flex-start"
        style={{ marginBottom: 22, flexWrap: 'wrap', gap: 16 }}
      >
        <Col gap={4} style={{ minWidth: 0 }}>
          <div className="eyebrow" style={{ fontSize: 10.5, letterSpacing: 0.5 }}>
            Dashboard
          </div>
          <h1
            style={{
              fontSize: 28,
              lineHeight: 1.1,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            {greeting}
          </h1>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{today}</div>
        </Col>
        {isAdmin && (
          <button
            type="button"
            onClick={onCreate}
            className="btn btn-primary"
            style={{
              fontSize: 13,
              padding: '8px 14px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <IconPlus size={13} /> New series
          </button>
        )}
      </Row>

      {/* Stat strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
          marginBottom: 24,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          overflow: 'hidden',
        }}
      >
        <Stat
          label="Series"
          value={String(seriesList.length)}
          sub={`${counts.active} active · ${counts.draft} draft · ${counts.completed} done`}
        />
        <Stat
          label="Live broadcast days"
          value={String(pollingStatus?.activeBroadcastDays ?? 0)}
          sub={
            (pollingStatus?.activeBroadcastDays ?? 0) > 0
              ? 'Polling now'
              : 'Nothing live right now'
          }
          accent={(pollingStatus?.activeBroadcastDays ?? 0) > 0}
        />
        <Stat
          label="Orchestrator"
          value={pollingStatus?.state === 'running' ? 'Running' : 'Stopped'}
          sub={pollingLabel}
          accent={pollingStatus?.state === 'running'}
          divided={false}
        />
      </div>

      {/* Live now — series currently broadcasting */}
      <LiveNowStrip canEdit={isEditor} />

      {/* Quick nav into the app's other surfaces */}
      <QuickNavCards canExplore={isEditor} />

      {/* Filters + search */}
      <Row
        justify="space-between"
        align="center"
        style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}
      >
        <div
          style={{
            display: 'inline-flex',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            borderRadius: 7,
            padding: 3,
          }}
        >
          {(
            [
              ['all', 'All', counts.all],
              ['active', 'Active', counts.active],
              ['draft', 'Drafts', counts.draft],
              ['completed', 'Completed', counts.completed],
            ] as Array<[StatusFilter, string, number]>
          ).map(([id, label, n]) => {
            const active = filter === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                style={{
                  padding: '5px 11px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  background: active ? 'var(--bg-card)' : 'transparent',
                  color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  border: 'none',
                  boxShadow: active ? 'var(--shadow-sm)' : 'none',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                {label}
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: active ? 'var(--fg-dim)' : 'var(--fg-dim)',
                    padding: '0 5px',
                    background: 'var(--bg-sunken)',
                    borderRadius: 3,
                  }}
                >
                  {n}
                </span>
              </button>
            );
          })}
        </div>

        <div
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            flex: 1,
            maxWidth: 280,
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--fg-dim)',
              pointerEvents: 'none',
            }}
          >
            <IconSearch size={12} />
          </span>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search series, game, partner…"
            style={{
              width: '100%',
              padding: '6px 10px 6px 28px',
              fontSize: 12.5,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--fg)',
              outline: 'none',
            }}
          />
        </div>
      </Row>

      {/* Grid */}
      {filtered.length === 0 ? (
        <EmptyState
          filter={filter}
          hasAny={seriesList.length > 0}
          onCreate={onCreate}
          onClearFilter={() => {
            setFilter('all');
            setQ('');
          }}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {filtered.map((s) => (
            <SeriesCard
              key={s.id}
              series={s}
              onClick={() => onSeriesChange(s.id)}
              canEdit={isEditor}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Series card ─────────────────────────────────────────────────────────────

function SeriesCard({
  series,
  onClick,
  canEdit,
}: {
  series: TournamentSeries;
  onClick: () => void;
  canEdit: boolean;
}) {
  const dateLabel = dateRangeLabel(series.start_date, series.end_date);
  const hasShort = !!series.short_name && series.short_name !== series.name;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="card"
      style={{
        padding: 16,
        textAlign: 'left',
        cursor: 'pointer',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 130,
        transition: 'transform 80ms ease, border-color 80ms ease',
        color: 'var(--fg)',
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)';
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.borderColor = 'var(--border)';
      }}
    >
      <Row justify="space-between" align="flex-start" style={{ gap: 8 }}>
        <Col gap={2} style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.01em',
            }}
            title={series.name}
          >
            {series.name}
          </div>
          {hasShort && (
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                letterSpacing: 0.2,
              }}
            >
              {series.short_name}
            </div>
          )}
        </Col>
        <Row gap={6} align="center">
          <PublicLinkButton variant="icon" series={series} canEdit={canEdit} />
          <StatusChip status={series.status} />
        </Row>
      </Row>

      <div
        style={{
          fontSize: 11.5,
          color: 'var(--fg-muted)',
          lineHeight: 1.4,
          flex: 1,
        }}
      >
        {series.game || series.partner ? (
          <div
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={[series.game, series.partner].filter(Boolean).join(' · ')}
          >
            {series.game ?? ''}
            {series.game && series.partner ? ' · ' : ''}
            {series.partner ?? ''}
          </div>
        ) : (
          <div style={{ color: 'var(--fg-dim)' }}>No game / partner set</div>
        )}
        <div className="mono" style={{ fontSize: 10.5, marginTop: 4 }}>
          {dateLabel}
        </div>
      </div>
    </div>
  );
}

// ── Status chip ─────────────────────────────────────────────────────────────

function StatusChip({
  status,
}: {
  status: TournamentStatus;
}) {
  const tone: Record<TournamentStatus, { bg: string; fg: string; dot: string; label: string }> = {
    active: {
      bg: 'color-mix(in oklab, var(--live) 14%, transparent)',
      fg: 'var(--live)',
      dot: 'var(--live)',
      label: 'Active',
    },
    draft: {
      bg: 'color-mix(in oklab, var(--warn) 14%, transparent)',
      fg: 'var(--warn)',
      dot: 'var(--warn)',
      label: 'Draft',
    },
    completed: {
      bg: 'var(--bg-sunken)',
      fg: 'var(--fg-muted)',
      dot: 'var(--fg-dim)',
      label: 'Completed',
    },
  };
  const t = tone[status] ?? tone.draft;
  return (
    <Col gap={3} style={{ alignItems: 'flex-end' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10.5,
          fontWeight: 600,
          padding: '2px 7px',
          borderRadius: 3,
          background: t.bg,
          color: t.fg,
          letterSpacing: 0.3,
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: t.dot,
          }}
        />
        {t.label.toUpperCase()}
      </span>
    </Col>
  );
}

// ── Stat cell ──────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  accent,
  divided = true,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
  divided?: boolean;
}) {
  return (
    <div
      style={{
        padding: '16px 20px',
        borderRight: divided ? '1px solid var(--border)' : 'none',
      }}
    >
      <div
        className="eyebrow"
        style={{ fontSize: 9.5, marginBottom: 6, letterSpacing: 0.4 }}
      >
        {label}
      </div>
      <Row gap={8} align="center">
        {accent && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--live)',
              boxShadow: '0 0 6px var(--live)',
            }}
          />
        )}
        <div
          className="tabular"
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}
        >
          {value}
        </div>
      </Row>
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-muted)',
          marginTop: 5,
        }}
      >
        {sub}
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState({
  filter,
  hasAny,
  onCreate,
  onClearFilter,
}: {
  filter: StatusFilter;
  hasAny: boolean;
  onCreate: () => void;
  onClearFilter: () => void;
}) {
  const firstRun = !hasAny;
  return (
    <div
      style={{
        padding: '48px 24px',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--bg-card)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'color-mix(in oklab, var(--red) 12%, var(--bg-sunken))',
          color: 'var(--red)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        }}
      >
        <IconBolt size={20} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
        {firstRun ? 'No series yet' : `No ${filter === 'all' ? 'matching' : filter} series`}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--fg-muted)',
          marginBottom: 16,
          maxWidth: 360,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {firstRun
          ? 'Create your first tournament series to start tracking viewership across Twitch, YouTube, Kick, TikTok and more.'
          : 'Try clearing your filter or searching for a different keyword.'}
      </div>
      <Row gap={8} justify="center">
        {!firstRun && (
          <button
            type="button"
            onClick={onClearFilter}
            className="btn"
            style={{ fontSize: 12 }}
          >
            Clear filter
          </button>
        )}
        <button
          type="button"
          onClick={onCreate}
          className="btn btn-primary"
          style={{
            fontSize: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <IconPlus size={12} /> New series
        </button>
      </Row>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function greet(name: string | null): string {
  const first = (name ?? '').split(/[\s@]/)[0] || null;
  const hr = new Date().getHours();
  const prefix = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  return first ? `${prefix}, ${first}` : `${prefix}`;
}

function fmtToday(): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(new Date());
  } catch {
    return new Date().toDateString();
  }
}

function dateRangeLabel(
  start: string | null,
  end: string | null,
): string {
  if (!start && !end) return 'No dates set';
  if (start && end) return `${fmtDateLong(start)} – ${fmtDateLong(end)}`;
  if (start) return `From ${fmtDateLong(start)}`;
  return `Until ${fmtDateLong(end)}`;
}
