/**
 * Clutch Viewership Tracker — Main Application Entry Point
 *
 * Orchestrates all subsystems:
 *   1. Load environment config
 *   2. Initialize database connection and run migrations
 *   3. Initialize AdapterRegistry (Twitch, YouTube, Kick, TikTok)
 *   4. Initialize PollingOrchestrator with AdapterRegistry and DB
 *   5. Initialize DiscoveryService
 *   6. Initialize ReportAgent
 *   7. Start Express API server
 *   8. Start WebSocket server
 *   9. Register auto-trigger hooks (broadcast day → daily recap, etc.)
 *  10. Graceful shutdown handler (SIGINT, SIGTERM)
 */

import cron, { type ScheduledTask } from 'node-cron';
import { config } from './utils/config';
import logger from './utils/logger';
import db from './utils/db';
import { createApp, setOrchestrator, setDiscoveryService, setBroadcastDayDiscoveryService, setReportAgent, setRelayBroadcast, setGameTrackerService } from './api';
import { AdapterRegistry } from './adapters';
import { PollingOrchestrator, type PollCycleResult } from './services/polling-orchestrator';
import { DiscoveryService } from './services/discovery-service';
import { GameTrackerService } from './services/game-tracker-service';
import { ReportAgent } from './agent/report-agent';
import { ViewershipWebSocketServer } from './api/websocket';
import { getPushNotifier } from './services/push-notifier';
import { scoreSessions, sessionIdsEndedWithin } from './services/stream-health';
import { rollupRecentDays, rollupToday } from './services/gt-day-rollup';
import { rollupRecentBuckets } from './services/gt-bucket-rollup';
import { repairUnfinalizedSessions } from './models/stream-session';
import { purgeExpiredRawSnapshots } from './services/raw-retention';

// ── Bootstrap ──────────────────────────────────────────────────────────────

let isShuttingDown = false;

