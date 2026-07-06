import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Granularity ─────────────────────────────────────────────────────────
//
// The default export is PER-MINUTE (one row per channel per minute, the
// deduped viewership_minute_rollup the dashboard itself reads). It is
// correct-by-construction: any downstream SUM is right, and the file
// always matches the site. The raw-poll export (~2 rows/channel/minute)
// is a forensic/QA format — summing it naively double-counts — so it and
// the aggregate summaries are ADMIN-ONLY. Everyone with export access
// gets the safe per-minute grain by default.
type Granularity = 'per_minute' | 'minute_totals' | 'channel_summary' | 'raw';
const ALL_GRANULARITIES: Granularity[] = ['per_minute', 'minute_totals', 'channel_summary', 'raw'];
const ADMIN_ONLY: Set<Granularity> = new Set(['minute_totals', 'channel_summary', 'raw']);

// ── Scope target ────────────────────────────────────────────────────────

function scopeColumn(scope: string): string | null {
  switch (scope) {
    case 'day': return 'broadcast_day_id';
    case 'stage': return 'stage_id';
    case 'series': return 'series_id';
    default: return null;
  }
}

type ExportTarget =
  | { kind: 'single'; scope: 'day' | 'stage' | 'series'; id: string }
  | { kind: 'multi_stage'; ids: string[] };

function parseTarget(query: Record<string, unknown>): ExportTarget | { error: string } {
  const scope = query.scope as string | undefined;
  if (!scope) return { error: 'scope is required (day|stage|series|multi_stage)' };

  if (scope === 'multi_stage') {
    const idsRaw = (query.ids as string | undefined) ?? '';
    const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return { error: 'ids is required for scope=multi_stage (comma-separated UUIDs)' };
    if (!ids.every((s) => UUID_RE.test(s))) return { error: 'ids must be valid UUIDs' };
    return { kind: 'multi_stage', ids };
  }

  if (!['day', 'stage', 'series'].includes(scope)) {
    return { error: 'scope must be one of: day, stage, series, multi_stage' };
  }
  const id = query.id as string | undefined;
  if (!id) return { error: 'id is required for this scope' };
  return { kind: 'single', scope: scope as 'day' | 'stage' | 'series', id };
}

/** Apply the scope filter to a query on a table that carries the scope
 *  id columns (both viewership_snapshots and viewership_minute_rollup do). */
function applyScope<T extends import('knex').Knex.QueryBuilder>(q: T, target: ExportTarget, alias: string): T {
  if (target.kind === 'multi_stage') return q.whereIn(`${alias}.stage_id`, target.ids) as T;
  return q.where(`${alias}.${scopeColumn(target.scope)!}`, target.id) as T;
}

// ── Datasets (one per granularity) ──────────────────────────────────────

