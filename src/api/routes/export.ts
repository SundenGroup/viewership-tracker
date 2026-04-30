import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Helpers ─────────────────────────────────────────────────────────────

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

async function fetchSnapshotsWithChannels(target: ExportTarget) {
  const baseQuery = db('viewership_snapshots')
    .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
    .select(
      'viewership_snapshots.id',
      'viewership_snapshots.timestamp',
      'viewership_snapshots.concurrent_viewers',
      'viewership_snapshots.platform',
      'viewership_snapshots.language',
      'viewership_snapshots.region',
      'viewership_snapshots.channel_id',
      'viewership_snapshots.broadcast_day_id',
      'viewership_snapshots.stage_id',
      'viewership_snapshots.series_id',
      'viewership_snapshots.stream_id',
      'viewership_snapshots.stream_title',
      'channels.channel_identifier',
      'channels.display_name',
      'channels.tier',
    )
    .orderBy('viewership_snapshots.timestamp', 'asc');

  if (target.kind === 'multi_stage') {
    return baseQuery.whereIn('viewership_snapshots.stage_id', target.ids);
  }
  const col = scopeColumn(target.scope)!;
  return baseQuery.where(`viewership_snapshots.${col}`, target.id);
}

function downloadFilename(target: ExportTarget, ext: 'csv' | 'json'): string {
  if (target.kind === 'multi_stage') {
    return `viewership-multi_stage-${target.ids.length}stages.${ext}`;
  }
  return `viewership-${target.scope}-${target.id}.${ext}`;
}

// ── CSV Export ───────────────────────────────────────────────────────────

// GET /api/export/csv?scope=day|stage|series&id=uuid
// GET /api/export/csv?scope=multi_stage&ids=uuid1,uuid2,...
router.get('/csv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTarget(req.query as Record<string, unknown>);
    if ('error' in target) {
      res.status(400).json({ error: target.error });
      return;
    }

    const rows = await fetchSnapshotsWithChannels(target);

    // Build CSV
    const headers = [
      'snapshot_id', 'timestamp', 'channel_identifier', 'display_name',
      'concurrent_viewers', 'platform', 'language', 'region', 'tier',
      'channel_id', 'broadcast_day_id', 'stage_id', 'series_id',
      'stream_id', 'stream_title',
    ];

    const csvLines = [headers.join(',')];
    for (const row of rows) {
      csvLines.push([
        row.id,
        new Date(row.timestamp).toISOString(),
        `"${(row.channel_identifier ?? '').replace(/"/g, '""')}"`,
        `"${(row.display_name ?? '').replace(/"/g, '""')}"`,
        row.concurrent_viewers,
        row.platform,
        row.language ?? '',
        row.region ?? '',
        row.tier ?? '',
        row.channel_id,
        row.broadcast_day_id ?? '',
        row.stage_id ?? '',
        row.series_id ?? '',
        row.stream_id ?? '',
        `"${(row.stream_title ?? '').replace(/"/g, '""')}"`,
      ].join(','));
    }

    const csv = csvLines.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename(target, 'csv')}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ── JSON Export ──────────────────────────────────────────────────────────

// GET /api/export/json?scope=day|stage|series&id=uuid
// GET /api/export/json?scope=multi_stage&ids=uuid1,uuid2,...
router.get('/json', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTarget(req.query as Record<string, unknown>);
    if ('error' in target) {
      res.status(400).json({ error: target.error });
      return;
    }

    const rows = await fetchSnapshotsWithChannels(target);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename(target, 'json')}"`);
    res.json({
      exportedAt: new Date().toISOString(),
      scope: target.kind === 'multi_stage' ? 'multi_stage' : target.scope,
      ...(target.kind === 'multi_stage' ? { ids: target.ids } : { id: target.id }),
      snapshotCount: rows.length,
      snapshots: rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        channelIdentifier: row.channel_identifier,
        displayName: row.display_name,
        concurrentViewers: row.concurrent_viewers,
        platform: row.platform,
        language: row.language,
        region: row.region,
        tier: row.tier,
        channelId: row.channel_id,
        broadcastDayId: row.broadcast_day_id,
        stageId: row.stage_id,
        seriesId: row.series_id,
        streamId: row.stream_id ?? null,
        streamTitle: row.stream_title ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
