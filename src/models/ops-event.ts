/**
 * OpsEvent — one row per operator notification emitted by the system.
 * The durable history behind Web Push: push is ephemeral (dismissed,
 * throttled, missed), this table is what the dashboard lists.
 */

import db from '../utils/db';
import logger from '../utils/logger';

export const TABLE = 'ops_events';

/** Keep 90 days of history; pruned opportunistically on insert. */
const RETENTION_DAYS = 90;

export interface OpsEventRow {
  id: string;
  created_at: string;
  event_type: string;
  title: string;
  body: string;
  url: string | null;
  urgent: boolean;
  sent: number;
  failed: number;
  pruned: number;
}

export interface OpsEventInput {
  eventType: string;
  title: string;
  body: string;
  url?: string | null;
  urgent?: boolean;
  sent?: number;
  failed?: number;
  pruned?: number;
}

/**
 * Record one event. Never throws — history must not break the notifier.
 */
export async function record(input: OpsEventInput): Promise<void> {
  try {
    await db(TABLE).insert({
      event_type: input.eventType,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
      urgent: input.urgent === true,
      sent: input.sent ?? 0,
      failed: input.failed ?? 0,
      pruned: input.pruned ?? 0,
    });
    // Opportunistic retention sweep — the table stays tiny (throttled
    // events, dozens per day), so an unconditional delete is cheap.
    await db(TABLE)
      .where('created_at', '<', db.raw(`NOW() - INTERVAL '${RETENTION_DAYS} days'`))
      .delete();
  } catch (err) {
    logger.warn('Failed to record ops event', {
      eventType: input.eventType,
      error: (err as Error).message,
    });
  }
}

export async function listRecent(opts: {
  limit?: number;
  eventType?: string;
  before?: string;
}): Promise<OpsEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  let q = db(TABLE).select('*').orderBy('created_at', 'desc').limit(limit);
  if (opts.eventType) q = q.where('event_type', opts.eventType);
  if (opts.before) q = q.where('created_at', '<', opts.before);
  return q;
}
