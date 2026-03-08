import db from '../utils/db';
import type { Knex } from 'knex';

export interface ViewershipSnapshot {
  id: string;
  channel_id: string;
  broadcast_day_id: string | null;
  stage_id: string | null;
  series_id: string | null;
  timestamp: Date;
  concurrent_viewers: number;
  platform: string | null;
  language: string | null;
  region: string | null;
}

export interface CreateViewershipSnapshot {
  channel_id: string;
  broadcast_day_id?: string;
  stage_id?: string;
  series_id?: string;
  timestamp: Date | string;
  concurrent_viewers: number;
  platform?: string;
  language?: string;
  region?: string;
}

export interface Scope {
  level: 'day' | 'stage' | 'series';
  id: string;
}

export interface PeakCCVResult {
  timestamp: Date;
  total_ccv: string;
}

export interface BreakdownResult {
  key: string;
  total_ccv: string;
  avg_ccv: string;
  peak_ccv: string;
}

export interface LeaderboardEntry {
  channel_id: string;
  display_name: string;
  platform: string;
  tier: string;
  peak_ccv: string;
  avg_ccv: string;
  total_viewed_minutes: string;
}

export interface TimeSeriesBucket {
  bucket: Date;
  total_ccv: string;
  channel_count: string;
}

const TABLE = 'viewership_snapshots';

function scopeColumn(scope: Scope): string {
  switch (scope.level) {
    case 'day': return 'viewership_snapshots.broadcast_day_id';
    case 'stage': return 'viewership_snapshots.stage_id';
    case 'series': return 'viewership_snapshots.series_id';
  }
}

/** Bare column name for use in raw SQL (no table prefix). */
function scopeColumnBare(scope: Scope): string {
  switch (scope.level) {
    case 'day': return 'broadcast_day_id';
    case 'stage': return 'stage_id';
    case 'series': return 'series_id';
  }
}

function applyScope(query: Knex.QueryBuilder, scope: Scope): Knex.QueryBuilder {
  return query.where(scopeColumn(scope), scope.id);
}

// --- Basic CRUD ---

export async function create(data: CreateViewershipSnapshot): Promise<ViewershipSnapshot> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row;
}

export async function findById(id: string): Promise<ViewershipSnapshot | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ?? null;
}

export async function findAll(filters?: Partial<Pick<ViewershipSnapshot, 'channel_id' | 'broadcast_day_id' | 'stage_id' | 'series_id' | 'platform' | 'language' | 'region'>>): Promise<ViewershipSnapshot[]> {
  const query = db(TABLE);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        query.where(key, value);
      }
    }
  }
  return query.orderBy('timestamp', 'asc');
}

export async function update(id: string, data: Partial<CreateViewershipSnapshot>): Promise<ViewershipSnapshot> {
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

// --- Aggregation Queries ---

export async function getSnapshotsForScope(scope: Scope): Promise<ViewershipSnapshot[]> {
  return applyScope(db(TABLE), scope).orderBy('timestamp', 'asc');
}

export async function getLatestSnapshot(seriesId: string): Promise<Array<ViewershipSnapshot & { display_name: string; channel_identifier: string }>> {
  return db(TABLE)
    .distinctOn('viewership_snapshots.channel_id')
    .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
    .where('viewership_snapshots.series_id', seriesId)
    .orderBy([
      { column: 'viewership_snapshots.channel_id' },
      { column: 'viewership_snapshots.timestamp', order: 'desc' },
    ])
    .select('viewership_snapshots.*', 'channels.display_name', 'channels.channel_identifier');
}

export async function getPeakCCV(scope: Scope): Promise<PeakCCVResult | null> {
  // Find the timestamp with the highest total CCV across all channels
  const result = await applyScope(db(TABLE), scope)
    .select('timestamp')
    .sum('concurrent_viewers as total_ccv')
    .groupBy('timestamp')
    .orderBy('total_ccv', 'desc')
    .first();
  return result ?? null;
}

export async function getAverageCCV(scope: Scope): Promise<string> {
  // Average of per-timestamp total CCV
  const sub = applyScope(db(TABLE), scope)
    .select('timestamp')
    .sum('concurrent_viewers as ts_total')
    .groupBy('timestamp')
    .as('per_ts');

  const result = await db.from(sub)
    .avg('ts_total as avg_ccv')
    .first<{ avg_ccv: string | null }>();
  return result?.avg_ccv ?? '0';
}

export async function getTotalViewedHours(scope: Scope): Promise<string> {
  // Each snapshot represents one polling interval of viewers.
  // SUM(concurrent_viewers) gives total viewer-minutes if interval is 1 min.
  // Divide by 60 for hours.
  const result = await applyScope(db(TABLE), scope)
    .sum('concurrent_viewers as total_viewer_minutes')
    .first();
  const minutes = parseFloat(result?.total_viewer_minutes ?? '0');
  return (minutes / 60).toFixed(2);
}

export async function getPlatformBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  return applyScope(db(TABLE), scope)
    .select('platform as key')
    .sum('concurrent_viewers as total_ccv')
    .avg('concurrent_viewers as avg_ccv')
    .max('concurrent_viewers as peak_ccv')
    .groupBy('platform')
    .orderBy('total_ccv', 'desc');
}

