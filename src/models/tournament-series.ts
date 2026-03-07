import db from '../utils/db';

export type TournamentStatus = 'draft' | 'active' | 'completed';

export interface TournamentSeries {
  id: string;
  name: string;
  short_name: string | null;
  game: string | null;
  partner: string | null;
  status: TournamentStatus;
  timezone: string;
  auto_start_polling: boolean;
  start_date: string | null;
  end_date: string | null;
  discovery_keywords: string[];
  discovery_game_ids: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTournamentSeries {
  name: string;
  short_name?: string;
  game?: string;
  partner?: string;
  status?: TournamentStatus;
  timezone?: string;
  auto_start_polling?: boolean;
  start_date?: string;
  end_date?: string;
  discovery_keywords?: string[];
  discovery_game_ids?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type UpdateTournamentSeries = Partial<CreateTournamentSeries>;

const TABLE = 'tournament_series';

/** Ensure JSONB fields are stringified before passing to Knex/pg. */
function serializeJsonb(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  const jsonbFields = ['discovery_keywords', 'discovery_game_ids', 'metadata'];
  for (const field of jsonbFields) {
    if (out[field] !== undefined && typeof out[field] !== 'string') {
      out[field] = JSON.stringify(out[field]);
    }
  }
  return out;
}

export async function create(data: CreateTournamentSeries): Promise<TournamentSeries> {
  const [row] = await db(TABLE)
    .insert(serializeJsonb(data as unknown as Record<string, unknown>))
    .returning('*');
  return row;
}

export async function findById(id: string): Promise<TournamentSeries | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findAll(filters?: Partial<Pick<TournamentSeries, 'status' | 'game' | 'partner'>>): Promise<TournamentSeries[]> {
  const query = db(TABLE);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        query.where(key, value);
      }
    }
  }
  return query.orderBy('created_at', 'desc');
}

export async function update(id: string, data: UpdateTournamentSeries): Promise<TournamentSeries> {
  const serialized = serializeJsonb(data as unknown as Record<string, unknown>);
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...serialized, updated_at: db.fn.now() })
    .returning('*');
  return row;
}

export async function remove(id: string): Promise<boolean> {
  const count = await db(TABLE).where({ id }).delete();
  return count > 0;
}

export async function findWithStages(seriesId: string): Promise<TournamentSeries & { stages: Array<Record<string, unknown> & { broadcast_days: Record<string, unknown>[] }> } | null> {
  const series = await findById(seriesId);
  if (!series) return null;

  const stages = await db('stages')
    .where({ series_id: seriesId })
    .orderBy('order', 'asc');

  const stageIds = stages.map((s) => s.id);

  const broadcastDays = stageIds.length > 0
    ? await db('broadcast_days')
        .whereIn('stage_id', stageIds)
        .orderBy('date', 'asc')
    : [];

  const broadcastDaysByStage = new Map<string, Record<string, unknown>[]>();
  for (const day of broadcastDays) {
    const list = broadcastDaysByStage.get(day.stage_id) ?? [];
    list.push(day);
    broadcastDaysByStage.set(day.stage_id, list);
  }

  const stagesWithDays = stages.map((stage) => ({
    ...stage,
    broadcast_days: broadcastDaysByStage.get(stage.id) ?? [],
  }));

  return { ...series, stages: stagesWithDays };
}

export async function updateStatus(seriesId: string, status: TournamentStatus): Promise<TournamentSeries> {
  return update(seriesId, { status });
}
