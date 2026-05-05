import db from '../utils/db';

export type GameTrackerChannelSource = 'auto_discovered' | 'manual';

export interface GameTrackerChannel {
  id: string;
  game_tracker_id: string;
  channel_id: string;
  source: GameTrackerChannelSource;
  joined_at: Date;
  last_match_at: Date | null;
  consecutive_mismatch_cycles: number;
  dropped_at: Date | null;
  dropped_reason: string | null;
  metadata: Record<string, unknown>;
}

const TABLE = 'game_tracker_channels';

export async function listActive(gameTrackerId: string): Promise<GameTrackerChannel[]> {
  return db(TABLE)
    .where({ game_tracker_id: gameTrackerId })
    .whereNull('dropped_at')
    .orderBy('joined_at', 'asc');
}

export async function listAll(gameTrackerId: string): Promise<GameTrackerChannel[]> {
  return db(TABLE)
    .where({ game_tracker_id: gameTrackerId })
    .orderBy('joined_at', 'asc');
}

export async function findByTrackerAndChannel(
  gameTrackerId: string,
  channelId: string,
): Promise<GameTrackerChannel | null> {
  const row = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_id: channelId })
    .first();
  return row ?? null;
}

export async function upsert(
  gameTrackerId: string,
  channelId: string,
  source: GameTrackerChannelSource,
): Promise<GameTrackerChannel> {
  const existing = await findByTrackerAndChannel(gameTrackerId, channelId);
  if (existing) {
    const [row] = await db(TABLE)
      .where({ id: existing.id })
      .update({
        last_match_at: db.fn.now(),
        consecutive_mismatch_cycles: 0,
        dropped_at: null,
        dropped_reason: null,
      })
      .returning('*');
    return row;
  }
  const [row] = await db(TABLE)
    .insert({
      game_tracker_id: gameTrackerId,
      channel_id: channelId,
      source,
      last_match_at: db.fn.now(),
    })
    .returning('*');
  return row;
}

export async function recordMatch(id: string): Promise<void> {
  await db(TABLE)
    .where({ id })
    .update({
      last_match_at: db.fn.now(),
      consecutive_mismatch_cycles: 0,
    });
}

export async function bumpMismatch(id: string): Promise<number> {
  const [row] = await db(TABLE)
    .where({ id })
    .increment('consecutive_mismatch_cycles', 1)
    .returning('consecutive_mismatch_cycles');
  return (row?.consecutive_mismatch_cycles as number) ?? 0;
}

export async function softDrop(id: string, reason: string): Promise<void> {
  await db(TABLE)
    .where({ id })
    .update({
      dropped_at: db.fn.now(),
      dropped_reason: reason,
    });
}

export async function countActive(gameTrackerId: string): Promise<number> {
  const result = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId })
    .whereNull('dropped_at')
    .count<{ count: string }[]>('id as count')
    .first();
  return result ? Number(result.count) : 0;
}
