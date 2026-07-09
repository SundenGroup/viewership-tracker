import db from '../utils/db';

/**
 * Point-in-time follower counts, polled by GameTrackerService for the
 * top live channels of each tracker (Kick unofficial v2 API + Twitch
 * Helix followers total). Read paths live in stream-session.ts
 * (followers_start/_end capture, channel summary).
 */

export interface ChannelFollowerSnapshot {
  channel_id: string;
  ts: Date;
  followers: number;
}

const TABLE = 'channel_follower_snapshots';

export async function insertMany(rows: ChannelFollowerSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db(TABLE).insert(rows).onConflict(['channel_id', 'ts']).ignore();
  return rows.length;
}
