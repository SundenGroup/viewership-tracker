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

export interface Scope {
  level: 'day' | 'stage' | 'series';
  id: string;
}

/** Optional filter for language and/or platform (used by View Groups). */
export interface ViewFilter {
  languages?: string[];
  platforms?: string[];
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

export async function getLatestSnapshot(seriesId: string, scope?: Scope, filter?: ViewFilter): Promise<Array<ViewershipSnapshot & { display_name: string; channel_identifier: string }>> {
  // Strategy: find the most recent poll timestamp, then return all snapshots
  // at that timestamp. This avoids summing stale stream_id entries from
  // earlier polls (multi-stream channels can produce different stream_ids
  // each cycle, and DISTINCT ON would keep every historic stream_id's
  // latest row, massively inflating the CCV total).
  const col = scope && scope.level !== 'series' ? scopeColumnBare(scope) : 'series_id';
  const scopeId = scope && scope.level !== 'series' ? scope.id : seriesId;

  const f = buildFilterClauses(filter);

  // Find the most recent timestamp in scope
  const latestTs = await db.raw(
    `SELECT MAX("timestamp") AS ts
     FROM viewership_snapshots
     WHERE "${col}" = :scopeId
       AND series_id = :seriesId
       ${f.sql}`,
    { scopeId, seriesId, ...f.bindings },
  ).then((r: { rows: Array<{ ts: Date | null }> }) => r.rows[0]?.ts ?? null);

  if (!latestTs) return [];

  // Return all snapshots at that timestamp, one per (channel, stream)
  const query = db(TABLE)
    .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
    .where('viewership_snapshots.series_id', seriesId)
    .where('viewership_snapshots.timestamp', latestTs)
    .select('viewership_snapshots.*', 'channels.display_name', 'channels.channel_identifier');

  if (scope && scope.level !== 'series') {
    query.where(scopeColumn(scope), scope.id);
  }

  if (filter?.languages?.length) {
    query.whereRaw("SPLIT_PART(viewership_snapshots.language, '-', 1) = ANY(?)", [filter.languages]);
  }
  if (filter?.platforms?.length) query.whereIn('viewership_snapshots.platform', filter.platforms);

  return query;
}

export async function getPeakCCV(scope: Scope, filter?: ViewFilter): Promise<PeakCCVResult | null> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
  const result = await db.raw(
    `SELECT "timestamp", SUM(max_viewers)::text AS total_ccv
     FROM (
       SELECT "timestamp", channel_id, MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id ${f.sql}
       GROUP BY "timestamp", channel_id, stream_id
     ) per_channel
     GROUP BY "timestamp"
     ORDER BY SUM(max_viewers) DESC
     LIMIT 1`,
    { id: scope.id, ...f.bindings },
  ).then((r: { rows: PeakCCVResult[] }) => r.rows[0] ?? null);
  return result;
}

export async function getAverageCCV(scope: Scope, filter?: ViewFilter): Promise<string> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
  const result = await db.raw(
    `SELECT ROUND(AVG(ts_total))::text AS avg_ccv
     FROM (
       SELECT "timestamp", SUM(max_viewers) AS ts_total
       FROM (
         SELECT "timestamp", channel_id, MAX(concurrent_viewers) AS max_viewers
         FROM viewership_snapshots
         WHERE "${col}" = :id ${f.sql}
         GROUP BY "timestamp", channel_id, stream_id
       ) per_channel
       GROUP BY "timestamp"
     ) per_ts`,
    { id: scope.id, ...f.bindings },
  ).then((r: { rows: Array<{ avg_ccv: string | null }> }) => r.rows[0]);
  return result?.avg_ccv ?? '0';
}

export async function getTotalViewedHours(scope: Scope, filter?: ViewFilter): Promise<string> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
  const result = await db.raw(
    `SELECT SUM(max_viewers) AS total_viewer_minutes
     FROM (
       SELECT "timestamp", channel_id, MAX(concurrent_viewers) AS max_viewers
       FROM viewership_snapshots
       WHERE "${col}" = :id ${f.sql}
       GROUP BY "timestamp", channel_id, stream_id
     ) per_channel`,
    { id: scope.id, ...f.bindings },
  ).then((r: { rows: Array<{ total_viewer_minutes: string | null }> }) => r.rows[0]);
  const minutes = parseFloat(result?.total_viewer_minutes ?? '0');
  return (minutes / 60).toFixed(2);
}

/**
 * Two-level breakdown query: first sums all channel CCVs per (timestamp, group)
 * to get per-timestamp group totals, then computes AVG and MAX of those totals.
 * This gives the correct average and peak CCV for each group (platform/language/region).
 */
