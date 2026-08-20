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
  region: string | null;
  peak_ccv: string;
  avg_ccv: string;
  total_viewed_minutes: string;
  /** Minute the channel hit its peak — partners ask "WHEN did we peak?". */
  peak_at: Date | null;
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

// --- Rollup read helpers -----------------------------------------------------
//
// All report aggregations read from `viewership_minute_rollup` (one row per
// channel per minute = the already-deduped per_cycle→per_channel value that
// the raw queries used to compute on the fly). The rollup carries the scope
// columns (broadcast_day_id/stage_id/series_id) so scope filtering needs no
// join; platform/language/region/tier come from JOIN channels, so channel
// metadata edits surface in reports immediately.
//
// `ROLLUP` is the table alias `r`; `channels` joins as `c` when a query needs
// a dimension or a language/platform filter.

const ROLLUP = 'viewership_minute_rollup';

/** True when the filter references a channels column (needs the join). */
function filterNeedsChannelJoin(filter?: ViewFilter): boolean {
  return Boolean(
    filter?.languages?.length ||
      filter?.platforms?.length ||
      filter?.excludeLanguages?.length,
  );
}

/**
 * Builds the `FROM … WHERE …` fragment for a rollup read: scope predicate on
 * the rollup (alias r) plus the view filter, with channels (alias c) joined
 * when the filter or caller needs channel columns. Filter clauses from
 * buildFilterClauses use bare column names — remap them onto r/c.
 */
function rollupFromWhere(
  scope: Scope,
  filter?: ViewFilter,
  opts?: { forceJoin?: boolean },
): { sql: string; bindings: Record<string, unknown>; joined: boolean } {
  const joined = Boolean(opts?.forceJoin) || filterNeedsChannelJoin(filter);
  const sw = scopeWhereClause(scope, 'r');
  const f = buildFilterClauses(filter);
  let filterSql = f.sql.replace(/\bchannel_id\b/g, 'r.channel_id');
  if (joined) {
    filterSql = filterSql
      .replace(/\blanguage\b/g, 'c.language')
      .replace(/\bplatform\b/g, 'c.platform');
  }
  const from = joined
    ? `${ROLLUP} r JOIN channels c ON c.id = r.channel_id`
    : `${ROLLUP} r`;
  return {
    sql: `FROM ${from} WHERE ${sw.sql} ${filterSql}`,
    bindings: { ...sw.bindings, ...f.bindings },
    joined,
  };
}

