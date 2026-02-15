import db from '../utils/db';

export type MetricType = 'vod_views' | 'clip_views' | 'total_video_views';

export interface PostEventMetric {
  id: string;
  channel_id: string;
  broadcast_day_id: string | null;
  series_id: string;
  metric_type: MetricType;
  value: string;
  collected_at: Date;
  metadata: Record<string, unknown>;
}

export interface CreatePostEventMetric {
  channel_id: string;
  broadcast_day_id?: string;
  series_id: string;
  metric_type: MetricType;
  value: number | string;
  metadata?: Record<string, unknown>;
}

export type UpdatePostEventMetric = Partial<Omit<CreatePostEventMetric, 'channel_id' | 'series_id'>>;

const TABLE = 'post_event_metrics';

export async function create(data: CreatePostEventMetric): Promise<PostEventMetric> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row;
}

export async function findById(id: string): Promise<PostEventMetric | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findAll(filters?: Partial<Pick<PostEventMetric, 'channel_id' | 'broadcast_day_id' | 'series_id' | 'metric_type'>>): Promise<PostEventMetric[]> {
  const query = db(TABLE);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        query.where(key, value);
      }
    }
  }
  return query.orderBy('collected_at', 'desc');
}

export async function update(id: string, data: UpdatePostEventMetric): Promise<PostEventMetric> {
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