async function getBreakdown(scope: Scope, dimension: string, filter?: ViewFilter): Promise<BreakdownResult[]> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
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
         WHERE "${col}" = :id ${f.sql}
         GROUP BY "timestamp", channel_id, stream_id, "${dimension}"
       ) per_channel
       GROUP BY "timestamp", group_key
     ) per_ts
     GROUP BY group_key
     ORDER BY SUM(ts_total) DESC`,
    { id: scope.id, ...f.bindings },
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
 * Category/tier breakdown: joins channels to get tier, then applies the same
 * two-level aggregation (per-timestamp tier totals → AVG/MAX per tier).
 */
export async function getTierBreakdown(scope: Scope, filter?: ViewFilter): Promise<BreakdownResult[]> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
  // Tier filter clauses need vs. prefix — rewrite filter SQL with alias
  const fSql = f.sql.replace(/\blanguage\b/g, 'vs.language').replace(/\bplatform\b/g, 'vs.platform');
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
         WHERE vs."${col}" = :id ${fSql}
         GROUP BY vs."timestamp", vs.channel_id, vs.stream_id, c.tier
       ) per_channel
       GROUP BY "timestamp", group_key
     ) per_ts
     GROUP BY group_key
     ORDER BY SUM(ts_total) DESC`,
    { id: scope.id, ...f.bindings },
  ).then((r: { rows: BreakdownResult[] }) => r.rows);
}

export async function getChannelLeaderboard(scope: Scope, limit = 25, filter?: ViewFilter): Promise<LeaderboardEntry[]> {
  // Deduplicate per (timestamp, channel_id) using MAX first, then aggregate per channel.
  // This avoids inflated totals when a channel has rows under multiple broadcast days.
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
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
       WHERE "${col}" = :id ${f.sql}
       GROUP BY "timestamp", channel_id, stream_id, platform
     ) pc
     JOIN channels c ON c.id = pc.channel_id
     GROUP BY pc.channel_id, c.display_name, c.tier, c.language, pc.platform
     ORDER BY MAX(pc.max_viewers) DESC
     LIMIT :limit`,
    { id: scope.id, limit, ...f.bindings },
  ).then((r: { rows: LeaderboardEntry[] }) => r.rows);
}

export async function getTimeSeriesData(scope: Scope, intervalSeconds = 60, filter?: ViewFilter): Promise<TimeSeriesBucket[]> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
  // Two-level dedup:
  // 1. Inner: pick one poll cycle per bucket per channel (MAX timestamp) to
  //    avoid double-counting when deploys/restarts cause two polls in one bucket.
  // 2. Then: SUM the CCV at that chosen timestamp across all streams for the channel.
  //    This correctly sums genuine multi-stream channels while ignoring stale stream_ids
  //    from earlier poll cycles (whose stream_ids may differ).
  return db.raw(
    `SELECT bucket,
       SUM(channel_ccv)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT bucket, channel_id,
         SUM(concurrent_viewers) AS channel_ccv
       FROM (
         SELECT
           date_trunc('minute', "timestamp")
             + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
             * interval '1 second' AS bucket,
           channel_id,
           concurrent_viewers,
           "timestamp",
           MAX("timestamp") OVER (PARTITION BY
             date_trunc('minute', "timestamp")
               + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
               * interval '1 second',
             channel_id
           ) AS latest_ts
         FROM viewership_snapshots
         WHERE "${col}" = :id ${f.sql}
       ) with_latest
       WHERE "timestamp" = latest_ts
       GROUP BY bucket, channel_id
     ) per_channel
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { interval: intervalSeconds, id: scope.id, ...f.bindings },
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
  filter?: ViewFilter,
): Promise<GroupedTimeSeriesBucket[]> {
  const col = scopeColumnBare(scope);
  const f = buildFilterClauses(filter);
  // Two-level dedup: pick one poll cycle per bucket per channel (latest timestamp),
  // then sum CCV across streams for that channel. Avoids double-counting when
  // deploys/restarts cause two polls in one bucket with different stream_ids.
  return db.raw(
    `SELECT bucket, group_key,
       SUM(channel_ccv)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT bucket, channel_id, group_key,
         SUM(concurrent_viewers) AS channel_ccv
       FROM (
         SELECT
           date_trunc('minute', "timestamp")
             + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
             * interval '1 second' AS bucket,
           channel_id,
           "${groupBy}" AS group_key,
           concurrent_viewers,
           "timestamp",
           MAX("timestamp") OVER (PARTITION BY
             date_trunc('minute', "timestamp")
               + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / :interval * :interval)
               * interval '1 second',
             channel_id
           ) AS latest_ts
         FROM viewership_snapshots
         WHERE "${col}" = :id ${f.sql}
       ) with_latest
       WHERE "timestamp" = latest_ts
       GROUP BY bucket, channel_id, group_key
     ) per_channel
     GROUP BY bucket, group_key
     ORDER BY bucket ASC, total_ccv DESC`,
    { interval: intervalSeconds, id: scope.id, ...f.bindings },
  ).then((r: { rows: GroupedTimeSeriesBucket[] }) => r.rows);
}
