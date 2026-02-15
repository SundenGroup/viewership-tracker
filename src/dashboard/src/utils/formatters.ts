// ── Number Formatting ──────────────────────────────────────────────────────

/**
 * Format a number with locale-aware thousand separators.
 * e.g. 12345 → "12,345"
 */
export function formatNumber(n: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US');
}

/**
 * Format a number in compact notation.
 * e.g. 1234 → "1.2K", 1234567 → "1.2M"
 */
export function formatCompact(n: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return '0';

  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(Math.round(num));
}

/**
 * Format a CCV number with sign for change.
 * e.g. 500 → "+500", -200 → "-200"
 */
export function formatCCVChange(n: number): string {
  if (n > 0) return `+${formatNumber(n)}`;
  if (n < 0) return formatNumber(n);
  return '0';
}

/**
 * Format a percentage (0-1 or 0-100 range).
 */
export function formatPercent(value: number, decimals = 1): string {
  // If value looks like it's already a percentage (> 1), use as-is
  const pct = value > 1 ? value : value * 100;
  return `${pct.toFixed(decimals)}%`;
}

// ── Date / Time Formatting ────────────────────────────────────────────────

/**
 * Format an ISO date string into a readable date.
 * e.g. "2026-02-10T15:30:00Z" → "Feb 10, 2026"
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format an ISO date string into a readable time.
 * e.g. "2026-02-10T15:30:00Z" → "3:30 PM"
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format an ISO date string into a compact date+time.
 * e.g. "2026-02-10T15:30:00Z" → "Feb 10, 3:30 PM"
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format a timestamp for chart axis labels.
 * e.g. "15:30" (HH:MM)
 */
export function formatChartTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Time-ago relative formatting.
 * e.g. "2 min ago", "1 hr ago", "3 days ago"
 */
export function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMs / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// ── Duration Formatting ──────────────────────────────────────────────────

/**
 * Format milliseconds into a human-readable duration.
 * e.g. 65000 → "1m 5s", 3600000 → "1h 0m"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;

  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

/**
 * Format hours (decimal) into "Xh Ym" format.
 * e.g. 1.5 → "1h 30m"
 */
export function formatHours(hours: number | string): string {
  const h = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (isNaN(h) || h === 0) return '0h';
  const wholeHours = Math.floor(h);
  const mins = Math.round((h - wholeHours) * 60);
  if (wholeHours === 0) return `${mins}m`;
  if (mins === 0) return `${wholeHours}h`;
  return `${wholeHours}h ${mins}m`;
}

// ── Platform Formatting ─────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  tiktok: 'TikTok',
};

const PLATFORM_COLORS: Record<string, string> = {
  twitch: '#9146FF',
  youtube: '#FF0000',
  kick: '#53FC18',
  tiktok: '#010101',
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function platformColor(platform: string): string {
  return PLATFORM_COLORS[platform] ?? '#6b7280';
}

// ── Tier / Status Formatting ────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  community: 'Community',
  watch_party: 'Watch Party',
};

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-gray-400',
  active: 'text-accent-green',
  completed: 'text-accent-blue',
  scheduled: 'text-accent-orange',
  live: 'text-accent-red',
};

export function statusColorClass(status: string): string {
  return STATUS_COLORS[status] ?? 'text-gray-400';
}

// ── Stream URL builder ─────────────────────────────────────────────────

/**
 * Build a URL to the live stream page for a given platform and channel identifier.
 * Returns null if the platform is unknown or the identifier format is unrecognised.
 */
export function getStreamUrl(platform: string | null, channelIdentifier: string): string | null {
  if (!platform || !channelIdentifier) return null;

  switch (platform) {
    case 'twitch':
      return `https://www.twitch.tv/${channelIdentifier}`;
    case 'youtube': {
      if (channelIdentifier.startsWith('yt-video:')) {
        const videoId = channelIdentifier.replace('yt-video:', '');
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
      if (channelIdentifier.startsWith('UC')) {
        return `https://www.youtube.com/channel/${channelIdentifier}/live`;
      }
      // Handle or slug
      return `https://www.youtube.com/@${channelIdentifier}`;
    }
    case 'kick':
      return `https://kick.com/${channelIdentifier}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${channelIdentifier}/live`;
    default:
      return null;
  }
}
