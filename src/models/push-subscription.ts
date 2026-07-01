/**
 * Push subscriptions DB layer.
 *
 * One row per device. The endpoint URL is the unique key (the same browser
 * profile produces a stable endpoint, even if the user logs out and back in,
 * unless they explicitly clear site data).
 *
 * Preferences are stored as a jsonb map of event-type → boolean. When a new
 * event type is introduced, existing rows get its default via the migration
 * (or the model's normalisePreferences helper, which fills missing keys with
 * `true`).
 */

import db from '../utils/db';
import logger from '../utils/logger';

export const TABLE = 'push_subscriptions';

export type PushEventType =
  | 'broadcast_started'
  | 'broadcast_ending'
  | 'polling_stalled'
  | 'quota_exhausted'
  | 'discovery_candidate'
  | 'data_anomaly';

export const ALL_EVENT_TYPES: PushEventType[] = [
  'broadcast_started',
  'broadcast_ending',
  'polling_stalled',
  'quota_exhausted',
  'discovery_candidate',
  'data_anomaly',
];

export type PushPreferences = Record<PushEventType, boolean>;

export const DEFAULT_PREFERENCES: PushPreferences = {
  broadcast_started: true,
  broadcast_ending: true,
  polling_stalled: true,
  quota_exhausted: true,
  discovery_candidate: true,
  data_anomaly: true,
};

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  preferences: PushPreferences;
  last_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PushSubscriptionPublic {
  id: string;
  endpoint: string;
  user_agent: string | null;
  preferences: PushPreferences;
  last_notified_at: string | null;
  created_at: string;
}

function toPublic(row: PushSubscriptionRow): PushSubscriptionPublic {
  return {
    id: row.id,
    endpoint: row.endpoint,
    user_agent: row.user_agent,
    preferences: normalisePreferences(row.preferences),
    last_notified_at: row.last_notified_at,
    created_at: row.created_at,
  };
}

/** Fill in missing event keys with their defaults (forward-compat). */
export function normalisePreferences(prefs: Partial<PushPreferences> | null | undefined): PushPreferences {
  const result = { ...DEFAULT_PREFERENCES };
  if (prefs) {
    for (const key of ALL_EVENT_TYPES) {
      if (key in prefs) result[key] = Boolean(prefs[key]);
    }
  }
  return result;
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function listForUser(userId: string): Promise<PushSubscriptionPublic[]> {
  const rows = await db<PushSubscriptionRow>(TABLE)
    .where({ user_id: userId })
    .orderBy('created_at', 'desc');
  return rows.map(toPublic);
}

export async function findByEndpoint(endpoint: string): Promise<PushSubscriptionRow | null> {
  const row = await db<PushSubscriptionRow>(TABLE).where({ endpoint }).first();
  return row ?? null;
}

/**
 * Returns all rows whose preferences include the given event type as `true`.
 * This is the fan-out query used by PushNotifier.
 *
 * Optionally filters to a list of user roles via a join on `users`.
 */
export async function findSubscribersForEvent(
  eventType: PushEventType,
  options: { roles?: ('admin' | 'editor' | 'viewer')[] } = {},
): Promise<PushSubscriptionRow[]> {
  // jsonb path operator (->>) returns text; cast to boolean by comparing to 'true'.
  // A MISSING key counts as subscribed: event types added after a
  // subscription was created default ON without requiring every user to
  // re-save their preferences (explicit false still opts out).
  let q = db<PushSubscriptionRow>(TABLE)
    .select(`${TABLE}.*`)
    .whereRaw(
      `(${TABLE}.preferences->>? = 'true' OR ${TABLE}.preferences->>? IS NULL)`,
      [eventType, eventType],
    );

  if (options.roles && options.roles.length > 0) {
    q = q
      .join('users', `${TABLE}.user_id`, 'users.id')
      .whereIn('users.role', options.roles)
      .andWhere('users.is_active', true);
  }

  return q;
}

// ── Mutations ─────────────────────────────────────────────────────────────

export interface UpsertPushSubscription {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
  preferences?: Partial<PushPreferences>;
}

/**
 * Upsert by endpoint — if a subscription with this endpoint already exists
 * (e.g. user re-subscribed on the same device), update it to the current
 * user_id + keys + preferences. Otherwise insert.
 */
export async function upsert(data: UpsertPushSubscription): Promise<PushSubscriptionPublic> {
  const prefs = normalisePreferences(data.preferences);
  const existing = await findByEndpoint(data.endpoint);
  if (existing) {
    const [row] = await db<PushSubscriptionRow>(TABLE)
      .where({ endpoint: data.endpoint })
      .update({
        user_id: data.user_id,
        p256dh: data.p256dh,
        auth: data.auth,
        user_agent: data.user_agent ?? existing.user_agent,
        preferences: prefs,
        updated_at: db.fn.now() as unknown as string,
      })
      .returning('*');
    return toPublic(row);
  }
  const [row] = await db<PushSubscriptionRow>(TABLE)
    .insert({
      user_id: data.user_id,
      endpoint: data.endpoint,
      p256dh: data.p256dh,
      auth: data.auth,
      user_agent: data.user_agent ?? null,
      preferences: prefs,
    })
    .returning('*');
  return toPublic(row);
}

export async function updatePreferences(
  endpoint: string,
  userId: string,
  prefs: Partial<PushPreferences>,
): Promise<PushSubscriptionPublic | null> {
  const existing = await findByEndpoint(endpoint);
  if (!existing || existing.user_id !== userId) return null;
  const merged = normalisePreferences({ ...existing.preferences, ...prefs });
  const [row] = await db<PushSubscriptionRow>(TABLE)
    .where({ endpoint })
    .update({ preferences: merged, updated_at: db.fn.now() as unknown as string })
    .returning('*');
  return row ? toPublic(row) : null;
}

export async function deleteByEndpoint(endpoint: string, userId?: string): Promise<boolean> {
  const q = db<PushSubscriptionRow>(TABLE).where({ endpoint });
  if (userId) q.andWhere({ user_id: userId });
  const deleted = await q.delete();
  if (deleted > 0) {
    logger.debug('Deleted push subscription', { endpoint: endpoint.slice(0, 60) + '…' });
  }
  return deleted > 0;
}

export async function deleteById(id: string, userId: string): Promise<boolean> {
  const deleted = await db<PushSubscriptionRow>(TABLE).where({ id, user_id: userId }).delete();
  return deleted > 0;
}

export async function touchLastNotified(endpoint: string): Promise<void> {
  await db<PushSubscriptionRow>(TABLE).where({ endpoint }).update({
    last_notified_at: db.fn.now() as unknown as string,
  });
}
