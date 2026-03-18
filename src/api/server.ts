import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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
import authRouter from './routes/auth';
import publicRouter from './routes/public';
import relayRouter from './routes/relay';
import { authenticate, requireRole } from './middleware/auth';

export function createApp() {
  const app = express();

  // ── Middleware ─────────────────────────────────────────────────────────

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

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

  // Auth routes (login/logout are public, /me and /users are protected internally)
  app.use('/api/auth', authRouter);

  // Public API routes — no authentication required
  app.use('/api/public', publicRouter);

  // Relay routes — external scrapers push data here (own token auth)
  app.use('/api/relay', relayRouter);

  // All other /api routes require authentication
  app.use('/api', authenticate);

  // Viewer+ routes (all authenticated users can access)
  app.use('/api/series', seriesRouter);
  app.use('/api/series', stagesRouter);
  app.use('/api', stagesRouter);
  app.use('/api/stages', broadcastDaysRouter);
  app.use('/api', broadcastDaysRouter);
  app.use('/api/series', channelsRouter);
  app.use('/api', channelsRouter);
  app.use('/api/viewership', viewershipRouter);
  app.use('/api/report-payload', reportPayloadRouter);

  // Editor+ routes
  app.use('/api/export', requireRole('admin', 'editor'), exportRouter);
  app.use('/api/reports', requireRole('admin', 'editor'), reportsRouter);

  // Admin-only routes
  app.use('/api/polling', requireRole('admin'), pollingRouter);

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