interface Dataset {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

async function buildDataset(target: ExportTarget, gran: Granularity): Promise<Dataset> {
  if (gran === 'per_minute') {
    const q = applyScope(
      db('viewership_minute_rollup as r').join('channels as c', 'c.id', 'r.channel_id'),
      target,
      'r',
    )
      .select(
        'r.minute_bucket',
        'r.ccv',
        'c.channel_identifier',
        'c.display_name',
        'c.platform',
        'c.language',
        'c.region',
        'c.tier',
        'r.channel_id',
        'r.broadcast_day_id',
      )
      .orderBy('r.minute_bucket', 'asc')
      .orderBy('c.channel_identifier', 'asc');
    const rows = await q;
    return {
      columns: ['minute', 'channel_identifier', 'display_name', 'concurrent_viewers',
        'platform', 'language', 'region', 'tier', 'channel_id', 'broadcast_day_id'],
      rows: rows.map((r) => ({
        minute: new Date(r.minute_bucket).toISOString(),
        channel_identifier: r.channel_identifier,
        display_name: r.display_name,
        concurrent_viewers: r.ccv,
        platform: r.platform,
        language: r.language ?? '',
        region: r.region ?? '',
        tier: r.tier ?? '',
        channel_id: r.channel_id,
        broadcast_day_id: r.broadcast_day_id ?? '',
      })),
    };
  }

  if (gran === 'minute_totals') {
    const q = applyScope(db('viewership_minute_rollup as r'), target, 'r')
      .select('r.minute_bucket')
      .sum('r.ccv as total')
      .countDistinct('r.channel_id as live_channels')
      .groupBy('r.minute_bucket')
      .orderBy('r.minute_bucket', 'asc');
    const rows = await q;
    return {
      columns: ['minute', 'total_concurrent_viewers', 'live_channels'],
      rows: rows.map((r) => ({
        minute: new Date(r.minute_bucket).toISOString(),
        total_concurrent_viewers: Number(r.total),
        live_channels: Number(r.live_channels),
      })),
    };
  }

  if (gran === 'channel_summary') {
    const q = applyScope(
      db('viewership_minute_rollup as r').join('channels as c', 'c.id', 'r.channel_id'),
      target,
      'r',
    )
      .select(
        'r.channel_id',
        'c.channel_identifier',
        'c.display_name',
        'c.platform',
        'c.language',
        'c.region',
        'c.tier',
      )
      .max('r.ccv as peak_ccv')
      .select(db.raw('(ARRAY_AGG(r.minute_bucket ORDER BY r.ccv DESC, r.minute_bucket ASC))[1] AS peak_at'))
      .select(db.raw('ROUND(AVG(r.ccv)) AS avg_ccv'))
      .sum('r.ccv as viewer_minutes')
      .groupBy('r.channel_id', 'c.channel_identifier', 'c.display_name', 'c.platform', 'c.language', 'c.region', 'c.tier')
      .orderByRaw('SUM(r.ccv) DESC');
    const rows = await q;
    return {
      columns: ['channel_identifier', 'display_name', 'platform', 'language', 'region', 'tier',
        'peak_ccv', 'peak_at', 'avg_ccv', 'viewed_hours', 'channel_id'],
      rows: rows.map((r) => ({
        channel_identifier: r.channel_identifier,
        display_name: r.display_name,
        platform: r.platform,
        language: r.language ?? '',
        region: r.region ?? '',
        tier: r.tier ?? '',
        peak_ccv: Number(r.peak_ccv),
        peak_at: r.peak_at ? new Date(r.peak_at).toISOString() : '',
        avg_ccv: Number(r.avg_ccv),
        viewed_hours: Math.round(Number(r.viewer_minutes) / 60),
        channel_id: r.channel_id,
      })),
    };
  }

  // raw — every poll row, sub-minute cadence (forensic/QA grain).
  const q = applyScope(
    db('viewership_snapshots as v').join('channels as c', 'c.id', 'v.channel_id'),
    target,
    'v',
  )
    .select(
      'v.id',
      'v.timestamp',
      'v.concurrent_viewers',
      'v.platform',
      'v.language',
      'v.region',
      'v.channel_id',
      'v.broadcast_day_id',
      'v.stage_id',
      'v.series_id',
      'v.stream_id',
      'v.stream_title',
      'c.channel_identifier',
      'c.display_name',
      'c.tier',
    )
    .orderBy('v.timestamp', 'asc');
  const rows = await q;
  return {
    columns: ['snapshot_id', 'timestamp', 'channel_identifier', 'display_name', 'concurrent_viewers',
      'platform', 'language', 'region', 'tier', 'channel_id', 'broadcast_day_id', 'stage_id',
      'series_id', 'stream_id', 'stream_title'],
    rows: rows.map((r) => ({
      snapshot_id: r.id,
      timestamp: new Date(r.timestamp).toISOString(),
      channel_identifier: r.channel_identifier,
      display_name: r.display_name,
      concurrent_viewers: r.concurrent_viewers,
      platform: r.platform,
      language: r.language ?? '',
      region: r.region ?? '',
      tier: r.tier ?? '',
      channel_id: r.channel_id,
      broadcast_day_id: r.broadcast_day_id ?? '',
      stage_id: r.stage_id ?? '',
      series_id: r.series_id ?? '',
      stream_id: r.stream_id ?? '',
      stream_title: r.stream_title ?? '',
    })),
  };
}

// ── Serialization ───────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(ds: Dataset): string {
  const lines = [ds.columns.join(',')];
  for (const row of ds.rows) lines.push(ds.columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\n');
}

function resolveGranularity(
  query: Record<string, unknown>,
  role: string | undefined,
): Granularity | { error: string; status: number } {
  const raw = (query.granularity as string | undefined) ?? 'per_minute';
  if (!ALL_GRANULARITIES.includes(raw as Granularity)) {
    return { error: `granularity must be one of: ${ALL_GRANULARITIES.join(', ')}`, status: 400 };
  }
  const gran = raw as Granularity;
  if (ADMIN_ONLY.has(gran) && role !== 'admin') {
    return {
      error: `The "${gran}" export is admin-only. The per-minute export is available to all editors.`,
      status: 403,
    };
  }
  return gran;
}

function filenameBase(target: ExportTarget, gran: Granularity): string {
  const scopePart =
    target.kind === 'multi_stage' ? `multi_stage-${target.ids.length}stages` : `${target.scope}-${target.id}`;
  // per-minute stays unsuffixed (it's the canonical export); others name the grain.
  const grainPart = gran === 'per_minute' ? '' : `-${gran}`;
  return `viewership-${scopePart}${grainPart}`;
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/export/csv?scope=…&id=…&granularity=per_minute|minute_totals|channel_summary|raw
router.get('/csv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTarget(req.query as Record<string, unknown>);
    if ('error' in target) { res.status(400).json({ error: target.error }); return; }
    const gran = resolveGranularity(req.query as Record<string, unknown>, req.user?.role);
    if (typeof gran !== 'string') { res.status(gran.status).json({ error: gran.error }); return; }

    const ds = await buildDataset(target, gran);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase(target, gran)}.csv"`);
    res.send(toCsv(ds));
  } catch (err) {
    next(err);
  }
});

// GET /api/export/json?scope=…&id=…&granularity=…
router.get('/json', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTarget(req.query as Record<string, unknown>);
    if ('error' in target) { res.status(400).json({ error: target.error }); return; }
    const gran = resolveGranularity(req.query as Record<string, unknown>, req.user?.role);
    if (typeof gran !== 'string') { res.status(gran.status).json({ error: gran.error }); return; }

    const ds = await buildDataset(target, gran);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase(target, gran)}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      scope: target.kind === 'multi_stage' ? 'multi_stage' : target.scope,
      ...(target.kind === 'multi_stage' ? { ids: target.ids } : { id: target.id }),
      granularity: gran,
      rowCount: ds.rows.length,
      data: ds.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
