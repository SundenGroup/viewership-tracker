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
  stream_id: string | null;
  stream_title: string | null;
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
  stream_id?: string | null;
  stream_title?: string | null;
}

export type Scope =
  | { level: 'day' | 'stage' | 'series'; id: string }
  | { level: 'multi_stage'; ids: string[] };

/** Optional filter for language and/or platform (used by View Groups). */
export interface ViewFilter {
  languages?: string[];
  platforms?: string[];
  excludeTiers?: string[];
  excludeLanguages?: string[];
  excludeChannelIds?: string[];
}

/** Build conditional WHERE clauses for ViewFilter (raw SQL). */
export function buildFilterClauses(filter?: ViewFilter): { sql: string; bindings: Record<string, unknown> } {
  const parts: string[] = [];
  const bindings: Record<string, unknown> = {};
  if (filter?.languages?.length) {
    parts.push("AND SPLIT_PART(language, '-', 1) = ANY(:filterLanguages)");
    bindings.filterLanguages = filter.languages;
  }
  if (filter?.platforms?.length) {
    parts.push('AND platform = ANY(:filterPlatforms)');
    bindings.filterPlatforms = filter.platforms;
  }
  if (filter?.excludeLanguages?.length) {
    parts.push("AND SPLIT_PART(language, '-', 1) != ALL(:excludeLanguages)");
    bindings.excludeLanguages = filter.excludeLanguages;
  }
  if (filter?.excludeChannelIds?.length) {
    parts.push('AND channel_id != ALL(:excludeChannelIds::uuid[])');
    bindings.excludeChannelIds = filter.excludeChannelIds;
  }
  return { sql: parts.join(' '), bindings };
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
  channel_identifier: string;
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

function scopeColumn(scope: Scope & { level: 'day' | 'stage' | 'series' }): string {
  switch (scope.level) {
    case 'day': return 'viewership_snapshots.broadcast_day_id';
    case 'stage': return 'viewership_snapshots.stage_id';
    case 'series': return 'viewership_snapshots.series_id';
  }
}

/** Bare column name for use in raw SQL (no table prefix). */
function scopeColumnBare(scope: Scope & { level: 'day' | 'stage' | 'series' }): string {
  switch (scope.level) {
    case 'day': return 'broadcast_day_id';
    case 'stage': return 'stage_id';
    case 'series': return 'series_id';
  }
}

/**
 * Build a SQL WHERE fragment that resolves any Scope (single-target or
 * multi_stage) to a column predicate plus the bindings it needs.
 *
 * Single-target: `"<col>" = :scopeId`
 * Multi-stage:   `"stage_id" = ANY(:scopeIds::uuid[])`
 *
 * Pass `tablePrefix` (e.g. "vs") when the surrounding query joins another
 * table and the column needs to be qualified.
 */
function scopeWhereClause(
  scope: Scope,
  tablePrefix?: string,
): { sql: string; bindings: Record<string, unknown> } {
  const prefix = tablePrefix ? `${tablePrefix}.` : '';
  if (scope.level === 'multi_stage') {
    return {
      sql: `${prefix}"stage_id" = ANY(:scopeIds::uuid[])`,
      bindings: { scopeIds: scope.ids },
    };
  }
  const col = scopeColumnBare(scope);
  return {
    sql: `${prefix}"${col}" = :scopeId`,
    bindings: { scopeId: scope.id },
  };
}

function applyScope(query: Knex.QueryBuilder, scope: Scope): Knex.QueryBuilder {
  if (scope.level === 'multi_stage') {
    return query.whereIn('viewership_snapshots.stage_id', scope.ids);
  }
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

export async function getLatestSnapshot(seriesId: string, scope?: Scope, filter?: ViewFilter): Promise<Array<ViewershipSnapshot & { display_name: string; channel_identifier: string }>> {
  // Strategy: find the most recent BULK poll timestamp (ignoring view-group
  // filters), then return filtered snapshots from that poll cycle.
  //
  // Why ignore filters for the timestamp lookup?
  // Platforms are polled sequentially within each cycle. TikTok (scraped via
  // headless browser) finishes a few seconds after the API-based platforms,
  // so its timestamp is slightly newer. If we include the language/platform
  // filter when finding MAX(timestamp), we might pick the TikTok-only
  // timestamp and miss all other platforms' data from the same cycle.
  //
  // The scope (broadcast_day / stage) IS included because different days
  // genuinely have different poll windows.
  // Resolve the scope WHERE fragment. For series-level scope we don't add a
  // narrowing predicate (series_id is already implied by the AND below); for
  // multi_stage we use stage_id IN (…); for day/stage we use the matching
  // bare column.
  let scopeSql: string;
  let scopeBindings: Record<string, unknown>;
  if (!scope || scope.level === 'series') {
    scopeSql = '"series_id" = :scopeId';
    scopeBindings = { scopeId: seriesId };
  } else if (scope.level === 'multi_stage') {
    scopeSql = '"stage_id" = ANY(:scopeIds::uuid[])';
    scopeBindings = { scopeIds: scope.ids };
  } else {
    scopeSql = `"${scopeColumnBare(scope)}" = :scopeId`;
    scopeBindings = { scopeId: scope.id };
  }

  // Find the latest BULK poll timestamp — the most recent timestamp that has
  // more than 1 row. TikTok's headless scraper writes a single row ~30s after
  // the main adapters, so MAX(timestamp) often picks TikTok's lone row.
  // By requiring count > 1, we always land on the real bulk poll cycle.
  const latestTs = await db.raw(
    `SELECT "timestamp" AS ts
     FROM viewership_snapshots
     WHERE ${scopeSql}
       AND series_id = :seriesId
       AND "timestamp" > NOW() - INTERVAL '5 minutes'
     GROUP BY "timestamp"
     HAVING COUNT(*) > 1
     ORDER BY "timestamp" DESC
     LIMIT 1`,
    { ...scopeBindings, seriesId },
  ).then((r: { rows: Array<{ ts: Date | null }> }) => r.rows[0]?.ts ?? null);

  if (!latestTs) return [];

  // Return all snapshots at that exact bulk-poll timestamp
  const query = db(TABLE)
    .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
    .where('viewership_snapshots.series_id', seriesId)
    .where('viewership_snapshots.timestamp', latestTs)
    .select('viewership_snapshots.*', 'channels.display_name', 'channels.channel_identifier');

  if (scope && scope.level !== 'series') {
    if (scope.level === 'multi_stage') {
      query.whereIn('viewership_snapshots.stage_id', scope.ids);
    } else {
      query.where(scopeColumn(scope), scope.id);
    }
  }

  // Apply view-group filters (language / platform) ONLY on the result rows
  if (filter?.languages?.length) {
    query.whereRaw("SPLIT_PART(viewership_snapshots.language, '-', 1) = ANY(?)", [filter.languages]);
  }
  if (filter?.platforms?.length) query.whereIn('viewership_snapshots.platform', filter.platforms);

  const results = await query;

  // TikTok data arrives via relay a few seconds after the main poll cycle,
  // so it's often missing from the bulk-poll timestamp. Include the most
  // recent TikTok snapshot per channel (within last 2 minutes) to avoid
  // the dashboard showing 0 TikTok viewers between relay pushes.
  const hasTikTok = results.some((r: { platform: string }) => r.platform === 'tiktok');
  if (!hasTikTok) {
    const tiktokRows = await db.raw(`
      SELECT DISTINCT ON (vs.channel_id)
        vs.*, c.display_name, c.channel_identifier
      FROM viewership_snapshots vs
      JOIN channels c ON c.id = vs.channel_id
      WHERE vs.series_id = :seriesId
        AND vs.platform = 'tiktok'
        AND vs."timestamp" > NOW() - INTERVAL '2 minutes'
        AND vs.concurrent_viewers > 0
      ORDER BY vs.channel_id, vs."timestamp" DESC
    `, { seriesId }).then((r: { rows: Array<ViewershipSnapshot & { display_name: string; channel_identifier: string }> }) => r.rows);

    if (tiktokRows.length > 0) {
      results.push(...tiktokRows);
    }
  }

  return results;
}

export async function getPeakCCV(scope: Scope, filter?: ViewFilter): Promise<PeakCCVResult | null> {
  const sw = scopeWhereClause(scope);
  const f = buildFilterClauses(filter);
  // Bucket by minute, pick MAX CCV per poll cycle per channel, then SUM across channels.
  const result = await db.raw(
    `SELECT minute_bucket AS "timestamp", SUM(channel_ccv)::text AS total_ccv
     FROM (
       SELECT minute_bucket, channel_id, MAX(cycle_ccv) AS channel_ccv
       FROM (
         SELECT date_trunc('minute', "timestamp") AS minute_bucket,
                "timestamp" AS poll_ts, channel_id,
                SUM(concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots
         WHERE ${sw.sql} ${f.sql}
         GROUP BY minute_bucket, poll_ts, channel_id
       ) per_cycle
       GROUP BY minute_bucket, channel_id
     ) per_channel
     GROUP BY minute_bucket
     ORDER BY SUM(channel_ccv) DESC
     LIMIT 1`,
    { ...sw.bindings, ...f.bindings },
  ).then((r: { rows: PeakCCVResult[] }) => r.rows[0] ?? null);
  return result;
}

export async function getAverageCCV(scope: Scope, filter?: ViewFilter): Promise<string> {
  const sw = scopeWhereClause(scope);
  const f = buildFilterClauses(filter);
  // Bucket by minute, MAX CCV per channel per minute, then AVG of per-minute totals.
  const result = await db.raw(
    `SELECT ROUND(AVG(ts_total))::text AS avg_ccv
     FROM (
       SELECT minute_bucket, SUM(channel_ccv) AS ts_total
       FROM (
         SELECT minute_bucket, channel_id, MAX(cycle_ccv) AS channel_ccv
         FROM (
           SELECT date_trunc('minute', "timestamp") AS minute_bucket,
                  "timestamp" AS poll_ts, channel_id,
                  SUM(concurrent_viewers) AS cycle_ccv
           FROM viewership_snapshots
           WHERE ${sw.sql} ${f.sql}
           GROUP BY minute_bucket, poll_ts, channel_id
         ) per_cycle
         GROUP BY minute_bucket, channel_id
       ) per_channel
       GROUP BY minute_bucket
     ) per_ts`,
    { ...sw.bindings, ...f.bindings },
  ).then((r: { rows: Array<{ avg_ccv: string | null }> }) => r.rows[0]);
  return result?.avg_ccv ?? '0';
}

export async function getTotalViewedHours(scope: Scope, filter?: ViewFilter): Promise<string> {
  const sw = scopeWhereClause(scope);
  const f = buildFilterClauses(filter);
  // Bucket by minute, MAX CCV per channel per minute, then SUM all for total viewer-minutes.
  const result = await db.raw(
    `SELECT SUM(channel_ccv) AS total_viewer_minutes
     FROM (
       SELECT minute_bucket, channel_id, MAX(cycle_ccv) AS channel_ccv
       FROM (
         SELECT date_trunc('minute', "timestamp") AS minute_bucket,
                "timestamp" AS poll_ts, channel_id,
                SUM(concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots
         WHERE ${sw.sql} ${f.sql}
         GROUP BY minute_bucket, poll_ts, channel_id
       ) per_cycle
       GROUP BY minute_bucket, channel_id
     ) per_channel`,
    { ...sw.bindings, ...f.bindings },
  ).then((r: { rows: Array<{ total_viewer_minutes: string | null }> }) => r.rows[0]);
  const minutes = parseFloat(result?.total_viewer_minutes ?? '0');
  return (minutes / 60).toFixed(2);
}

/**
 * Three-level breakdown query: bucket by minute, MAX CCV per channel per minute,
 * then per-minute group totals, then AVG/MAX of those totals per group.
 * Works correctly with both 1x and 2x-per-minute polling.
 */
async function getBreakdown(scope: Scope, dimension: string, filter?: ViewFilter): Promise<BreakdownResult[]> {
  const sw = scopeWhereClause(scope);
  const f = buildFilterClauses(filter);
  return db.raw(
    `SELECT group_key AS key,
       SUM(ts_total)::text AS total_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       MAX(ts_total)::text AS peak_ccv
     FROM (
       SELECT minute_bucket, group_key, SUM(channel_ccv) AS ts_total
       FROM (
         SELECT minute_bucket, channel_id, group_key,
           MAX(cycle_ccv) AS channel_ccv
         FROM (
           SELECT date_trunc('minute', "timestamp") AS minute_bucket,
                  "timestamp" AS poll_ts, channel_id,
                  "${dimension}" AS group_key,
                  SUM(concurrent_viewers) AS cycle_ccv
           FROM viewership_snapshots
           WHERE ${sw.sql} ${f.sql}
           GROUP BY minute_bucket, poll_ts, channel_id, "${dimension}"
         ) per_cycle
         GROUP BY minute_bucket, channel_id, group_key
       ) per_channel
       GROUP BY minute_bucket, group_key
     ) per_ts
     GROUP BY group_key
     ORDER BY SUM(ts_total) DESC`,
    { ...sw.bindings, ...f.bindings },
  ).then((r: { rows: BreakdownResult[] }) => r.rows);
}

export async function getPlatformBreakdown(scope: Scope, filter?: ViewFilter): Promise<BreakdownResult[]> {
  return getBreakdown(scope, 'platform', filter);
}

export async function getLanguageBreakdown(scope: Scope, filter?: ViewFilter): Promise<BreakdownResult[]> {
  return getBreakdown(scope, 'language', filter);
}

export async function getRegionBreakdown(scope: Scope, filter?: ViewFilter): Promise<BreakdownResult[]> {
  return getBreakdown(scope, 'region', filter);
}

/**
 * Category/tier breakdown: joins channels to get tier, then buckets by minute,
 * MAX CCV per channel per minute, then per-minute tier totals → AVG/MAX per tier.
 */
export async function getTierBreakdown(scope: Scope, filter?: ViewFilter): Promise<BreakdownResult[]> {
  const sw = scopeWhereClause(scope, 'vs');
  const f = buildFilterClauses(filter);
  const fSql = f.sql.replace(/\blanguage\b/g, 'vs.language').replace(/\bplatform\b/g, 'vs.platform');
  return db.raw(
    `SELECT group_key AS key,
       SUM(ts_total)::text AS total_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       MAX(ts_total)::text AS peak_ccv
     FROM (
       SELECT minute_bucket, group_key, SUM(channel_ccv) AS ts_total
       FROM (
         SELECT minute_bucket, channel_id, group_key,
           MAX(cycle_ccv) AS channel_ccv
         FROM (
           SELECT date_trunc('minute', vs."timestamp") AS minute_bucket,
                  vs."timestamp" AS poll_ts, vs.channel_id,
                  c.tier AS group_key,
                  SUM(vs.concurrent_viewers) AS cycle_ccv
           FROM viewership_snapshots vs
           JOIN channels c ON c.id = vs.channel_id
           WHERE ${sw.sql} ${fSql}
           GROUP BY minute_bucket, poll_ts, vs.channel_id, c.tier
         ) per_cycle
         GROUP BY minute_bucket, channel_id, group_key
       ) per_channel
       GROUP BY minute_bucket, group_key
     ) per_ts
     GROUP BY group_key
     ORDER BY SUM(ts_total) DESC`,
    { ...sw.bindings, ...f.bindings },
  ).then((r: { rows: BreakdownResult[] }) => r.rows);
}

export async function getChannelLeaderboard(scope: Scope, limit = 25, filter?: ViewFilter): Promise<LeaderboardEntry[]> {
  // Bucket by minute, MAX CCV per channel per minute, then aggregate per channel.
  // Works correctly with both 1x and 2x-per-minute polling.
  const sw = scopeWhereClause(scope);
  const f = buildFilterClauses(filter);
  return db.raw(
    `SELECT
       pc.channel_id,
       c.display_name,
       c.channel_identifier,
       c.tier,
       c.language,
       pc.platform,
       MAX(pc.channel_ccv)::text AS peak_ccv,
       ROUND(AVG(pc.channel_ccv))::text AS avg_ccv,
       SUM(pc.channel_ccv)::text AS total_viewed_minutes
     FROM (
       SELECT minute_bucket, channel_id, platform,
         MAX(cycle_ccv) AS channel_ccv
       FROM (
         SELECT date_trunc('minute', "timestamp") AS minute_bucket,
                "timestamp" AS poll_ts, channel_id, platform,
                SUM(concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots
         WHERE ${sw.sql} ${f.sql}
         GROUP BY minute_bucket, poll_ts, channel_id, platform
       ) per_cycle
       GROUP BY minute_bucket, channel_id, platform
     ) pc
     JOIN channels c ON c.id = pc.channel_id
     GROUP BY pc.channel_id, c.display_name, c.channel_identifier, c.tier, c.language, pc.platform
     ORDER BY SUM(pc.channel_ccv) DESC
     LIMIT :limit`,
    { ...sw.bindings, limit, ...f.bindings },
  ).then((r: { rows: LeaderboardEntry[] }) => r.rows);
}

export async function getTimeSeriesData(scope: Scope, intervalSeconds = 60, filter?: ViewFilter): Promise<TimeSeriesBucket[]> {
  const sw = scopeWhereClause(scope);
  const f = buildFilterClauses(filter);
  // Three-level dedup: SUM multi-stream per poll cycle, MAX across poll cycles
  // per bucket per channel (picks highest CCV), then SUM across channels.
  // Works correctly with both 1x and 2x-per-minute polling.
  return db.raw(
    `SELECT bucket,
       SUM(channel_ccv)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT bucket, channel_id,
         MAX(cycle_ccv) AS channel_ccv
       FROM (
         SELECT
           date_trunc('minute', "timestamp")
             + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
             * interval '1 second' AS bucket,
           "timestamp" AS poll_ts,
           channel_id,
           SUM(concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots
         WHERE ${sw.sql} ${f.sql}
         GROUP BY bucket, poll_ts, channel_id
       ) per_cycle
       GROUP BY bucket, channel_id
     ) per_channel
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { interval: intervalSeconds, ...sw.bindings, ...f.bindings },
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
  groupBy: 'platform' | 'language' | 'tier',
  intervalSeconds = 60,
  filter?: ViewFilter,
): Promise<GroupedTimeSeriesBucket[]> {
  const f = buildFilterClauses(filter);

  // For 'tier', join with channels table; for others, use viewership_snapshots columns directly.
  // All branches: SUM multi-stream per poll cycle, MAX across poll cycles per bucket per channel.
  if (groupBy === 'tier') {
    const sw = scopeWhereClause(scope, 'vs');
    const fSql = f.sql.replace(/\blanguage\b/g, 'vs.language').replace(/\bplatform\b/g, 'vs.platform');
    return db.raw(
      `SELECT bucket, group_key,
         SUM(channel_ccv)::text AS total_ccv,
         COUNT(*)::text AS channel_count
       FROM (
         SELECT bucket, channel_id, group_key,
           MAX(cycle_ccv) AS channel_ccv
         FROM (
           SELECT
             date_trunc('minute', vs."timestamp")
               + (EXTRACT(epoch FROM vs."timestamp" - date_trunc('minute', vs."timestamp"))::int / :interval * :interval)
               * interval '1 second' AS bucket,
             vs."timestamp" AS poll_ts,
             vs.channel_id,
             c.tier AS group_key,
             SUM(vs.concurrent_viewers) AS cycle_ccv
           FROM viewership_snapshots vs
           JOIN channels c ON c.id = vs.channel_id
           WHERE ${sw.sql} ${fSql}
           GROUP BY bucket, poll_ts, vs.channel_id, c.tier
         ) per_cycle
         GROUP BY bucket, channel_id, group_key
       ) per_channel
       GROUP BY bucket, group_key
       ORDER BY bucket ASC, total_ccv DESC`,
      { interval: intervalSeconds, ...sw.bindings, ...f.bindings },
    ).then((r: { rows: GroupedTimeSeriesBucket[] }) => r.rows);
  }

  // Non-tier grouped time series (platform/language): same three-level approach.
  const sw = scopeWhereClause(scope);
  return db.raw(
    `SELECT bucket, group_key,
       SUM(channel_ccv)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT bucket, channel_id, group_key,
         MAX(cycle_ccv) AS channel_ccv
       FROM (
         SELECT
           date_trunc('minute', "timestamp")
             + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
             * interval '1 second' AS bucket,
           "timestamp" AS poll_ts,
           channel_id,
           "${groupBy}" AS group_key,
           SUM(concurrent_viewers) AS cycle_ccv
         FROM viewership_snapshots
         WHERE ${sw.sql} ${f.sql}
         GROUP BY bucket, poll_ts, channel_id, "${groupBy}"
       ) per_cycle
       GROUP BY bucket, channel_id, group_key
     ) per_channel
     GROUP BY bucket, group_key
     ORDER BY bucket ASC, total_ccv DESC`,
    { interval: intervalSeconds, ...sw.bindings, ...f.bindings },
  ).then((r: { rows: GroupedTimeSeriesBucket[] }) => r.rows);
}
