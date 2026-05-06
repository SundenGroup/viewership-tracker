import { useEffect, useState } from 'react';
import * as api from '@/services/api';
import type { GameTrackerLeaderboardRow } from '@/services/api';
import { Row, Section, IconFilter } from '@/components/design';
import { LeaderboardTable } from './DiscoverDetailPage';

const POLL_INTERVAL_MS = 30_000;
type Filter = 'all' | 'twitch' | 'kick';

export function DiscoverChannelsTab({ slug }: { slug: string }) {
  const [rows, setRows] = useState<GameTrackerLeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      api
        .getGameTrackerLeaderboard(slug, undefined, 200)
        .then((r) => {
          if (!cancelled) setRows(r);
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    refresh();
    const handle = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [slug]);

  const filtered = rows?.filter((r) => filter === 'all' || r.platform === filter) ?? [];

  return (
    <Section
      title="All channels"
      eyebrow="ACTIVE NOW"
      right={
        <Row gap={6} align="center">
          <span
            className="eyebrow"
            style={{
              fontSize: 10,
              color: 'var(--fg-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <IconFilter size={11} />
            Platform
          </span>
          {(['all', 'twitch', 'kick'] as const).map((p) => (
            <FilterPill key={p} active={filter === p} onClick={() => setFilter(p)}>
              {p}
            </FilterPill>
          ))}
          <span style={{ fontSize: 11, color: 'var(--fg-dim)', marginLeft: 6 }}>
            {filtered.length} live
          </span>
        </Row>
      }
      style={{ padding: 0 }}
    >
      {error && (
        <div style={{ padding: 16, color: 'var(--red)', fontSize: 13 }}>{error}</div>
      )}
      <div style={{ margin: -16, marginTop: 0 }}>
        <LeaderboardTable rows={filtered} trackerSlug={slug} />
      </div>
    </Section>
  );
}

function FilterPill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
        background: active
          ? 'var(--red-wash, color-mix(in oklab, var(--red) 12%, transparent))'
          : 'var(--bg-sunken)',
        color: active ? 'var(--red)' : 'var(--fg-muted)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
