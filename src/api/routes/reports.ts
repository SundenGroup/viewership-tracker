/**
 * Report API Routes
 *
 * POST /api/reports/generate — Trigger report generation
 * GET  /api/reports           — List previously generated reports
 * GET  /api/reports/:filename — Download a generated report
 */

import { Router, Request, Response, NextFunction } from 'express';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { ReportAgent, type ReportScope, type ReportTemplate, type DeliveryMethod } from '../../agent/report-agent';

const router = Router();

const REPORTS_BASE_DIR = path.resolve(process.cwd(), 'reports');

// ── Module-level singleton ─────────────────────────────────────────────

let reportAgent: ReportAgent | null = null;

export function setReportAgent(agent: ReportAgent): void {
  reportAgent = agent;
}

// ── POST /api/reports/generate ─────────────────────────────────────────

router.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!reportAgent) {
      res.status(503).json({ error: 'Report agent not initialized' });
      return;
    }

    const { scope, id, ids, template, format, deliveryMethod, skipNarratives, detail, viewGroup, excludeTiers, excludeLanguages, excludeChannelIds, compare } = req.body;

    // Optional custom comparison: same scope level, real UUID. Multi-stage
    // reports have no single aligned baseline — reject rather than guess.
    if (compare != null) {
      const cOk =
        typeof compare === 'object' &&
        ['day', 'stage', 'series'].includes(compare.scope) &&
        typeof compare.id === 'string' &&
        /^[0-9a-f-]{36}$/i.test(compare.id);
      if (!cOk) {
        res.status(400).json({ error: "compare must be { scope: 'day'|'stage'|'series', id: uuid }" });
        return;
      }
      if (scope === 'multi_stage') {
        res.status(400).json({ error: 'compare is not supported for multi-stage reports' });
        return;
      }
      if (compare.scope !== scope) {
        res.status(400).json({ error: `compare scope must match the report scope (${scope} report → ${scope} baseline)` });
        return;
      }
      if (compare.id === id) {
        res.status(400).json({ error: 'compare target is the report itself' });
        return;
      }
    }

    // Validate scope
    if (!scope) {
      res.status(400).json({ error: 'scope is required (day|stage|multi_stage|series)' });
      return;
    }
    const validScopes: ReportScope[] = ['day', 'stage', 'multi_stage', 'series'];
    if (!validScopes.includes(scope)) {
      res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
      return;
    }

    // Validate id/ids
    if (scope !== 'multi_stage' && !id) {
      res.status(400).json({ error: 'id is required for this scope' });
      return;
    }
    if (scope === 'multi_stage' && (!ids || !Array.isArray(ids) || ids.length === 0)) {
      res.status(400).json({ error: 'ids array is required for scope=multi_stage' });
      return;
    }

    // Validate format
    const validFormats = ['pdf', 'docx', 'csv', 'xlsx', 'html'];
    if (format && !validFormats.includes(format)) {
      res.status(400).json({ error: `format must be one of: ${validFormats.join(', ')}` });
      return;
    }

    // Route to export or full report
    if (format === 'csv' || format === 'xlsx') {
      const result = await reportAgent.generateExport({
        scope,
        id: id as string,
        format,
      });
      res.json({
        status: 'ok',
        ...result,
      });
      return;
    }

    // Resolve view group to filter if provided
    let filter: { languages?: string[]; platforms?: string[]; excludeTiers?: string[]; excludeLanguages?: string[]; excludeChannelIds?: string[] } | undefined;
    let groupName: string | undefined;
    if (viewGroup && typeof viewGroup === 'object' && viewGroup.name) {
      groupName = viewGroup.name;
      filter = {};
      if (viewGroup.languages?.length) filter.languages = viewGroup.languages;
      if (viewGroup.platforms?.length) filter.platforms = viewGroup.platforms;
    }

    // Apply exclusions
    if (excludeTiers?.length || excludeLanguages?.length || excludeChannelIds?.length) {
      if (!filter) filter = {};
      if (excludeLanguages?.length) filter.excludeLanguages = excludeLanguages;
      if (excludeChannelIds?.length) filter.excludeChannelIds = excludeChannelIds;
      // Resolve tier exclusions to channel IDs
      if (excludeTiers?.length) {
        const db = (await import('../../utils/db')).default;
        const seriesId = scope === 'day'
          ? (await db('broadcast_days').where('id', id).first())?.series_id
          : id;
        if (seriesId) {
          const excluded = await db('channels')
            .where('series_id', seriesId)
            .whereIn('tier', excludeTiers)
            .select('id');
          const tierChannelIds = excluded.map((c: { id: string }) => c.id);
          filter.excludeChannelIds = [...(filter.excludeChannelIds ?? []), ...tierChannelIds];
        }
      }
    }

    // Full report generation
    const result = await reportAgent.generateReport({
      scope,
      id: id as string,
      ids: ids as string[] | undefined,
      template: (template ?? 'standard') as ReportTemplate,
      format: (format ?? 'pdf') as 'pdf' | 'docx' | 'html',
      deliveryMethod: (deliveryMethod ?? 'local') as DeliveryMethod,
      skipNarratives: skipNarratives ?? false,
      detail: (detail === 'detailed' ? 'detailed' : 'simple') as 'simple' | 'detailed',
      filter,
      groupName,
      compare: compare ?? undefined,
    });

    res.json({
      status: 'ok',
      ...result,
    });
  } catch (err) {
    if ((err as Error).name === 'ReportAgentError') {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    next(err);
  }
});

// ── GET /api/reports ───────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const reports: Array<{
      seriesFolder: string;
      filename: string;
      path: string;
      size: number;
      createdAt: string;
      scope: string;
      format: string;
    }> = [];

    // List all series folders
    let seriesFolders: string[] = [];
    try {
      seriesFolders = await readdir(REPORTS_BASE_DIR);
    } catch {
      // Reports directory doesn't exist yet — return empty list
      res.json({ reports: [] });
      return;
    }

    for (const folder of seriesFolders) {
      const folderPath = path.join(REPORTS_BASE_DIR, folder);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) continue;

      const files = await readdir(folderPath);
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat?.isFile()) continue;

        // Parse filename: {scope}_{date}.{format}
        const match = file.match(/^(\w+)_(\d{4}-\d{2}-\d{2})\.(\w+)$/);
        const scope = match?.[1] ?? 'unknown';
        const format = match?.[3] ?? path.extname(file).replace('.', '');

        reports.push({
          seriesFolder: folder,
          filename: file,
          path: `/api/reports/${folder}/${file}`,
          size: fileStat.size,
          createdAt: fileStat.birthtime.toISOString(),
          scope,
          format,
        });
      }
    }

    // Sort newest first
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reports/:folder/:filename ─────────────────────────────────

router.get('/:folder/:filename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const folder = req.params['folder'] as string | undefined;
    const filename = req.params['filename'] as string | undefined;

    // Sanitize inputs to prevent directory traversal
    if (!folder || !filename ||
        folder.includes('..') || filename.includes('..') ||
        folder.includes('/') || filename.includes('/')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const filePath = path.join(REPORTS_BASE_DIR, folder, filename);

    // Check file exists
    try {
      await stat(filePath);
    } catch {
      res.status(404).json({ error: 'Report not found' });
      return;
    }

    // Determine content type
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv',
      '.html': 'text/html',
    };

    const contentType = contentTypes[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // Serve HTML inline (opens in browser), others as attachment downloads
    if (ext === '.html') {
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

export default router;
