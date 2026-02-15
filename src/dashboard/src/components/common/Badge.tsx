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
};

const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  tiktok: 'TikTok',
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