/** Interval-bucket SQL expression over the rollup's minute_bucket column. */
function rollupBucketExpr(): string {
  // floor(epoch / interval) * interval → bucket start. For interval=60 this
  // is a no-op (minute_bucket is already minute-aligned); for 300/600 it
  // groups minutes into 5-/10-min buckets, and the outer MAX(ccv) reproduces
  // the raw query's "MAX cycle across the bucket" since a multi-minute MAX
  // equals the MAX of the per-minute MAXes.
  return `to_timestamp(floor(extract(epoch FROM r.minute_bucket) / :interval) * :interval)`;
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

export async function getLatestSnapshot(seriesId: string, scope?: Scope, filter?: ViewFilter): Promise<Array<ViewershipSnapshot & { display_name: string; channel_identifier: string; tier: string | null; yt_api_stream: boolean }>> {
  // Strategy: each channel's LATEST snapshot within a short freshness
  // window. The previous approach picked one exact "bulk poll timestamp"
  // and returned only rows stamped precisely then — built when a single
  // orchestrator wrote every platform in sync. TikTok (and any relay-fed
  // platform) writes on its own clock, forming a separate row-group;
  // whichever group was momentarily newest won EXCLUSIVELY, so TikTok
  // flickered between fully-present and fully-offline on the live
  // dashboard (and a lone straggler row suppressed the old TikTok-only
  // fallback, producing the "4 viewers" states). Per-channel latest is
  // immune to source interleaving: a channel is live iff it reported
  // recently, no matter which pipeline carried the report.
  //
  // Window: 4 minutes — comfortably above the TikTok relay's worst lag
  // and Helix's stepped cadence, short enough that a channel that stops
  // reporting drops out of the live total within minutes.
  let scopeSql = '';
  const bindings: Record<string, unknown> = { seriesId };
  if (scope && scope.level !== 'series') {
    if (scope.level === 'multi_stage') {
      scopeSql = 'AND vs.stage_id = ANY(:scopeIds::uuid[])';
      bindings.scopeIds = scope.ids;
    } else {
      scopeSql = `AND vs."${scopeColumnBare(scope)}" = :scopeId`;
      bindings.scopeId = scope.id;
    }
  }
  let filterSql = '';
  if (filter?.languages?.length) {
    filterSql += " AND SPLIT_PART(vs.language, '-', 1) = ANY(:filterLanguages)";
    bindings.filterLanguages = filter.languages;
  }
  if (filter?.platforms?.length) {
    filterSql += ' AND vs.platform::text = ANY(:filterPlatforms)';
    bindings.filterPlatforms = filter.platforms;
  }

  return db
    .raw(
      `SELECT DISTINCT ON (vs.channel_id)
         vs.*, c.display_name, c.channel_identifier, c.tier,
         (COALESCE(c.metadata->>'multi_stream_via_api', '') = 'true'
          OR EXISTS (SELECT 1 FROM channels p
                     WHERE p.id::text = c.metadata->>'multi_stream_parent'
                       AND COALESCE(p.metadata->>'multi_stream_via_api', '') = 'true')) AS yt_api_stream
       FROM viewership_snapshots vs
       JOIN channels c ON c.id = vs.channel_id
       WHERE vs.series_id = :seriesId
         ${scopeSql}
         AND vs."timestamp" > NOW() - INTERVAL '4 minutes'
         AND c.is_active = true
         ${filterSql}
       ORDER BY vs.channel_id, vs."timestamp" DESC`,
      bindings,
    )
    .then(
      (r: { rows: Array<ViewershipSnapshot & { display_name: string; channel_identifier: string; tier: string | null; yt_api_stream: boolean }> }) =>
        r.rows,
    );
}


export async function getPeakCCV(scope: Scope, filter?: ViewFilter): Promise<PeakCCVResult | null> {
  // Per-minute total = SUM of per-channel rollup CCV; peak = the top minute.
  const fw = rollupFromWhere(scope, filter);
  const result = await db.raw(
    `SELECT minute_bucket AS "timestamp", SUM(r.ccv)::text AS total_ccv
     ${fw.sql}
     GROUP BY minute_bucket
     ORDER BY SUM(r.ccv) DESC
     LIMIT 1`,
    fw.bindings,
  ).then((r: { rows: PeakCCVResult[] }) => r.rows[0] ?? null);
  return result;
}

export async function getAverageCCV(scope: Scope, filter?: ViewFilter): Promise<string> {
  const sw = scopeWhereClause(scope);
  // Per-minute total = SUM of per-channel rollup CCV; then AVG across minutes.
  const fw = rollupFromWhere(scope, filter);
  const result = await db.raw(
    `SELECT ROUND(AVG(ts_total))::text AS avg_ccv
     FROM (
       SELECT minute_bucket, SUM(r.ccv) AS ts_total
       ${fw.sql}
       GROUP BY minute_bucket
     ) per_ts`,
    fw.bindings,
  ).then((r: { rows: Array<{ avg_ccv: string | null }> }) => r.rows[0]);
  return result?.avg_ccv ?? '0';
}

export async function getTotalViewedHours(scope: Scope, filter?: ViewFilter): Promise<string> {
  // Total viewer-minutes = SUM of every per-channel-per-minute rollup CCV.
  const fw = rollupFromWhere(scope, filter);
  const result = await db.raw(
    `SELECT SUM(r.ccv) AS total_viewer_minutes ${fw.sql}`,
    fw.bindings,
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
  // dimension is a channels column (platform/language/region) → force join.
  // Per-minute group total = SUM of rollup CCV grouped by the dimension;
  // then AVG/MAX/SUM of those per-minute totals per group.
  const fw = rollupFromWhere(scope, filter, { forceJoin: true });
  return db.raw(
    `SELECT group_key AS key,
       SUM(ts_total)::text AS total_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       MAX(ts_total)::text AS peak_ccv
     FROM (
       SELECT minute_bucket, c."${dimension}" AS group_key, SUM(r.ccv) AS ts_total
       ${fw.sql}
       GROUP BY minute_bucket, c."${dimension}"
     ) per_ts
     GROUP BY group_key
     ORDER BY SUM(ts_total) DESC`,
    fw.bindings,
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
  // tier lives on channels → force join. Same shape as getBreakdown.
  const fw = rollupFromWhere(scope, filter, { forceJoin: true });
  return db.raw(
    `SELECT group_key AS key,
       SUM(ts_total)::text AS total_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       MAX(ts_total)::text AS peak_ccv
     FROM (
       SELECT minute_bucket, c.tier AS group_key, SUM(r.ccv) AS ts_total
       ${fw.sql}
       GROUP BY minute_bucket, c.tier
     ) per_ts
     GROUP BY group_key
     ORDER BY SUM(ts_total) DESC`,
    fw.bindings,
  ).then((r: { rows: BreakdownResult[] }) => r.rows);
}

export async function getChannelLeaderboard(scope: Scope, limit = 25, filter?: ViewFilter): Promise<LeaderboardEntry[]> {
  // Aggregate the per-channel-per-minute rollup directly per channel.
  // Always joins channels for the display columns.
  // NOTE: deliberately NOT filtering by c.is_active — the report leaderboard
  // is a historical aggregation; a channel that streamed then got disabled
  // afterward still earned its viewership. Live-CCV keeps the is_active filter.
  const fw = rollupFromWhere(scope, filter, { forceJoin: true });
  return db.raw(
    `SELECT
       r.channel_id,
       c.display_name,
       c.channel_identifier,
       c.tier,
       c.language,
       c.region,
       c.platform,
       MAX(r.ccv)::text AS peak_ccv,
       ROUND(AVG(r.ccv))::text AS avg_ccv,
       SUM(r.ccv)::text AS total_viewed_minutes,
       (ARRAY_AGG(r.minute_bucket ORDER BY r.ccv DESC, r.minute_bucket ASC))[1] AS peak_at
     ${fw.sql}
     GROUP BY r.channel_id, c.display_name, c.channel_identifier, c.tier, c.language, c.region, c.platform
     ORDER BY SUM(r.ccv) DESC
     LIMIT :limit`,
    { ...fw.bindings, limit },
  ).then((r: { rows: LeaderboardEntry[] }) => r.rows);
}

export interface LanguagePeakRow {
  language: string | null;
  peak_ccv: string;
  avg_ccv: string;
  viewer_minutes: string;
  peak_at: Date;
}

/**
 * Per-language stats — the "Peak by language" table partners ask for
 * after every event. For each language: the single highest minute (sum
 * of that language's per-channel rollup CCV), WHEN it happened, the
 * average per-minute total, and total viewer-minutes. Same three-level
 * aggregation semantics as getBreakdown().
 */
export async function getLanguagePeaks(
  scope: Scope,
  filter?: ViewFilter,
): Promise<LanguagePeakRow[]> {
  const fw = rollupFromWhere(scope, filter, { forceJoin: true });
  return db.raw(
    `SELECT group_key AS language,
       MAX(ts_total)::text AS peak_ccv,
       ROUND(AVG(ts_total))::text AS avg_ccv,
       SUM(ts_total)::text AS viewer_minutes,
       (ARRAY_AGG(minute_bucket ORDER BY ts_total DESC, minute_bucket ASC))[1] AS peak_at
     FROM (
       SELECT minute_bucket, c.language AS group_key, SUM(r.ccv) AS ts_total
       ${fw.sql}
       GROUP BY minute_bucket, c.language
     ) per_ts
     GROUP BY group_key
     ORDER BY MAX(ts_total) DESC`,
    fw.bindings,
  ).then((r: { rows: LanguagePeakRow[] }) => r.rows);
}

export async function getTimeSeriesData(scope: Scope, intervalSeconds = 60, filter?: ViewFilter): Promise<TimeSeriesBucket[]> {
  // Re-bucket the per-minute rollup into interval buckets: MAX(ccv) per
  // (bucket, channel) reproduces the raw "MAX cycle across the bucket" since
  // a multi-minute MAX equals the MAX of the per-minute MAXes; then SUM
  // across channels per bucket.
  const fw = rollupFromWhere(scope, filter);
  return db.raw(
    `SELECT bucket,
       SUM(channel_ccv)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT ${rollupBucketExpr()} AS bucket, r.channel_id,
         MAX(r.ccv) AS channel_ccv
       ${fw.sql}
       GROUP BY bucket, r.channel_id
     ) per_channel
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { interval: intervalSeconds, ...fw.bindings },
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
  // platform / language / tier all live on channels → force join. Re-bucket
  // per-minute rollup into interval buckets (MAX per channel), group by the
  // channel dimension, then SUM per (bucket, dimension).
  const fw = rollupFromWhere(scope, filter, { forceJoin: true });
  return db.raw(
    `SELECT bucket, group_key,
       SUM(channel_ccv)::text AS total_ccv,
       COUNT(*)::text AS channel_count
     FROM (
       SELECT ${rollupBucketExpr()} AS bucket, r.channel_id,
         c."${groupBy}" AS group_key,
         MAX(r.ccv) AS channel_ccv
       ${fw.sql}
       GROUP BY bucket, r.channel_id, c."${groupBy}"
     ) per_channel
     GROUP BY bucket, group_key
     ORDER BY bucket ASC, total_ccv DESC`,
    { interval: intervalSeconds, ...fw.bindings },
  ).then((r: { rows: GroupedTimeSeriesBucket[] }) => r.rows);
}
