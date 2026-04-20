/** Platform metadata — id, display name, brand color (CSS var from tokens.css). */

export type PlatformId =
  | 'twitch'
  | 'youtube'
  | 'kick'
  | 'tiktok'
  | 'steam'
  | 'soop'
  | 'chzzk'
  | 'trovo'
  | 'nimotv';

export interface PlatformMeta {
  id: PlatformId;
  name: string;
  color: string;
}

export const PLATFORMS: PlatformMeta[] = [
  { id: 'twitch', name: 'Twitch', color: 'var(--twitch)' },
  { id: 'youtube', name: 'YouTube', color: 'var(--youtube)' },
  { id: 'kick', name: 'Kick', color: 'var(--kick)' },
  { id: 'tiktok', name: 'TikTok', color: 'var(--tiktok)' },
  { id: 'steam', name: 'Steam', color: 'var(--steam)' },
  { id: 'soop', name: 'Soop', color: 'var(--soop)' },
  { id: 'chzzk', name: 'Chzzk', color: 'var(--chzzk)' },
  { id: 'trovo', name: 'Trovo', color: 'var(--trovo)' },
  { id: 'nimotv', name: 'NimoTV', color: 'var(--nimotv)' },
];

export function getPlatform(id: string | null | undefined): PlatformMeta | undefined {
  if (!id) return undefined;
  return PLATFORMS.find((p) => p.id === id);
}
