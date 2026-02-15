import db from '../utils/db';
import type { TournamentStatus } from './tournament-series';

export interface Stage {
  id: string;
  series_id: string;
  name: string;
  order: number;
  start_date: string | null;
  end_date: string | null;
  status: TournamentStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateStage {
  series_id: string;
  name: string;
  order: number;
  start_date?: string;
  end_date?: string;
  status?: TournamentStatus;
  metadata?: Record<string, unknown>;
}

export type UpdateStage = Partial<Omit<CreateStage, 'series_id'>>;

const TABLE = 'stages';

export async function create(data: CreateStage): Promise<Stage> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row;
}

export async function findById(id: string): Promise<Stage | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findAll(filters?: Partial<Pick<Stage, 'series_id' | 'status'>>): Promise<Stage[]> {
  const query = db(TABLE);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        query.where(key, value);
      }
    }
  }
  return query.orderBy('order', 'asc');
}

export async function update(id: string, data: UpdateStage): Promise<Stage> {
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
