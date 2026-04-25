/**
 * ChannelNameWithLink — channel name as plain text with a small
 * external-link icon button next to it. Mirrors the legacy main-branch
 * design: name stays readable, the icon signals "open this stream".
 */

import { getStreamUrl } from '@/utils/formatters';
import { IconExternal } from './icons';

interface Props {
  name: string;
  platform: string | null;
  channelIdentifier: string | null;
  /** Override font weight for the name (default 500). */
  weight?: number;
}

export function ChannelNameWithLink({ name, platform, channelIdentifier, weight = 500 }: Props) {
  const url = channelIdentifier ? getStreamUrl(platform, channelIdentifier) : null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontWeight: weight,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {name}
      </span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open stream"
          aria-label={`Open ${name} in a new tab`}
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
