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
  language: string | null;
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
  // Find the timestamp with the highest total CCV across all channels.
  // Deduplicates per (timestamp, channel_id) using MAX to avoid double-counting
  // when a channel has rows under multiple broadcast days or duplicate poll cycles.
  const col = scopeColumnBare(scope);
  const result = await db.raw(
    `SELECT "timestamp", SUM(max_viewers)::text AS total_ccv
     FROM (
       SELECT "timestamp", channel_id, MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id
       GROUP BY "timestamp", channel_id
     ) per_channel
     GROUP BY "timestamp"
     ORDER BY total_ccv DESC
     LIMIT 1`,
    { id: scope.id },
  ).then((r: { rows: PeakCCVResult[] }) => r.rows[0] ?? null);
  return result;
}

export async function getAverageCCV(scope: Scope): Promise<string> {
  // Average of per-timestamp total CCV.
  // Deduplicates per (timestamp, channel_id) using MAX first.
  const col = scopeColumnBare(scope);
  const result = await db.raw(
    `SELECT ROUND(AVG(ts_total))::text AS avg_ccv
     FROM (
       SELECT "timestamp", SUM(max_viewers) AS ts_total
       FROM (
         SELECT "timestamp", channel_id, MAX(concurrent_viewers) AS max_viewers
         FROM viewership_snapshots
         WHERE "${col}" = :id
         GROUP BY "timestamp", channel_id
       ) per_channel
       GROUP BY "timestamp"
     ) per_ts`,
    { id: scope.id },
  ).then((r: { rows: Array<{ avg_ccv: string | null }> }) => r.rows[0]);
  return result?.avg_ccv ?? '0';
}

export async function getTotalViewedHours(scope: Scope): Promise<string> {
  // Each snapshot represents one polling interval of viewers.
  // SUM(concurrent_viewers) gives total viewer-minutes if interval is 1 min.
  // Divide by 60 for hours.
  // Deduplicates per (timestamp, channel_id) using MAX first.
  const col = scopeColumnBare(scope);
  const result = await db.raw(
    `SELECT SUM(max_viewers) AS total_viewer_minutes
     FROM (
       SELECT "timestamp", channel_id, MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id
       GROUP BY "timestamp", channel_id
     ) per_channel`,
    { id: scope.id },
  ).then((r: { rows: Array<{ total_viewer_minutes: string | null }> }) => r.rows[0]);
  const minutes = parseFloat(result?.total_viewer_minutes ?? '0');
  return (minutes / 60).toFixed(2);
}

/**
 * Two-level breakdown query: first sums all channel CCVs per (timestamp, group)
 * to get per-timestamp group totals, then computes AVG and MAX of those totals.
 * This gives the correct average and peak CCV for each group (platform/language/region).
 */
async function getBreakdown(scope: Scope, dimension: string): Promise<BreakdownResult[]> {
  const col = scopeColumnBare(scope);
  // Three-level query: deduplicate per (timestamp, channel_id, dimension) using MAX,
  // then sum per (timestamp, dimension), then aggregate per dimension.
  return db.raw(
    `SELECT group_key AS key,
       SUM(ts_total)::text AS total_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       MAX(ts_total)::text AS peak_ccv
     FROM (
       SELECT "timestamp", group_key, SUM(max_viewers) AS ts_total
       FROM (
         SELECT "timestamp", channel_id, "${dimension}" AS group_key,
           MAX(concurrent_viewers) AS max_viewers
         FROM viewership_snapshots
         WHERE "${col}" = :id
         GROUP BY "timestamp", channel_id, "${dimension}"
       ) per_channel
       GROUP BY "timestamp", group_key
     ) per_ts
     GROUP BY group_key
     ORDER BY total_ccv DESC`,
    { id: scope.id },
  ).then((r: { rows: BreakdownResult[] }) => r.rows);
}

export async function getPlatformBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  return getBreakdown(scope, 'platform');
}

export async function getLanguageBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  return getBreakdown(scope, 'language');
}

export async function getRegionBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  return getBreakdown(scope, 'region');
}

/**
 * Category/tier breakdown: joins channels to get tier, then applies the same
 * two-level aggregation (per-timestamp tier totals → AVG/MAX per tier).
 */
export async function getTierBreakdown(scope: Scope): Promise<BreakdownResult[]> {
  const col = scopeColumnBare(scope);
  // Three-level query: deduplicate per (timestamp, channel_id) using MAX,
  // then sum per (timestamp, tier), then aggregate per tier.
  return db.raw(
    `SELECT group_key AS key,
       SUM(ts_total)::text AS total_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       MAX(ts_total)::text AS peak_ccv
     FROM (
       SELECT "timestamp", group_key, SUM(max_viewers) AS ts_total
       FROM (
         SELECT vs."timestamp", vs.channel_id, c.tier AS group_key,
           MAX(vs.concurrent_viewers) AS max_viewers
         FROM viewership_snapshots vs
         JOIN channels c ON c.id = vs.channel_id
         WHERE vs."${col}" = :id
         GROUP BY vs."timestamp", vs.channel_id, c.tier
       ) per_channel
       GROUP BY "timestamp", group_key
     ) per_ts
     GROUP BY group_key
     ORDER BY total_ccv DESC`,
    { id: scope.id },
  ).then((r: { rows: BreakdownResult[] }) => r.rows);
}

export async function getChannelLeaderboard(scope: Scope, limit = 25): Promise<LeaderboardEntry[]> {
  // Deduplicate per (timestamp, channel_id) using MAX first, then aggregate per channel.
  // This avoids inflated totals when a channel has rows under multiple broadcast days.
  const col = scopeColumnBare(scope);
  return db.raw(
    `SELECT
       pc.channel_id,
       c.display_name,
       c.tier,
       c.language,
       pc.platform,
       MAX(pc.max_viewers)::text AS peak_ccv,
       ROUND(AVG(pc.max_viewers))::text AS avg_ccv,
       SUM(pc.max_viewers)::text AS total_viewed_minutes
     FROM (
       SELECT "timestamp", channel_id, platform,
         MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id
       GROUP BY "timestamp", channel_id, platform
     ) pc
     JOIN channels c ON c.id = pc.channel_id
     GROUP BY pc.channel_id, c.display_name, c.tier, c.language, pc.platform
     ORDER BY peak_ccv DESC
     LIMIT :limit`,
    { id: scope.id, limit },
  ).then((r: { rows: LeaderboardEntry[] }) => r.rows);
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
