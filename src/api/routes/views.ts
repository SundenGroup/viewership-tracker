/**
 * Live views routes (plan: docs/plans/2026-09-16-views-roundup.md).
 *
 * GET  /api/days/:id/views           every stored row for a day plus the best row per channel
 * POST /api/days/:id/views/collect   run the collector for a completed day now (admin, editor)
 * POST /api/days/:id/views/import    numbers handed over by the channel owner (admin, editor)
 * GET  /api/views/status             per-day completeness for a scope (the export dialog's warning)
 */
import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';
import { requireRole } from '../middleware/auth';
import type { ViewsCollector, ManualViewsEntry, CollectorPass } from '../../services/views-collector';
import { loadViewsSummary, type ViewsTarget } from '../../services/views-read';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let collector: ViewsCollector | null = null;
export function setViewsCollector(c: ViewsCollector): void {
  collector = c;
}

function parseTarget(query: Record<string, unknown>): ViewsTarget | null {
  const scope = String(query.scope ?? '');
  if (scope === 'multi_stage') {
    const ids = String(query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return ids.length > 0 && ids.every((s) => UUID_RE.test(s)) ? { kind: 'multi_stage', ids } : null;
  }
  const id = String(query.id ?? '');
  if (!['day', 'stage', 'series'].includes(scope) || !UUID_RE.test(id)) return null;
  return { kind: 'single', scope: scope as 'day' | 'stage' | 'series', id };
}

router.get('/days/:id/views', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dayId = String(req.params.id);
    if (!UUID_RE.test(dayId)) {
      res.status(400).json({ error: 'invalid broadcast day id' });
      return;
    }
    const [summary, rows, runs] = await Promise.all([
      loadViewsSummary(db, { kind: 'single', scope: 'day', id: dayId }),
      db('stream_views as sv')
        .join('channels as c', 'c.id', 'sv.channel_id')
        .where('sv.broadcast_day_id', dayId)
        .select('sv.*', 'c.display_name', 'c.channel_identifier', 'c.tier')
        .orderBy(['c.platform', 'c.display_name', 'sv.source', 'sv.snapshot']),
      db('stream_views_runs').where('broadcast_day_id', dayId).select('snapshot', 'ran_at', 'summary'),
    ]);
    res.json({ summary, rows, runs });
  } catch (err) {
    next(err);
  }
});

router.post('/days/:id/views/collect', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!collector) {
      res.status(503).json({ error: 'views collector not initialized' });
      return;
    }
    const dayId = String(req.params.id);
    if (!UUID_RE.test(dayId)) {
      res.status(400).json({ error: 'invalid broadcast day id' });
      return;
    }
    const pass = req.body?.pass as CollectorPass | undefined;
    if (pass && !['plus_3h', 'plus_36h', 'plus_7d'].includes(pass)) {
      res.status(400).json({ error: 'pass must be plus_3h, plus_36h or plus_7d' });
      return;
    }
    const summary = await collector.collectDay(dayId, pass);
    res.json({ status: 'ok', summary });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('completed broadcast days only')) {
      res.status(400).json({ error: msg });
      return;
    }
    next(err);
  }
});

router.post('/days/:id/views/import', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!collector) {
      res.status(503).json({ error: 'views collector not initialized' });
      return;
    }
    const dayId = String(req.params.id);
    const entries = req.body?.entries as ManualViewsEntry[] | undefined;
    if (!UUID_RE.test(dayId) || !Array.isArray(entries) || entries.length === 0 || entries.length > 200) {
      res.status(400).json({ error: 'entries must be a list of 1 to 200 rows' });
      return;
    }
    for (const e of entries) {
      const ok =
        e && UUID_RE.test(String(e.channelId)) &&
        ['tiktok_livecenter', 'twitch_stream_summary', 'csv_import'].includes(e.source) &&
        Number.isFinite(Number(e.views)) && Number(e.views) >= 0;
      if (!ok) {
        res.status(400).json({ error: 'each entry needs channelId, source (tiktok_livecenter | twitch_stream_summary | csv_import) and views' });
        return;
      }
    }
    const imported = await collector.importManual(
      dayId,
      entries.map((e) => ({ ...e, views: Number(e.views) })),
    );
    res.json({ status: 'ok', imported });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not part of this series') || msg.includes('not found') || msg.includes('views must be')) {
      res.status(400).json({ error: msg });
      return;
    }
    next(err);
  }
});

router.get('/views/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTarget(req.query as Record<string, unknown>);
    if (!target) {
      res.status(400).json({ error: 'scope (day|stage|series|multi_stage) and id or ids are required' });
      return;
    }
    const summary = await loadViewsSummary(db, target);
    const completed = summary.days.filter((d) => d.status === 'completed');
    // One short line each: the dialog shows them next to the checkbox.
    const warnings: string[] = [];
    const notCollected = completed.filter((d) => !d.collected);
    const pendingTwitch = completed.filter((d) => d.collected && !d.complete);
    const names = (ds: typeof completed) => (ds.length <= 3 ? ds.map((d) => d.label).join(', ') : `${ds.length} days`);
    if (notCollected.length > 0) warnings.push(`Not collected yet: ${names(notCollected)}`);
    if (pendingTwitch.length > 0) warnings.push(`Twitch views arrive about 36 hours after a stream. Pending: ${names(pendingTwitch)}`);
    const t = summary.totals;
    if (t.liveViews > 0 && t.estimated / t.liveViews > 0.25) {
      warnings.push(`${Math.round((t.estimated / t.liveViews) * 100)}% of these views are estimated`);
    }
    if (summary.lateReads > 0) warnings.push('Collected late, so replay views are included');
    res.json({ days: summary.days, totals: summary.totals, ready: warnings.length === 0, warnings });
  } catch (err) {
    next(err);
  }
});

export default router;
