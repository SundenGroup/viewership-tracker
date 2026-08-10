/**
 * Game tile — Twitch box art when the tracker has a game id, letter
 * fallback otherwise. Twitch's CDN serves art at predictable paths:
 * newer entries under `<id>_IGDB-…`, older ones under the bare id. A
 * missing id 302s to a generic 404_boxart image rather than erroring,
 * so onLoad checks where the request actually landed.
 */
import { useState } from 'react';

export function GameArtTile({
  name,
  twitchGameId,
  size = 52,
}: {
  name: string;
  twitchGameId?: string | null;
  size?: number;
}) {
  const sources = twitchGameId
    ? [
        `https://static-cdn.jtvnw.net/ttv-boxart/${twitchGameId}_IGDB-285x380.jpg`,
        `https://static-cdn.jtvnw.net/ttv-boxart/${twitchGameId}-285x380.jpg`,
      ]
    : [];
  const [srcIdx, setSrcIdx] = useState(0);
  const art = srcIdx < sources.length ? sources[srcIdx] : null;
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        flexShrink: 0,
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 700,
        color: 'var(--fg-muted)',
        overflow: 'hidden',
      }}
    >
      {art ? (
        <img
          src={art}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setSrcIdx((i) => i + 1)}
          onLoad={(e) => {
            if (e.currentTarget.currentSrc.includes('404_boxart')) setSrcIdx((i) => i + 1);
          }}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}
