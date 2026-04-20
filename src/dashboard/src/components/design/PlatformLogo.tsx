/**
 * Platform logos as inline SVG. Paths drawn on a 0 0 20 20 viewBox,
 * rendered filled in each platform's brand color.
 * Ported from design_handoff_viewership_tracker v5 icons.jsx.
 */

import type { PlatformId } from '@/design/platforms';

const PATHS: Record<string, string> = {
  twitch:
    'M4 2L2 6v10h4v2h2l2-2h3l4-4V2H4zm10 8l-2 2H9l-2 2v-2H4V4h10v6z M9 5h1v3H9V5zm3 0h1v3h-1V5z',
  youtube:
    'M19.6 3.2a2.5 2.5 0 00-1.8-1.8C16.2 1 10 1 10 1S3.8 1 2.2 1.4A2.5 2.5 0 00.4 3.2C0 4.8 0 8 0 8s0 3.2.4 4.8a2.5 2.5 0 001.8 1.8C3.8 15 10 15 10 15s6.2 0 7.8-.4a2.5 2.5 0 001.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM8 11V5l5.2 3L8 11z',
  kick: 'M3 2h3v4l4-4h4l-5 5 5 7h-4l-3-4.5L6 11v3H3V2z',
  tiktok:
    'M16.6 5.8A4.3 4.3 0 0113 4V1h-3v11a2.5 2.5 0 11-1.7-2.4V6.3A5.8 5.8 0 1013 12V7.3a7.5 7.5 0 003.6.9V5.8z',
  steam:
    'M10 2a8 8 0 00-8 7.9l4.3 1.8A2.5 2.5 0 018 11a2.5 2.5 0 012.4 1.8l3.4-2.4A3 3 0 0013 4a3 3 0 00-3 3v.2L6.5 9.6A2.5 2.5 0 014.5 12 2.5 2.5 0 017 14.5l.5-.2A8 8 0 0010 2zm3-1a2 2 0 110 4 2 2 0 010-4z',
  soop:
    'M10 2a8 8 0 100 16 8 8 0 000-16zm0 14a6 6 0 110-12 6 6 0 010 12zm-2-8a1 1 0 112 0v3a1 1 0 11-2 0V8zm3 0a1 1 0 112 0v3a1 1 0 11-2 0V8z',
  chzzk: 'M3 3h14v10H3V3zm2 2v6h10V5H5zm2 1h2v4H7V6zm4 0h2v4h-2V6z',
  trovo: 'M10 2L2 7v6l8 5 8-5V7l-8-5zm0 2.5L15.5 8 10 11.5 4.5 8 10 4.5z',
  nimotv: 'M3 4h4l3 5 3-5h4l-5 8v4h-4v-4L3 4z',
};

export function PlatformLogo({
  id,
  size = 14,
  color = 'currentColor',
}: {
  id: string | PlatformId | null | undefined;
  size?: number;
  color?: string;
}) {
  if (!id) return null;
  const path = PATHS[id];
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      style={{ display: 'inline-block', flexShrink: 0 }}
    >
      <path d={path} fill={color} />
    </svg>
  );
}
