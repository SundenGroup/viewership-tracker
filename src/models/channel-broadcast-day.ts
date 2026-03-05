import db from '../utils/db';

export interface ChannelBroadcastDay {
  id: string;
  channel_id: string;
  broadcast_day_id: string;
  created_at: Date;
}

const TABLE = 'channel_broadcast_days';

/**
 * Assign a channel to a specific broadcast day.
 * Idempotent — ignores if the assignment already exists.
 */
export async function assign(
  channelId: string,
  broadcastDayId: string,
): Promise<ChannelBroadcastDay | null> {
  const [row] = await db(TABLE)
    .insert({ channel_id: channelId, broadcast_day_id: broadcastDayId })
    .onConflict(['channel_id', 'broadcast_day_id'])
    .ignore()
    .returning('*');
  return row ?? null;
}

/**
 * Remove a channel's assignment to a specific broadcast day.
 */
export async function unassign(
  channelId: string,
  broadcastDayId: string,
): Promise<boolean> {
  const count = await db(TABLE)
    .where({ channel_id: channelId, broadcast_day_id: broadcastDayId })
    .delete();
  return count > 0;
}

/**
 * Get all broadcast day assignments for a specific channel.
 */
export async function findByChannel(
  channelId: string,
): Promise<ChannelBroadcastDay[]> {
  return db(TABLE).where({ channel_id: channelId });
}

/**
 * Get all channel assignments for a specific broadcast day.
 */
export async function findByBroadcastDay(
  broadcastDayId: string,
): Promise<ChannelBroadcastDay[]> {
  return db(TABLE).where({ broadcast_day_id: broadcastDayId });
}

/**
 * Replace all broadcast day assignments for a channel.
 * If broadcastDayIds is empty, all assignments are removed (channel becomes series-wide).
 */
export async function replaceForChannel(
  channelId: string,
  broadcastDayIds: string[],
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx(TABLE).where({ channel_id: channelId }).delete();

    if (broadcastDayIds.length > 0) {
      const rows = broadcastDayIds.map((dayId) => ({
        channel_id: channelId,
        broadcast_day_id: dayId,
      }));
      await trx(TABLE).insert(rows);
    }
  });
}

/**
 * Bulk fetch assignments for multiple channels.
 * Used by the polling orchestrator to avoid N+1 queries.
 */
export async function findByChannelIds(
  channelIds: string[],
): Promise<ChannelBroadcastDay[]> {
  if (channelIds.length === 0) return [];
  return db(TABLE).whereIn('channel_id', channelIds);
}
