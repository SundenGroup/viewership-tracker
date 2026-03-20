import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'platform';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
  dot?: boolean;
  color?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-navy-700 text-gray-300',
  success: 'bg-green-500/15 text-accent-green border border-green-500/20',
  warning: 'bg-orange-500/15 text-accent-orange border border-orange-500/20',
  danger: 'bg-red-500/15 text-accent-red border border-red-500/20',
  info: 'bg-blue-500/15 text-accent-blue border border-blue-500/20',
  platform: 'bg-navy-700/80 text-gray-300',
};

export function Badge({
  children,
  variant = 'default',
  className = '',
  dot = false,
  color,
}: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5
        text-xs font-medium
        ${variantClasses[variant]}
        ${className}
      `}
    >
      {dot && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color ?? 'currentColor' }}
        />
      )}
      {children}
    </span>
  );
}

// ── Platform badge ──────────────────────────────────────────────────────

const PLATFORM_BADGE_COLORS: Record<string, string> = {
  twitch: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  youtube: 'bg-red-500/15 text-red-400 border-red-500/20',
  kick: 'bg-green-500/15 text-green-400 border-green-500/20',
  tiktok: 'bg-gray-500/15 text-gray-300 border-gray-500/20',
  steam: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  soop: 'bg-blue-600/15 text-blue-400 border-blue-600/20',
  chzzk: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  trovo: 'bg-green-400/15 text-green-300 border-green-400/20',
};

const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  tiktok: 'TikTok',
  steam: 'Steam',
  soop: 'SOOP',
  chzzk: 'CHZZK',
  trovo: 'Trovo',
};

const PLATFORM_ICON_COLORS: Record<string, string> = {
  twitch: '#a855f7',
  youtube: '#ef4444',
  kick: '#22c55e',
  tiktok: '#9ca3af',
  steam: '#60a5fa',
  soop: '#3b82f6',
  chzzk: '#34d399',
  trovo: '#4ade80',
};

// Simple SVG icons for each platform (16x16)
const PLATFORM_ICONS: Record<string, string> = {
  twitch: 'M4 2L2 6v10h4v2h2l2-2h3l4-4V2H4zm10 8l-2 2H9l-2 2v-2H4V4h10v6z M9 5h1v3H9V5zm3 0h1v3h-1V5z',
  youtube: 'M19.6 3.2a2.5 2.5 0 00-1.8-1.8C16.2 1 10 1 10 1S3.8 1 2.2 1.4A2.5 2.5 0 00.4 3.2C0 4.8 0 8 0 8s0 3.2.4 4.8a2.5 2.5 0 001.8 1.8C3.8 15 10 15 10 15s6.2 0 7.8-.4a2.5 2.5 0 001.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM8 11V5l5.2 3L8 11z',
  kick: 'M3 2h3v4l4-4h4l-5 5 5 7h-4l-3-4.5L6 11v3H3V2z',
  tiktok: 'M16.6 5.8A4.3 4.3 0 0113 4V1h-3v11a2.5 2.5 0 11-1.7-2.4V6.3A5.8 5.8 0 1013 12V7.3a7.5 7.5 0 003.6.9V5.8z',
  steam: 'M10 2a8 8 0 00-8 7.9l4.3 1.8A2.5 2.5 0 018 11a2.5 2.5 0 012.4 1.8l3.4-2.4A3 3 0 0013 4a3 3 0 00-3 3v.2L6.5 9.6A2.5 2.5 0 014.5 12 2.5 2.5 0 017 14.5l.5-.2A8 8 0 0010 2zm3-1a2 2 0 110 4 2 2 0 010-4z',
  soop: 'M10 2a8 8 0 100 16 8 8 0 000-16zm0 14a6 6 0 110-12 6 6 0 010 12zm-2-8a1 1 0 112 0v3a1 1 0 11-2 0V8zm3 0a1 1 0 112 0v3a1 1 0 11-2 0V8z',
  chzzk: 'M3 3h14v10H3V3zm2 2v6h10V5H5zm2 1h2v4H7V6zm4 0h2v4h-2V6z',
  trovo: 'M10 2L2 7v6l8 5 8-5V7l-8-5zm0 2.5L15.5 8 10 11.5 4.5 8 10 4.5z',
};

export function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span
      className={`
        inline-flex items-center rounded-full border px-2 py-0.5
        text-xs font-medium
        ${PLATFORM_BADGE_COLORS[platform] ?? 'bg-navy-700 text-gray-300'}
      `}
    >
      {PLATFORM_LABELS[platform] ?? platform}
    </span>
  );
}

/** Compact platform icon for leaderboard tables */
export function PlatformIcon({ platform, size = 16 }: { platform: string; size?: number }) {
  const color = PLATFORM_ICON_COLORS[platform] ?? '#9ca3af';
  const path = PLATFORM_ICONS[platform];
  const label = PLATFORM_LABELS[platform] ?? platform;

  if (!path) {
    // Fallback: small text badge
    return (
      <span
        className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold"
        style={{ color }}
        title={label}
      >
        {label.substring(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 16"
      fill={color}
      title={label}
      className="inline-block"
    >
      <title>{label}</title>
      <path d={path} />
    </svg>
  );
}

// ── Status badge ────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { variant: BadgeVariant; label: string }> = {
  draft: { variant: 'default', label: 'Draft' },
  active: { variant: 'success', label: 'Active' },
  completed: { variant: 'info', label: 'Completed' },
  scheduled: { variant: 'warning', label: 'Scheduled' },
  live: { variant: 'danger', label: 'Live' },
  running: { variant: 'success', label: 'Running' },
  stopped: { variant: 'default', label: 'Stopped' },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_BADGE[status] ?? { variant: 'default' as BadgeVariant, label: status };
  return (
    <Badge variant={config.variant} dot>
      {config.label}
    </Badge>
  );
}
