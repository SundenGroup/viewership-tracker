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

import { config } from './utils/config';
import logger from './utils/logger';
import db from './utils/db';
import { createApp, setOrchestrator, setDiscoveryService, setReportAgent } from './api';
import { AdapterRegistry } from './adapters';
import { PollingOrchestrator } from './services/polling-orchestrator';
import { DiscoveryService } from './services/discovery-service';
import { ReportAgent } from './agent/report-agent';
import { ViewershipWebSocketServer } from './api/websocket';

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

  // ── 6. Initialize ReportAgent ──────────────────────────────────────────
  logger.info('[CVT] Initializing report agent...');
  const reportAgent = new ReportAgent();

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
  });
  discoveryService.setDiscoveryBroadcast((result) => {
    wsServer.broadcastDiscoveryUpdate(result);
  });

  // Wire orchestrator, discovery, and report agent into the API routes
  // (module-level singleton injection pattern)
  setOrchestrator(orchestrator);
  setDiscoveryService(discoveryService);
  setReportAgent(reportAgent);

  // ── 8. Start Express API server ────────────────────────────────────────
  const app = createApp();

  await new Promise<void>((resolve) => {
    app.listen(config.server.port, () => {
      resolve();
    });
  });

  // ── 9. Start WebSocket server ──────────────────────────────────────────
  wsServer.start();

  // ── 10. Startup complete ───────────────────────────────────────────────
  logger.info(
    `[CVT] Clutch Viewership Tracker started — API on port ${config.server.port}, WebSocket on port ${config.server.wsPort}`,
  );

  // ── 11. Graceful shutdown handler ──────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`[CVT] ${signal} received — initiating graceful shutdown...`);

    // Stop accepting new WebSocket connections and close existing ones
    logger.info('[CVT] Stopping WebSocket server...');
    wsServer.stop();

    // Stop the polling orchestrator (clears poll interval, stops all discovery)
    logger.info('[CVT] Stopping polling orchestrator...');
    orchestrator.stop();

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

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('[CVT] Unhandled rejection', { reason: message });
    // Don't shutdown on unhandled rejections — log and continue
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
