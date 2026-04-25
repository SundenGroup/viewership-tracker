/**
 * YouTube API key pool — CRUD + pick-best-key-for-partner.
 *
 * Keys are tagged with a partner string (matches tournament_series.partner).
 * The discovery path uses pickBestKey(partner) which prefers keys belonging
 * to that partner, falls back to shared (partner=NULL) keys, falls back to
 * none. Fair-share within the chosen pool: the key with the most remaining
 * quota wins.
 *
 * Polling does not consult this pool — it uses the legacy single env key
 * with scrape-fallback (the 1-unit/50-IDs cost is negligible).
 */

import db from '../utils/db';
import { encryptSecret, decryptSecret, maskSecret } from '../utils/crypto';
import logger from '../utils/logger';

const TABLE = 'youtube_api_keys';

export interface YouTubeApiKeyRow {
  id: string;
  label: string;
  partner: string | null;
  secret_encrypted: string;
  secret_last4: string;
  daily_quota: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface YouTubeApiKeyPublic {
  id: string;
  label: string;
  partner: string | null;
  /** Masked form: "AIzaS…<last4>" — never the full secret. */
  secret_preview: string;
  daily_quota: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface ResolvedKey {
  id: string;
  label: string;
  partner: string | null;
  secret: string; // decrypted, in-memory only
  daily_quota: number;
}

// ── Mappers ───────────────────────────────────────────────────────────────

function toPublic(row: YouTubeApiKeyRow): YouTubeApiKeyPublic {
  return {
    id: row.id,
    label: row.label,
    partner: row.partner,
    secret_preview: `••••${row.secret_last4}`,
    daily_quota: row.daily_quota,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function listKeys(includeInactive = false): Promise<YouTubeApiKeyPublic[]> {
  const q = db<YouTubeApiKeyRow>(TABLE).orderBy([
    { column: 'partner', order: 'asc', nulls: 'last' },
    { column: 'label', order: 'asc' },
  ]);
  if (!includeInactive) q.where('is_active', true);
  const rows = await q;
  return rows.map(toPublic);
}

export async function getKeyById(id: string): Promise<YouTubeApiKeyPublic | null> {
  const row = await db<YouTubeApiKeyRow>(TABLE).where({ id }).first();
  return row ? toPublic(row) : null;
}

/**
 * Resolve a usable key for a given partner. Returns the active key with the
 * most remaining quota — tries partner-specific keys first, then partner=NULL
 * shared keys. Returns null if no key has enough remaining quota.
 *
 * `usedSoFar` is a per-key map maintained by the caller (the YouTube adapter).
 */
export async function pickBestKey(
  partner: string | null,
  cost: number,
  usedSoFar: Map<string, number>,
): Promise<ResolvedKey | null> {
  const tryPool = async (where: Partial<Pick<YouTubeApiKeyRow, 'partner'>>) => {
    const rows = await db<YouTubeApiKeyRow>(TABLE)
      .where('is_active', true)
      .andWhere(where)
      .select();
    const candidates = rows
      .map((r) => ({
        row: r,
        remaining: r.daily_quota - (usedSoFar.get(r.id) ?? 0),
      }))
      .filter((c) => c.remaining >= cost)
      .sort((a, b) => b.remaining - a.remaining);
    if (candidates.length === 0) return null;
    const winner = candidates[0].row;
    try {
      return {
        id: winner.id,
        label: winner.label,
        partner: winner.partner,
        secret: decryptSecret(winner.secret_encrypted),
        daily_quota: winner.daily_quota,
      } satisfies ResolvedKey;
    } catch (err) {
      logger.error('Failed to decrypt YouTube API key — disabling row', {
        keyId: winner.id,
        error: (err as Error).message,
      });
      // If decryption fails the key row is corrupt; flip is_active off so
      // we don't try it again. JWT_SECRET must have rotated.
      await db<YouTubeApiKeyRow>(TABLE).where({ id: winner.id }).update({ is_active: false });
      return null;
    }
  };

  if (partner) {
    const partnerHit = await tryPool({ partner });
    if (partnerHit) return partnerHit;
  }
  const sharedHit = await tryPool({ partner: null });
  return sharedHit;
}

// ── Mutations ─────────────────────────────────────────────────────────────

export interface CreateYouTubeApiKey {
  label: string;
  partner?: string | null;
  secret: string;
  daily_quota?: number;
  created_by?: string | null;
}

export async function createKey(data: CreateYouTubeApiKey): Promise<YouTubeApiKeyPublic> {
  const secret_encrypted = encryptSecret(data.secret);
  const secret_last4 = data.secret.slice(-4);
  const [row] = await db<YouTubeApiKeyRow>(TABLE)
    .insert({
      label: data.label,
      partner: data.partner ?? null,
      secret_encrypted,
      secret_last4,
      daily_quota: data.daily_quota ?? 10000,
      is_active: true,
      created_by: data.created_by ?? null,
    })
    .returning('*');
  return toPublic(row);
}

export interface UpdateYouTubeApiKey {
  label?: string;
  partner?: string | null;
  daily_quota?: number;
  is_active?: boolean;
  /** New secret — if set, re-encrypts. */
  secret?: string;
}

export async function updateKey(id: string, data: UpdateYouTubeApiKey): Promise<YouTubeApiKeyPublic | null> {
  const patch: Partial<YouTubeApiKeyRow> = { updated_at: db.fn.now() as unknown as string };
  if (data.label !== undefined) patch.label = data.label;
  if (data.partner !== undefined) patch.partner = data.partner;
  if (data.daily_quota !== undefined) patch.daily_quota = data.daily_quota;
  if (data.is_active !== undefined) patch.is_active = data.is_active;
  if (data.secret) {
    patch.secret_encrypted = encryptSecret(data.secret);
    patch.secret_last4 = data.secret.slice(-4);
  }
  const [row] = await db<YouTubeApiKeyRow>(TABLE).where({ id }).update(patch).returning('*');
  return row ? toPublic(row) : null;
}

export async function deleteKey(id: string): Promise<boolean> {
  // Soft-delete via is_active = false so usage history stays attributable.
  const updated = await db<YouTubeApiKeyRow>(TABLE).where({ id }).update({
    is_active: false,
    updated_at: db.fn.now() as unknown as string,
  });
  return updated > 0;
}

export async function touchLastUsed(id: string): Promise<void> {
  await db<YouTubeApiKeyRow>(TABLE).where({ id }).update({
    last_used_at: db.fn.now() as unknown as string,
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * On first boot after the migration, copy the legacy YOUTUBE_API_KEY env var
 * (if set) into the table as a shared/legacy key so existing setups keep
 * working without manual intervention.
 */
export async function bootstrapLegacyKey(envSecret: string | undefined): Promise<void> {
  if (!envSecret) return;
  const existing = await db<YouTubeApiKeyRow>(TABLE).count<{ count: string }[]>('id as count');
  const count = parseInt(existing[0]?.count ?? '0', 10);
  if (count > 0) return; // already migrated or admin added keys
  await createKey({
    label: 'legacy (env YOUTUBE_API_KEY)',
    partner: null,
    secret: envSecret,
  });
  logger.info('Migrated legacy YOUTUBE_API_KEY env var into youtube_api_keys table as shared key');
}
