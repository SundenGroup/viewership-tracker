import db from '../utils/db';

export type GameTrackerStatus = 'active' | 'paused';

export interface GameTracker {
  id: string;
  name: string;
  slug: string;
  status: GameTrackerStatus;
  twitch_game_id: string | null;
  twitch_game_name: string | null;
  kick_category_id: number | null;
  kick_category_slug: string | null;
  min_ccv_threshold: number;
  mismatch_threshold_cycles: number;
  discovery_interval_seconds: number;
  polling_interval_seconds: number;
  max_active_channels: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateGameTracker {
  name: string;
  slug: string;
  status?: GameTrackerStatus;
  twitch_game_id?: string | null;
  twitch_game_name?: string | null;
  kick_category_id?: number | null;
  kick_category_slug?: string | null;
  min_ccv_threshold?: number;
  mismatch_threshold_cycles?: number;
  discovery_interval_seconds?: number;
  polling_interval_seconds?: number;
  max_active_channels?: number;
  metadata?: Record<string, unknown>;
}

export type UpdateGameTracker = Partial<CreateGameTracker>;

const TABLE = 'game_trackers';

function serialize(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  if (out.metadata !== undefined && typeof out.metadata !== 'string') {
    out.metadata = JSON.stringify(out.metadata);
  }
  return out;
}

export async function create(data: CreateGameTracker): Promise<GameTracker> {
  const [row] = await db(TABLE)
    .insert(serialize(data as unknown as Record<string, unknown>))
    .returning('*');
  return row;
}

export async function findById(id: string): Promise<GameTracker | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findBySlug(slug: string): Promise<GameTracker | null> {
  const row = await db(TABLE).where({ slug }).first();
  return row ?? null;
}

export async function findAll(filters?: { status?: GameTrackerStatus }): Promise<GameTracker[]> {
  const query = db(TABLE);
  if (filters?.status) query.where('status', filters.status);
  return query.orderBy('created_at', 'desc');
}

export async function findActive(): Promise<GameTracker[]> {
  return db(TABLE).where('status', 'active').orderBy('created_at', 'asc');
}

export async function update(id: string, data: UpdateGameTracker): Promise<GameTracker> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...serialize(data as unknown as Record<string, unknown>), updated_at: db.fn.now() })
    .returning('*');
  return row;
}

export async function remove(id: string): Promise<boolean> {
  const count = await db(TABLE).where({ id }).delete();
  return count > 0;
}
