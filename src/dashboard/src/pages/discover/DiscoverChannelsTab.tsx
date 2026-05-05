import { useEffect, useState } from 'react';
import * as api from '@/services/api';
import type { GameTrackerLeaderboardRow } from '@/services/api';

const POLL_INTERVAL_MS = 30_000;

export function DiscoverChannelsTab({ slug }: { slug: string }) {
  const [rows, setRows] = useState<GameTrackerLeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'twitch' | 'kick'>('all');

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Filter
          </span>
          <div style={{ display: 'inline-flex', gap: 4 }}>
            {(['all', 'twitch', 'kick'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setFilter(p)}
                className="btn"
                style={{
                  fontSize: 12,
                  padding: '4px 12px',
                  background: filter === p ? 'var(--red)' : 'transparent',
                  color: filter === p ? '#fff' : 'var(--fg-muted)',
                  borderColor: filter === p ? 'var(--red)' : 'var(--border)',
                  textTransform: 'capitalize',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          {filtered.length} channel{filtered.length === 1 ? '' : 's'} live now
        </span>
      </div>

      {error && (
        <div className="placeholder" style={{ color: 'var(--red)' }}>
          {error}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <th style={th}>#</th>
              <th style={th}>Platform</th>
              <th style={th}>Channel</th>
              <th style={th}>Lang</th>
              <th style={{ ...th, textAlign: 'right' }}>Live CCV</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
                  Loading…
                </td>
              </tr>
            )}
            {rows && filtered.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
                  No streams matched this filter
                </td>
              </tr>
            )}
            {filtered.map((row, i) => {
              const profilePic = row.channel?.metadata?.profile_image_url as string | undefined;
              return (
                <tr key={row.channel_id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
                  <td style={{ ...td, color: 'var(--fg-dim)' }}>{i + 1}</td>
                  <td style={{ ...td, color: 'var(--fg-muted)', textTransform: 'capitalize' }}>{row.platform}</td>
                  <td style={td}>
                    {row.channel ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar src={profilePic ?? null} name={row.channel.display_name} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <a
                            href={platformUrl(row.platform, row.channel.channel_identifier)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--fg)', fontWeight: 500, display: 'block' }}
                          >
                            {row.channel.display_name}
                          </a>
                          <div
                            title={row.stream_title ?? ''}
                            style={{
                              fontSize: 11,
                              color: 'var(--fg-dim)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 360,
                            }}
                          >
                            {row.stream_title ?? '—'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--fg-muted)' }}>{row.channel_id.slice(0, 8)}</span>
                    )}
                  </td>
                  <td style={{ ...td, color: 'var(--fg-dim)' }}>{row.language ?? '—'}</td>
                  <td
                    style={{
                      ...td,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: 500,
                    }}
                  >
                    {row.concurrent_viewers.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function platformUrl(platform: string, identifier: string): string {
  switch (platform) {
    case 'twitch':
      return `https://twitch.tv/${identifier}`;
    case 'kick':
      return `https://kick.com/${identifier}`;
    default:
      return '#';
  }
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  const initials = name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        width={28}
        height={28}
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'var(--bg-sunken)',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: 'var(--bg-sunken)',
        color: 'var(--fg-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials || '?'}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const td: React.CSSProperties = {
  padding: '10px 12px',
};