async function bootstrap(): Promise<void> {
  // ── 1. Load environment config ─────────────────────────────────────────
  logger.info('[CVT] Loading configuration', {
    port: config.server.port,
    wsPort: config.server.wsPort,
    database: config.database.url.replace(/\/\/.*@/, '//***@'), // mask credentials
    pollingInterval: `${config.polling.intervalMs}ms`,
    discoveryInterval: `${config.polling.discoveryIntervalMs}ms`,
  });

  // ── 2. Initialize database connection and run migrations ───────────────
  logger.info('[CVT] Connecting to database and running migrations...');
  try {
    // Verify the connection is live
    await db.raw('SELECT 1');
    logger.info('[CVT] Database connection established');

    // Run any pending migrations
    const [batchNo, migrationLog] = await db.migrate.latest({
      directory: './migrations',
      extension: 'ts',
    });

    if ((migrationLog as string[]).length > 0) {
      logger.info('[CVT] Migrations applied', {
        batch: batchNo,
        migrations: migrationLog,
      });
    } else {
      logger.info('[CVT] Database schema up to date (no pending migrations)');
    }

    // Migrate legacy env YOUTUBE_API_KEY into the discovery key pool so
    // existing setups keep discovering without manual setup. No-op if any
    // key already exists in the table.
    try {
      const ytKeyModel = await import('./models/youtube-api-key');
      await ytKeyModel.bootstrapLegacyKey(process.env.YOUTUBE_API_KEY);
    } catch (err) {
      logger.warn('[CVT] YouTube key bootstrap skipped', {
        error: (err as Error).message,
      });
    }
  } catch (err) {
    logger.error('[CVT] Database initialization failed', {
      error: (err as Error).message,
    });
    throw err;
  }

  // ── 3. Initialize AdapterRegistry ──────────────────────────────────────
  logger.info('[CVT] Initializing platform adapter registry...');
  const registry = new AdapterRegistry();

  // ── 4. Initialize PollingOrchestrator ──────────────────────────────────
  logger.info('[CVT] Initializing polling orchestrator', {
    intervalMs: config.polling.intervalMs,
  });
  const orchestrator = new PollingOrchestrator(registry, db);

  // ── 5. Initialize DiscoveryService ─────────────────────────────────────
  logger.info('[CVT] Initializing discovery service', {
    intervalMs: config.polling.discoveryIntervalMs,
  });
  const discoveryService = new DiscoveryService(registry, db);

  // ── 5b. Initialize GameTrackerService ──────────────────────────────────
  logger.info('[CVT] Initializing game-tracker service...');
  const gameTrackerService = new GameTrackerService(registry, db);

  // ── 6. Initialize ReportAgent ──────────────────────────────────────────
  logger.info('[CVT] Initializing report agent...');
  const reportAgent = new ReportAgent();

  // ── 6b. Initialize PushNotifier (Web Push) ─────────────────────────────
  // Loads (or generates on first run) the server's VAPID keypair and
  // configures web-push. Safe to fail — push is non-critical. If init
  // fails, notify() calls become no-ops and the rest of the system runs.
  const pushNotifier = getPushNotifier();
  try {
    await pushNotifier.init();
  } catch (err) {
    logger.error('[CVT] PushNotifier init failed — push notifications disabled', {
      error: (err as Error).message,
    });
  }

  // ── 7. Wire subsystems together ────────────────────────────────────────

  // Discovery lifecycle managed by the orchestrator (start/stop discovery
  // when broadcast days go live/completed)
  orchestrator.setDiscoveryService(discoveryService);

  // Report agent hooked into the orchestrator for auto-triggered reports
  // on broadcast day completion, stage completion, and series completion
  orchestrator.setReportAgent(reportAgent);

  // WebSocket server — created but not yet started
  const wsServer = new ViewershipWebSocketServer();

  // Wire WebSocket broadcast callbacks into orchestrator and discovery
  orchestrator.setSnapshotBroadcast((pollResult, seriesIds) => {
    wsServer.broadcastSnapshotUpdate(pollResult, seriesIds);
  });
  orchestrator.setStatusBroadcast((seriesId, broadcastDayId, previousStatus, newStatus) => {
    wsServer.broadcastStatusUpdate(seriesId, broadcastDayId, previousStatus, newStatus);

    // Push fan-out: broadcast went live → notify operators
    if (newStatus === 'live' && previousStatus !== 'live') {
      void db('broadcast_days')
        .where({ id: broadcastDayId })
        .first()
        .then((bd: { label?: string } | undefined) => {
          if (!bd) return;
          return pushNotifier.notify('broadcast_started', {
            title: 'Broadcast started',
            body: `${bd.label || 'A broadcast'} is now live.`,
            url: `/${seriesId}`,
            tag: `broadcast-started-${broadcastDayId}`,
          });
        })
        .catch((err: Error) => logger.warn('[Push] broadcast_started fan-out failed', { error: err.message }));
    }
  });
  // Resume any discovery the operator left running before the restart —
  // discovery START stays user-initiated; this only restores that choice.
  discoveryService.resumeFlagged()
    .then((n) => { if (n > 0) logger.info(`[CVT] Resumed discovery for ${n} series after restart`); })
    .catch((err: Error) => logger.warn('[CVT] discovery resume failed', { error: err.message }));

  discoveryService.setDiscoveryBroadcast((result) => {
    wsServer.broadcastDiscoveryUpdate(result);

    // Push fan-out: new auto-discovery candidate(s) → notify operators
    if (result.added && result.added > 0) {
      void pushNotifier
        .notify('discovery_candidate', {
          title: 'New discovery candidate',
          body: `${result.added} new channel${result.added === 1 ? '' : 's'} pending approval.`,
          url: '/',
          tag: 'discovery_candidate',
        })
        .catch((err: Error) => logger.warn('[Push] discovery_candidate fan-out failed', { error: err.message }));
    }
  });

  // Push fan-out: polling stalled (5+ consecutive zero-result cycles)
  // and broadcast about to end (within 9-11 minutes of broadcast_end).
  orchestrator.setPushNotifier(pushNotifier);

  // Wire orchestrator, discovery, and report agent into the API routes
  // (module-level singleton injection pattern)
  setOrchestrator(orchestrator);
  setDiscoveryService(discoveryService);
  setBroadcastDayDiscoveryService(discoveryService);
  setReportAgent(reportAgent);
  setGameTrackerService(gameTrackerService);

  // Wire TikTok relay → WebSocket broadcast (so dashboard shows TikTok data immediately)
  setRelayBroadcast((seriesIds) => {
    for (const seriesId of seriesIds) {
      wsServer.broadcastSnapshotUpdate({ timestamp: new Date() } as PollCycleResult, [seriesId])
        .catch((err: Error) => logger.debug('[Relay] TikTok WS broadcast failed', { error: err.message }));
    }
  });

  // ── 8. Start Express API server ────────────────────────────────────────
  const app = createApp();

  await new Promise<void>((resolve) => {
    app.listen(config.server.port, () => {
      resolve();
    });
  });

  // ── 9. Start WebSocket server ──────────────────────────────────────────
  wsServer.start();

  // ── 10. Always start the polling orchestrator ──────────────────────────
  // The orchestrator handles scheduled→live transitions for series with
  // auto_start_polling enabled. Idle cycles are very cheap (one DB query),
  // so it's safe to always run. Manual Start/Stop buttons still work as
  // an emergency override from the dashboard.
  orchestrator.start();
  logger.info('[CVT] Polling orchestrator started (auto-start mode)');

  // ── 10b. Start game-tracker service ────────────────────────────────────
  await gameTrackerService.start();
  logger.info('[CVT] Game tracker service started');

  // ── 10c. Stream health scorer (cron) ───────────────────────────────────
  // Hourly at :10 scores sessions ended in the last 3 hours; the daily
  // 04:15 UTC pass re-scores the last 7 days (idempotent) so late chat /
  // follower data and shifting cohort baselines settle. HEALTH_SCORER=0
  // is the kill switch.
  const healthScorerTasks: ScheduledTask[] = [];
  if (process.env.HEALTH_SCORER === '0') {
    logger.info('[StreamHealth] scorer disabled via HEALTH_SCORER=0');
  } else {
    healthScorerTasks.push(
      cron.schedule('10 * * * *', async () => {
        try {
          const ids = await sessionIdsEndedWithin(3);
          if (ids.length === 0) return;
          await scoreSessions(ids);
        } catch (err) {
          logger.error('[StreamHealth] hourly scoring pass failed', {
            error: (err as Error).message,
          });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'stream-health-hourly' }),
    );
    healthScorerTasks.push(
      cron.schedule('15 4 * * *', async () => {
        try {
          const ids = await sessionIdsEndedWithin(7 * 24);
          if (ids.length === 0) return;
          await scoreSessions(ids);
        } catch (err) {
          logger.error('[StreamHealth] daily scoring pass failed', {
            error: (err as Error).message,
          });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'stream-health-daily' }),
    );
    logger.info('[CVT] Stream health scorer scheduled (hourly :10, daily 04:15 UTC)');
  }

  // ── 10d. Game-tracker daily rollup (cron) ──────────────────────────────
  // Nightly at 04:20 UTC upserts yesterday's (and, idempotently, the day
  // before's) per-tracker per-channel day stats into
  // game_tracker_channel_day_stats — before the 04:40 raw purge, so a day
  // is always summarized before its raw rows can age out. GT_ROLLUP=0 is
  // the kill switch.
  const maintenanceTasks: ScheduledTask[] = [];
  if (process.env.GT_ROLLUP === '0') {
    logger.info('[GTRollup] daily rollup disabled via GT_ROLLUP=0');
  } else {
    maintenanceTasks.push(
      cron.schedule('20 4 * * *', async () => {
        try {
          const results = await rollupRecentDays(2);
          logger.info('[GTRollup] nightly rollup complete', {
            days: results.map((r) => `${r.day}=${r.rows}`),
          });
        } catch (err) {
          logger.error('[GTRollup] nightly rollup failed', {
            error: (err as Error).message,
          });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'gt-day-rollup' }),
    );
    logger.info('[CVT] Game-tracker daily rollup scheduled (daily 04:20 UTC)');

    // Yesterday is also rolled right after midnight so the day-stats fast
    // paths (range leaderboard, breakdown, trends) cover it from 00:10 UTC
    // instead of 04:20; the 04:20 pass re-rolls it idempotently.
    maintenanceTasks.push(
      cron.schedule('10 0 * * *', async () => {
        try {
          await rollupRecentDays(1);
        } catch (err) {
          logger.error('[GTRollup] post-midnight rollup failed', { error: (err as Error).message });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'gt-day-rollup-early' }),
    );

    // Today's partial day, every 5 minutes, so week/month leaderboards read
    // it from day stats instead of scanning today's raw rows per request.
    maintenanceTasks.push(
      cron.schedule('*/5 * * * *', async () => {
        try {
          await rollupToday();
        } catch (err) {
          logger.error('[GTRollup] intraday rollup failed', { error: (err as Error).message });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'gt-day-rollup-today' }),
    );
    setTimeout(() => {
      rollupToday().catch((err) =>
        logger.error('[GTRollup] boot intraday rollup failed', { error: (err as Error).message }),
      );
    }, 30_000);

    // 10-minute bucket rollup for the Trends timeline — every 2 minutes,
    // re-rolling the last half hour (src/services/gt-bucket-rollup.ts).
    maintenanceTasks.push(
      cron.schedule('*/2 * * * *', async () => {
        try {
          await rollupRecentBuckets();
        } catch (err) {
          logger.error('[GTBuckets] rollup failed', { error: (err as Error).message });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'gt-bucket-rollup' }),
    );
    setTimeout(() => {
      rollupRecentBuckets().catch((err) =>
        logger.error('[GTBuckets] boot rollup failed', { error: (err as Error).message }),
      );
    }, 15_000);
    logger.info('[CVT] Game-tracker bucket rollup scheduled (every 2 min)');
  }

  // ── 10d-2. Stream session repair sweep ─────────────────────────────────
  // Sessions that ended without finals (the pre-transaction close path
  // could lose them) are recomputed from raw: once on boot, then daily.
  const runSessionRepair = async (label: string) => {
    try {
      const r = await repairUnfinalizedSessions();
      if (r.candidates > 0) {
        logger.info(`[SessionRepair] ${label}: ${r.repaired}/${r.candidates} session(s) repaired`);
      }
    } catch (err) {
      logger.error(`[SessionRepair] ${label} failed`, { error: (err as Error).message });
    }
  };
  setTimeout(() => void runSessionRepair('boot'), 60_000);
  maintenanceTasks.push(
    cron.schedule('30 4 * * *', () => runSessionRepair('daily'),
      { timezone: 'Etc/UTC', noOverlap: true, name: 'session-repair' }),
  );

  // ── 10e. Raw-snapshot retention purge (cron) ───────────────────────────
  // Nightly at 04:40 UTC deletes game_tracker_snapshots older than each
  // tracker's retain_raw_days (NULL = keep forever), in 50k-row ctid
  // batches. Permanent summaries (stream_sessions, chat_minute_rollup,
  // channel_follower_snapshots, game_tracker_channel_day_stats) are never
  // purged. RAW_RETENTION=0 is the kill switch.
  if (process.env.RAW_RETENTION === '0') {
    logger.info('[RawRetention] purge disabled via RAW_RETENTION=0');
  } else {
    maintenanceTasks.push(
      cron.schedule('40 4 * * *', async () => {
        try {
          const results = await purgeExpiredRawSnapshots();
          logger.info('[RawRetention] nightly purge complete', {
            trackers: results.map((r) => `${r.slug}=${r.purged}`),
            totalPurged: results.reduce((sum, r) => sum + r.purged, 0),
          });
        } catch (err) {
          logger.error('[RawRetention] nightly purge failed', {
            error: (err as Error).message,
          });
        }
      }, { timezone: 'Etc/UTC', noOverlap: true, name: 'raw-retention' }),
    );
    logger.info('[CVT] Raw-snapshot retention purge scheduled (daily 04:40 UTC)');
  }

  // ── 11. Startup complete ───────────────────────────────────────────────
  logger.info(
    `[CVT] Clutch Viewership Tracker started — API on port ${config.server.port}, WebSocket on port ${config.server.wsPort}`,
  );

  // ── 11. Graceful shutdown handler ──────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Force exit after 15 seconds if graceful shutdown hangs
    const forceExitTimer = setTimeout(() => {
      logger.error('[CVT] Graceful shutdown timed out after 15s — forcing exit');
      process.exit(1);
    }, 15_000);
    forceExitTimer.unref(); // Don't keep process alive just for this timer

    logger.info(`[CVT] ${signal} received — initiating graceful shutdown...`);

    // Stop accepting new WebSocket connections and close existing ones
    logger.info('[CVT] Stopping WebSocket server...');
    wsServer.stop();

    // Stop the polling orchestrator (clears poll interval, stops all discovery)
    logger.info('[CVT] Stopping polling orchestrator...');
    orchestrator.stop();

    // Stop the cron tasks — health scorer, rollup, retention (no-op when disabled)
    for (const task of [...healthScorerTasks, ...maintenanceTasks]) {
      try {
        await task.destroy();
      } catch {
        // best-effort — shutdown proceeds regardless
      }
    }

    // Shutdown platform adapters (e.g. TikTok headless browser pool)
    logger.info('[CVT] Shutting down platform adapters...');
    await registry.shutdown();

    // Close database connection pool
    logger.info('[CVT] Closing database connection...');
    await db.destroy();

    logger.info('[CVT] Shutdown complete. Goodbye!');
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

  // Handle uncaught exceptions and rejections
  process.on('uncaughtException', (err) => {
    logger.error('[CVT] Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException').catch(() => process.exit(1));
  });

  let unhandledRejectionCount = 0;
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    unhandledRejectionCount++;
    logger.error('[CVT] Unhandled rejection', { reason: message, stack, count: unhandledRejectionCount });
    // Shutdown after 5 unhandled rejections — indicates a systemic problem
    if (unhandledRejectionCount >= 5) {
      logger.error('[CVT] Too many unhandled rejections — shutting down');
      shutdown('unhandledRejection').catch(() => process.exit(1));
    }
  });

  // Export for testing / external consumers
  return;
}

// ── Run ──────────────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  logger.error('[CVT] Fatal error during startup', {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
