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

/** Format hours as "Xh Ym" (e.g. 1234.5 → "1,234h 30m") */
export function formatViewedHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${formatNumber(h)}h ${m}m` : `${formatNumber(h)}h`;
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

// ── Timezone-aware Formatting ─────────────────────────────────────────────

/** Map Intl long timezone names to common abbreviations (DST-aware) */
const LONG_TZ_TO_ABBR: Record<string, string> = {
  'Central European Standard Time': 'CET',
  'Central European Summer Time': 'CEST',
  'Eastern European Standard Time': 'EET',
  'Eastern European Summer Time': 'EEST',
  'Greenwich Mean Time': 'GMT',
  'British Summer Time': 'BST',
  'Eastern Standard Time': 'EST',
  'Eastern Daylight Time': 'EDT',
  'Central Standard Time': 'CST',
  'Central Daylight Time': 'CDT',
  'Mountain Standard Time': 'MST',
  'Mountain Daylight Time': 'MDT',
  'Pacific Standard Time': 'PST',
  'Pacific Daylight Time': 'PDT',
  'Japan Standard Time': 'JST',
  'Korean Standard Time': 'KST',
  'Moscow Standard Time': 'MSK',
};

/**
 * Get the short timezone abbreviation (e.g. "CEST", "EST", "PDT") for a
 * given date in a given IANA timezone. DST-aware.
 */
export function getTimezoneAbbr(date: Date, timezone: string): string {
  try {
    const longParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'long',
    }).formatToParts(date);
    const longName = longParts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const mapped = LONG_TZ_TO_ABBR[longName];
    if (mapped) return mapped;

    const shortParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    }).formatToParts(date);
    return shortParts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}

/**
 * Pick AM/PM vs 24-hour based on the IANA timezone's region. Americas
 * → 12-hour ("7pm EDT"); Europe/Asia/Africa → 24-hour ("21:35 CEST").
 */
function shouldUseAmPm(timezone: string | null | undefined): boolean {
  return !!timezone && /^America\//.test(timezone);
}

/**
 * Format a UTC ISO timestamp as time in a specific IANA timezone.
 * e.g. formatTimeInTz("2026-03-10T11:00:00Z", "Europe/Moscow") → "14:00 MSK"
 *      formatTimeInTz("2026-04-26T02:32:00Z", "America/New_York") → "10:32pm EDT"
 */
export function formatTimeInTz(
  iso: string | null | undefined,
  timezone: string,
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const useAmPm = shouldUseAmPm(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: useAmPm,
    timeZone: timezone,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value?.toLowerCase() ?? '';
  const tzAbbr = getTimezoneAbbr(d, timezone);
  const timeText = useAmPm
    ? minute === '00'
      ? `${hour}${dayPeriod}`
      : `${hour}:${minute}${dayPeriod}`
    : `${hour}:${minute}`;
  return `${timeText} ${tzAbbr}`;
}

/**
 * Format a UTC ISO timestamp as date+time in a specific IANA timezone.
 * e.g. "Mar 10, 14:00 MSK" / "Apr 25, 7pm EDT"
 */
export function formatDateTimeInTz(
  iso: string | null | undefined,
  timezone: string,
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const useAmPm = shouldUseAmPm(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: useAmPm,
    timeZone: timezone,
  }).formatToParts(d);
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value?.toLowerCase() ?? '';
  const tzAbbr = getTimezoneAbbr(d, timezone);
  const timeText = useAmPm
    ? minute === '00'
      ? `${hour}${dayPeriod}`
      : `${hour}:${minute}${dayPeriod}`
    : `${hour}:${minute}`;
  return `${month} ${day}, ${timeText} ${tzAbbr}`;
}

/**
 * Convert a local date + time in a specific IANA timezone to a UTC ISO string.
 * e.g. localTimeToUTC("2026-03-10", "14:00", "Europe/Moscow") → "2026-03-10T11:00:00.000Z"
 *
 * Strategy: construct a Date assuming UTC, then use Intl to find what local time
 * that UTC instant corresponds to in the target timezone. The difference tells us
 * the timezone offset, which we apply to get the correct UTC.
 */
export function localTimeToUTC(
  dateStr: string,
  timeStr: string,
  timezone: string,
): string {
  const dateParts = dateStr.split('-').map(Number);
  const timeParts = timeStr.split(':').map(Number);
  const year = dateParts[0] ?? 2000;
  const month = dateParts[1] ?? 1;
  const day = dateParts[2] ?? 1;
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;

  // Initial guess: interpret as UTC
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // Find what local time our guess corresponds to in the target timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(guess);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const localYear = get('year');
  const localMonth = get('month');
  const localDay = get('day');
  const localHour = get('hour');
  const localMinute = get('minute');

  // Build what the formatter tells us the local time is, as a UTC Date (for diffing)
  const localAsUtc = new Date(Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, 0, 0));

  // The offset is the difference between what we wanted and what we got
  const offsetMs = localAsUtc.getTime() - guess.getTime();

  // Adjust our guess backwards by the offset
  const result = new Date(guess.getTime() - offsetMs);

  return result.toISOString();
}

/**
 * Convert a UTC ISO string back to date + time strings in a specific timezone,
 * for populating form inputs.
 * Returns { date: "2026-03-10", time: "14:00" }
 */
export function utcToLocalTimeParts(
  iso: string | null | undefined,
  timezone: string,
): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return { date, time };
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
  steam: 'Steam',
  trovo: 'Trovo',
  chzzk: 'CHZZK',
  soop: 'SOOP',
  nimotv: 'NimoTV',
};

const PLATFORM_COLORS: Record<string, string> = {
  twitch: '#9146FF',
  youtube: '#FF0000',
  kick: '#53FC18',
  tiktok: '#EE1D52',
  steam: '#1B9FFC',
  trovo: '#30C67C',
  chzzk: '#00FFA3',
  soop: '#0066FF',
  nimotv: '#FFD700',
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function platformColor(platform: string): string {
  return PLATFORM_COLORS[platform] ?? '#6b7280';
}

// ── Tier / Status Formatting ────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  official: 'Official',
  partner: 'Partner',
  community: 'Community',
  player: 'Player',
  watch_party: 'Watch Party',
};

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

// ── Language Formatting ────────────────────────────────────────────────

/**
 * Map the two-letter language codes we ingest (Twitch broadcaster_language,
 * YouTube defaultLanguage, etc.) to the English name. Only the languages
 * we actually see in the pipeline are listed — unknown codes fall through
 * to the uppercased code so the UI still renders something.
 */
const LANGUAGE_FULL_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  pl: 'Polish',
  tr: 'Turkish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  cs: 'Czech',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  hu: 'Hungarian',
  ro: 'Romanian',
  el: 'Greek',
  uk: 'Ukrainian',
  ar: 'Arabic',
  he: 'Hebrew',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  th: 'Thai',
  vi: 'Vietnamese',
  hi: 'Hindi',
  id: 'Indonesian',
  ms: 'Malay',
  tl: 'Tagalog',
  fil: 'Filipino',
  bn: 'Bengali',
  ur: 'Urdu',
  fa: 'Persian',
};

/**
 * Full English language name for a two-letter code (e.g. "en" → "English").
 * Falls back to uppercased code ("EN") for unknown values so the column
 * never renders an empty cell.
 */
export function languageFullName(code: string | null | undefined): string {
  if (!code) return '—';
  const k = code.trim().toLowerCase();
  return LANGUAGE_FULL_NAMES[k] ?? k.toUpperCase();
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
    case 'steam':
      return `https://steamcommunity.com/broadcast/watch/${channelIdentifier}`;
    case 'trovo':
      return `https://trovo.live/${channelIdentifier}`;
    case 'chzzk':
      return `https://chzzk.naver.com/live/${channelIdentifier}`;
    case 'soop':
      return `https://play.sooplive.co.kr/${channelIdentifier}`;
    default:
      return null;
  }
}
