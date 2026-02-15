import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────

function scopeColumn(scope: string): string | null {
  switch (scope) {
    case 'day': return 'broadcast_day_id';
    case 'stage': return 'stage_id';
    case 'series': return 'series_id';
    default: return null;
  }
}

async function fetchSnapshotsWithChannels(scope: string, id: string) {
  const col = scopeColumn(scope);
  if (!col) return null;

  return db('viewership_snapshots')
    .where(`viewership_snapshots.${col}`, id)
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
      'channels.channel_identifier',
      'channels.display_name',
      'channels.tier',
    )
    .orderBy('viewership_snapshots.timestamp', 'asc');
}

// ── CSV Export ───────────────────────────────────────────────────────────

// GET /api/export/csv?scope=day|stage|series&id=uuid
router.get('/csv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scope, id } = req.query;
    if (!scope || !id) {
      res.status(400).json({ error: 'scope (day|stage|series) and id are required' });
      return;
    }

    const rows = await fetchSnapshotsWithChannels(scope as string, id as string);
    if (rows === null) {
      res.status(400).json({ error: 'scope must be one of: day, stage, series' });
      return;
    }

    // Build CSV
    const headers = [
      'snapshot_id', 'timestamp', 'channel_identifier', 'display_name',
      'concurrent_viewers', 'platform', 'language', 'region', 'tier',
      'channel_id', 'broadcast_day_id', 'stage_id', 'series_id',
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
      ].join(','));
    }

    const csv = csvLines.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="viewership-${scope}-${id}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ── JSON Export ──────────────────────────────────────────────────────────

// GET /api/export/json?scope=day|stage|series&id=uuid
router.get('/json', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scope, id } = req.query;
    if (!scope || !id) {
      res.status(400).json({ error: 'scope (day|stage|series) and id are required' });
      return;
    }

    const rows = await fetchSnapshotsWithChannels(scope as string, id as string);
    if (rows === null) {
      res.status(400).json({ error: 'scope must be one of: day, stage, series' });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="viewership-${scope}-${id}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      scope,
      id,
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
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
