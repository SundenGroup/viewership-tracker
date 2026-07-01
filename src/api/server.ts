import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

import seriesRouter from './routes/series';
import stagesRouter from './routes/stages';
import broadcastDaysRouter from './routes/broadcast-days';
import channelsRouter from './routes/channels';
import viewershipRouter from './routes/viewership';
import viewershipImportRouter from './routes/viewership-import';
import exportRouter from './routes/export';
import reportPayloadRouter from './routes/report-payload';
import pollingRouter from './routes/polling';
import reportsRouter from './routes/reports';
import youtubeKeysRouter from './routes/youtube-keys';
import pushRouter, { pushPublicRouter } from './routes/push';
import authRouter from './routes/auth';
import publicRouter from './routes/public';
import relayRouter from './routes/relay';
import gameTrackersRouter from './routes/game-trackers';
import { authenticate, requireRole } from './middleware/auth';

export function createApp() {
  const app = express();

  // ── Security ──────────────────────────────────────────────────────────

  app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for inline Chart.js in reports

  const allowedOrigins = (process.env.CORS_ORIGINS || 'https://tracker.clutch.game,https://stats.clutch.game')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // In dev, also allow localhost
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push('http://localhost:5173', 'http://localhost:3000');
  }
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, relay scripts)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }));

  // ── Middleware ─────────────────────────────────────────────────────────

  // 5mb: the admin CSV import (/api/import/csv) ships a full day's official
  // platform export inline as JSON; a per-minute day file is ~50-100KB but
  // multi-hour YouTube exports can run larger.
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  // Rate limit login attempts
  app.use('/api/auth/login', rateLimit({
    windowMs: 60_000,
    max: 10,
    message: { error: 'Too many login attempts, try again in a minute' },
  }));

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

  // VAPID public key — public so clients can fetch it before subscribing
  app.use('/api/push', pushPublicRouter);

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
  app.use('/api/game-trackers', gameTrackersRouter);

  // Editor+ routes
  app.use('/api/export', requireRole('admin', 'editor'), exportRouter);
  app.use('/api/import', requireRole('admin', 'editor'), viewershipImportRouter);
  app.use('/api/reports', requireRole('admin', 'editor'), reportsRouter);
  app.use('/api/push', requireRole('admin', 'editor'), pushRouter);

  // Admin-only routes
  app.use('/api/polling', requireRole('admin'), pollingRouter);
  app.use('/api/youtube-keys', requireRole('admin'), youtubeKeysRouter);

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
