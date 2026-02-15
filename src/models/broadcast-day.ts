import db from '../utils/db';

export type BroadcastStatus = 'scheduled' | 'live' | 'completed';

export interface BroadcastDay {
  id: string;
  stage_id: string;
  series_id: string;
  label: string;
  date: string;
  broadcast_start: Date | null;
  broadcast_end: Date | null;
  status: BroadcastStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateBroadcastDay {
  stage_id: string;
  series_id: string;
  label: string;
  date: string;
  broadcast_start?: Date | string;
  broadcast_end?: Date | string;
  status?: BroadcastStatus;
  metadata?: Record<string, unknown>;
}

export type UpdateBroadcastDay = Partial<Omit<CreateBroadcastDay, 'stage_id' | 'series_id'>>;

const TABLE = 'broadcast_days';

export async function create(data: CreateBroadcastDay): Promise<BroadcastDay> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row;
}

export async function findById(id: string): Promise<BroadcastDay | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findAll(filters?: Partial<Pick<BroadcastDay, 'stage_id' | 'series_id' | 'status'>>): Promise<BroadcastDay[]> {
  const query = db(TABLE);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        query.where(key, value);
      }
    }
  }
  return query.orderBy('date', 'asc');
}

export async function update(id: string, data: UpdateBroadcastDay): Promise<BroadcastDay> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...data, updated_at: db.fn.now() })
    .returning('*');
  return row;
}

export async function remove(id: string): Promise<boolean> {
  const count = await db(TABLE).where({ id }).delete();
  return count > 0;
}
