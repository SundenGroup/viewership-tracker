import type { Knex } from 'knex';
import db from '../utils/db';

/**
 * Held snapshots for YouTube channels awaiting gating review.
 *
 * Keyed by the raw YouTube channel identifier — deliberately NOT by a
 * channels-table row, so a channel that never gets approved never
 * exists anywhere the product reads. Rows are written by the tracker's
 * poll cycle for 'pending' decisions, promoted into
 * game_tracker_snapshots on approval, and deleted on denial or by the
 * TTL sweep. An AUTO-denied channel keeps its held rows until a human
 * rules or the TTL fires — auto-denials can be wrong (a title drifting
 * for one cycle), and the whole point of holding is the rescue window.
 */

const TABLE = 'game_tracker_youtube_quarantine';

/** A channel nobody has seen live for this long loses its held rows. */
export const QUARANTINE_TTL_DAYS = 14;
/** Hard cap: even a channel that keeps streaming while pending never banks more than this. */
export const QUARANTINE_MAX_DAYS = 60;

export interface HeldSnapshot {
  id: string;
  game_tracker_id: string;
  channel_identifier: string;
  display_name: string | null;
  video_id: string | null;
  stream_title: string | null;
  concurrent_viewers: number;
  language: string | null;
  started_at: Date | null;
  timestamp: Date;
}

export type InsertHeldSnapshot = Omit<HeldSnapshot, 'id'>;

export async function hold(rows: InsertHeldSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db(TABLE).insert(rows);
  return rows.length;
}

/** Everything held for one channel, oldest first (promotion order). */
export async function listForChannel(
  gameTrackerId: string,
  channelIdentifier: string,
  trx?: Knex.Transaction,
): Promise<HeldSnapshot[]> {
  return (trx ?? db)<HeldSnapshot>(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_identifier: channelIdentifier })
    .orderBy('timestamp', 'asc')
    .select('*');
}

/** Drop everything held for one channel (deny, or post-promotion cleanup). */
export async function discardChannel(
  gameTrackerId: string,
  channelIdentifier: string,
  trx?: Knex.Transaction,
): Promise<number> {
  return (trx ?? db)(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_identifier: channelIdentifier })
    .delete();
}

/**
 * TTL sweep, per CHANNEL: a channel that has not been seen live for
 * QUARANTINE_TTL_DAYS loses everything it banked; a channel still being
 * seen keeps its full history (the queue promises "banked while you
 * decide"), capped at QUARANTINE_MAX_DAYS so nothing grows forever.
 */
export async function sweep(gameTrackerId: string): Promise<number> {
  const result = await db.raw<{ rowCount: number }>(
    `
    DELETE FROM ${TABLE} q
    WHERE q.game_tracker_id = ?
      AND (
        q."timestamp" < ?
        OR NOT EXISTS (
          SELECT 1 FROM ${TABLE} n
          WHERE n.game_tracker_id = q.game_tracker_id
            AND n.channel_identifier = q.channel_identifier
            AND n."timestamp" >= ?
        )
      )
    `,
    [
      gameTrackerId,
      new Date(Date.now() - QUARANTINE_MAX_DAYS * 86_400_000),
      new Date(Date.now() - QUARANTINE_TTL_DAYS * 86_400_000),
    ],
  );
  return result.rowCount;
}

export interface HeldStats {
  /** Distinct minutes of viewership held — honest "how much data" figure. */
  held_minutes: number;
  held_from: Date;
}

/**
 * Per-channel summary of what's being held, for the review queue UI —
 * the moderator should see that deciding late costs nothing.
 */
export async function statsByChannel(gameTrackerId: string): Promise<Map<string, HeldStats>> {
  const rows = await db.raw<{
    rows: Array<{ channel_identifier: string; held_minutes: string; held_from: Date }>;
  }>(
    `
    SELECT channel_identifier,
           COUNT(DISTINCT date_trunc('minute', "timestamp")) AS held_minutes,
           MIN("timestamp") AS held_from
    FROM ${TABLE}
    WHERE game_tracker_id = ?
    GROUP BY channel_identifier
    `,
    [gameTrackerId],
  );
  const map = new Map<string, HeldStats>();
  for (const r of rows.rows) {
    map.set(r.channel_identifier, {
      held_minutes: Number(r.held_minutes),
      held_from: r.held_from,
    });
  }
  return map;
}
