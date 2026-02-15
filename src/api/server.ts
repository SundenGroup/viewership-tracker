import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import logger from '../utils/logger';

import seriesRouter from './routes/series';
import stagesRouter from './routes/stages';
import broadcastDaysRouter from './routes/broadcast-days';
import channelsRouter from './routes/channels';
import viewershipRouter from './routes/viewership';
import exportRouter from './routes/export';
import reportPayloadRouter from './routes/report-payload';
import pollingRouter from './routes/polling';
import reportsRouter from './routes/reports';

export function createApp() {
  const app = express();

  // ── Middleware ─────────────────────────────────────────────────────────

  app.use(cors());
  app.use(express.json());

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, {
      query: req.query,
    });
    next();
  });

  // ── Routes ────────────────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/series', seriesRouter);
  app.use('/api/series', stagesRouter);
  app.use('/api', stagesRouter);
  app.use('/api/stages', broadcastDaysRouter);
  app.use('/api', broadcastDaysRouter);
  app.use('/api/series', channelsRouter);
  app.use('/api', channelsRouter);
  app.use('/api/viewership', viewershipRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/report-payload', reportPayloadRouter);
  app.use('/api/polling', pollingRouter);
  app.use('/api/reports', reportsRouter);

  // ── 404 handler ───────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Error handler ─────────────────────────────────────────────────────

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  });

  return app;
}