export async function getLanguageBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  return applyScope(db(TABLE), scope)
    .select('language as key')
    .sum('concurrent_viewers as total_ccv')
    .avg('concurrent_viewers as avg_ccv')
    .max('concurrent_viewers as peak_ccv')
    .groupBy('language')
    .orderBy('total_ccv', 'desc');
}

export async function getRegionBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  return applyScope(db(TABLE), scope)
    .select('region as key')
    .sum('concurrent_viewers as total_ccv')
    .avg('concurrent_viewers as avg_ccv')
    .max('concurrent_viewers as peak_ccv')
    .groupBy('region')
    .orderBy('total_ccv', 'desc');
}

export async function getChannelLeaderboard(scope: Scope, limit = 25): Promise<LeaderboardEntry[]> {
  return applyScope(db(TABLE), scope)
    .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
    .select(
      'viewership_snapshots.channel_id',
      'channels.display_name',
      'channels.tier',
      'viewership_snapshots.platform',
    )
    .max('concurrent_viewers as peak_ccv')
    .avg('concurrent_viewers as avg_ccv')
    .sum('concurrent_viewers as total_viewed_minutes')
    .groupBy(
      'viewership_snapshots.channel_id',
      'channels.display_name',
      'channels.tier',
      'viewership_snapshots.platform',
    )
    .orderBy('peak_ccv', 'desc')
    .limit(limit);
}

export async function getTimeSeriesData(scope: Scope, intervalSeconds = 60): Promise<TimeSeriesBucket[]> {
  const col = scopeColumnBare(scope);
  // Subquery deduplicates per channel within each bucket (MAX) to avoid
  // double-counting when multiple poll cycles land in the same time bucket
  // (e.g. after a deploy restart).
  return db.raw(
    `SELECT bucket,
       SUM(max_viewers)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT
         date_trunc('minute', "timestamp")
           + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
           * interval '1 second' AS bucket,
         channel_id,
         MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id
       GROUP BY bucket, channel_id
     ) per_channel
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { interval: intervalSeconds, id: scope.id },
  ).then((r: { rows: TimeSeriesBucket[] }) => r.rows);
}

export interface GroupedTimeSeriesBucket {
  bucket: Date;
  group_key: string;
  total_ccv: string;
  channel_count: string;
}

/**
 * Fetch time-series data grouped by a dimension (platform or language).
 * Returns bucketed CCV per group, ordered by timestamp then CCV descending.
 */
export async function getGroupedTimeSeriesData(
  scope: Scope,
  groupBy: 'platform' | 'language',
  intervalSeconds = 60,
): Promise<GroupedTimeSeriesBucket[]> {
  const col = scopeColumnBare(scope);
  // Subquery deduplicates per channel within each bucket (MAX) to avoid
  // double-counting when multiple poll cycles land in the same time bucket.
  return db.raw(
    `SELECT bucket, group_key,
       SUM(max_viewers)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT
         date_trunc('minute', "timestamp")
           + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
           * interval '1 second' AS bucket,
         channel_id,
         "${groupBy}" AS group_key,
         MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id
       GROUP BY bucket, channel_id, group_key
     ) per_channel
     GROUP BY bucket, group_key
     ORDER BY bucket ASC, total_ccv DESC`,
    { interval: intervalSeconds, id: scope.id },
  ).then((r: { rows: GroupedTimeSeriesBucket[] }) => r.rows);
}
