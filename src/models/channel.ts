import db from '../utils/db';

export type Platform = 'twitch' | 'youtube' | 'kick' | 'tiktok';
export type ChannelTier = 'official' | 'partner' | 'community' | 'player' | 'watch_party';
export type ChannelSource = 'manual' | 'auto_discovered';

export interface Channel {
  id: string;
  series_id: string;
  platform: Platform;
  channel_identifier: string;
  display_name: string;
  language: string | null;
  region: string | null;
  tier: ChannelTier;
  source: ChannelSource;
  is_active: boolean;
  added_at: Date;
  metadata: Record<string, unknown>;
}

export interface CreateChannel {
  series_id: string;
  platform: Platform;
  channel_identifier: string;
  display_name: string;
  language?: string;
  region?: string;
  tier?: ChannelTier;
  source?: ChannelSource;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}

export type UpdateChannel = Partial<Omit<CreateChannel, 'series_id' | 'platform' | 'channel_identifier'>>;

const TABLE = 'channels';

export async function create(data: CreateChannel): Promise<Channel> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row;
}

export async function findById(id: string): Promise<Channel | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findAll(filters?: Partial<Pick<Channel, 'series_id' | 'platform' | 'is_active' | 'tier' | 'language' | 'region'>>): Promise<Channel[]> {
  const query = db(TABLE);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        query.where(key, value);
      }
    }
  }
  return query.orderBy('display_name', 'asc');
}

export async function update(id: string, data: UpdateChannel): Promise<Channel> {
  const [row] = await db(TABLE)
    .where({ id })
    .update(data)
    .returning('*');
  return row;
}

export async function remove(id: string): Promise<boolean> {
  const count = await db(TABLE).where({ id }).delete();
  return count > 0;
}
