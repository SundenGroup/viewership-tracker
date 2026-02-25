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

    const { scope, id, ids, template, format, deliveryMethod, skipNarratives } = req.body;

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

    // Full report generation
    const result = await reportAgent.generateReport({
      scope,
      id: id as string,
      ids: ids as string[] | undefined,
      template: (template ?? 'standard') as ReportTemplate,
      format: (format ?? 'pdf') as 'pdf' | 'docx' | 'html',
      deliveryMethod: (deliveryMethod ?? 'local') as DeliveryMethod,
      skipNarratives: skipNarratives ?? false,
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
