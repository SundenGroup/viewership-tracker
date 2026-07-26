/**
 * ChannelNameWithLink — channel name plus a small external-link icon.
 *
 * When `to` is provided the NAME itself is a real in-app <Link> (channel
 * detail page) — it was previously a dead <span> that swallowed the most
 * obvious click target on every leaderboard row. The icon stays the only
 * thing that leaves the app (opens the Twitch/Kick stream).
 */

import { Link } from 'react-router-dom';
import { getStreamUrl } from '@/utils/formatters';
import { IconExternal } from './icons';

interface Props {
  name: string;
  platform: string | null;
  channelIdentifier: string | null;
  /** In-app destination (channel page). Omitted → plain text name. */
  to?: string | null;
  /** Override font weight for the name (default 500). */
  weight?: number;
}

export function ChannelNameWithLink({ name, platform, channelIdentifier, to, weight = 500 }: Props) {
  const url = channelIdentifier ? getStreamUrl(platform, channelIdentifier) : null;
  const nameStyle: React.CSSProperties = {
    fontWeight: weight,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    color: 'inherit',
    textDecoration: 'none',
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
      }}
    >
      {to ? (
        <Link
          to={to}
          style={nameStyle}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => {
            e.currentTarget.style.textDecoration = 'underline';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.textDecoration = 'none';
          }}
        >
          {name}
        </Link>
      ) : (
        <span style={nameStyle}>{name}</span>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${name} on ${platform ?? 'stream'} (new tab)`}
          aria-label={`Open ${name} in a new tab`}
          onClick={(e) => e.stopPropagation()}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 4,
            color: 'var(--fg-dim)',
            transition: 'color 140ms, background 140ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--info)';
            e.currentTarget.style.background = 'color-mix(in oklab, var(--info) 12%, transparent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--fg-dim)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <IconExternal size={11} />
        </a>
      )}
    </div>
  );
}
