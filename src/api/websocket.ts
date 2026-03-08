import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import logger from '../utils/logger';
import { config } from '../utils/config';
import db from '../utils/db';
import * as UserModel from '../models/user';
import type { PollCycleResult } from '../services/polling-orchestrator';
import type { DiscoveryResult } from '../services/discovery-service';
import * as TournamentSeriesModel from '../models/tournament-series';
import * as ViewershipSnapshotModel from '../models/viewership-snapshot';
import type { BroadcastDay } from '../models/broadcast-day';

// ── Client message types ─────────────────────────────────────────────────

interface SubscribeMessage {
  type: 'subscribe';
  seriesId: string;
}

interface UnsubscribeMessage {
  type: 'unsubscribe';
  seriesId: string;
}

interface PingMessage {
  type: 'ping';
}

type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// ── Server message types ─────────────────────────────────────────────────

interface WelcomePayload {
  type: 'welcome';
  data: {
    activeSeries: Array<{
      id: string;
      name: string;
      status: string;
    }>;
    liveBroadcastDays: BroadcastDay[];
  };
}

interface SnapshotUpdatePayload {
  type: 'snapshot_update';
  data: {
    seriesId: string;
    pollResult: PollCycleResult;
    latestSnapshots: Array<ViewershipSnapshotModel.ViewershipSnapshot & { display_name: string }>;
  };
}

interface DiscoveryUpdatePayload {
  type: 'discovery_update';
  data: {
    seriesId: string;
    discoveryResult: DiscoveryResult;
  };
}

interface StatusUpdatePayload {
  type: 'status_update';
  data: {
    seriesId: string;
    broadcastDayId: string;
    previousStatus: string;
    newStatus: string;
  };
}

interface PongPayload {
  type: 'pong';
}

interface ErrorPayload {
  type: 'error';
  data: {
    message: string;
  };
}

type ServerMessage =
  | WelcomePayload
  | SnapshotUpdatePayload
  | DiscoveryUpdatePayload
  | StatusUpdatePayload
  | PongPayload
  | ErrorPayload;

// ── Client tracking ──────────────────────────────────────────────────────

interface TrackedClient {
  ws: WebSocket;
  subscriptions: Set<string>;   // seriesIds
  isAlive: boolean;
  connectedAt: Date;
  remoteAddress: string;
  userId: string;
  userRole: string;
  isPublic: boolean;            // anonymous public viewer
}

// ── Constants ────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;

// ── WebSocket Server ─────────────────────────────────────────────────────

export class ViewershipWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, TrackedClient>();
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    const port = config.server.wsPort;

    this.wss = new WebSocketServer({
      port,
      verifyClient: async (info, callback) => {
        try {
          const cookies = cookie.parse(info.req.headers.cookie ?? '');
          const token = cookies[config.auth.cookieName];

          if (token) {
            // Authenticated path
            const payload = jwt.verify(token, config.auth.jwtSecret) as { sub: string };
            const user = await UserModel.findById(payload.sub);
            if (!user || !user.is_active) {
              logger.warn('[WS] Connection rejected — invalid or inactive user');
              callback(false, 401, 'Unauthorized');
              return;
            }
            (info.req as IncomingMessage & { _wsUser?: { id: string; role: string } })._wsUser = {
              id: user.id,
              role: user.role,
            };
          } else {
            // Anonymous path — allow as public viewer
            (info.req as IncomingMessage & { _wsUser?: { id: string; role: string } })._wsUser = {
              id: 'anonymous',
              role: 'public',
            };
          }
          callback(true);
        } catch {
          // JWT verification failed — allow as anonymous public viewer
          (info.req as IncomingMessage & { _wsUser?: { id: string; role: string } })._wsUser = {
            id: 'anonymous',
            role: 'public',
          };
          callback(true);
        }
      },
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.onConnection(ws, req);
    });

    this.wss.on('error', (err) => {
      logger.error('[WS] Server error', { error: err.message });
    });

    // Start heartbeat
    this.heartbeatHandle = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);

    logger.info(`[WS] WebSocket server listening on port ${port}`);
  }

  stop(): void {
    // Stop heartbeat
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }

    // Close all client connections
    for (const [ws] of this.clients) {
      ws.terminate();
    }
    this.clients.clear();

    // Close the server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    logger.info('[WS] WebSocket server stopped');
  }

  getClientCount(): number {
    return this.clients.size;
  }

  // ── Connection handler ─────────────────────────────────────────────────

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const remoteAddress = req.socket.remoteAddress ?? 'unknown';
    const wsUser = (req as IncomingMessage & { _wsUser?: { id: string; role: string } })._wsUser;

    const isPublic = wsUser?.role === 'public';
    const client: TrackedClient = {
      ws,
      subscriptions: new Set(),
      isAlive: true,
      connectedAt: new Date(),
      remoteAddress,
      userId: wsUser?.id ?? 'unknown',
      userRole: wsUser?.role ?? 'viewer',
      isPublic,
    };

    this.clients.set(ws, client);
    logger.info(`[WS] Client connected from ${remoteAddress} (total: ${this.clients.size})`);

    // Send welcome message with current state
    try {
      const welcomeData = await this.buildWelcomePayload(isPublic);
      this.send(ws, welcomeData);
    } catch (err) {
      logger.error('[WS] Failed to build welcome payload', { error: (err as Error).message });
      this.send(ws, { type: 'error', data: { message: 'Failed to fetch initial state' } });
    }

    // Handle pong for heartbeat
    ws.on('pong', () => {
      client.isAlive = true;
    });

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(client, message);
      } catch {
        this.send(ws, { type: 'error', data: { message: 'Invalid JSON' } });
      }
    });

    // Handle close
    ws.on('close', (code, reason) => {
      this.clients.delete(ws);
      logger.info(
        `[WS] Client disconnected from ${remoteAddress} (code: ${code}, reason: ${reason?.toString() ?? 'none'}, remaining: ${this.clients.size})`,
      );
    });

    // Handle errors
    ws.on('error', (err) => {
      logger.error(`[WS] Client error from ${remoteAddress}`, { error: err.message });
      this.clients.delete(ws);
    });
  }

  // ── Message handler ────────────────────────────────────────────────────

  private async handleClientMessage(client: TrackedClient, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'subscribe': {
        if (!message.seriesId || typeof message.seriesId !== 'string') {
          this.send(client.ws, { type: 'error', data: { message: 'seriesId is required' } });
          return;
        }

        // Public clients can only subscribe to public series
        if (client.isPublic) {
          const series = await db('tournament_series')
            .where({ id: message.seriesId, is_public: true })
            .first();
          if (!series) {
            this.send(client.ws, { type: 'error', data: { message: 'Series not found or not public' } });
            return;
          }
        }

        client.subscriptions.add(message.seriesId);
        logger.debug(`[WS] Client ${client.remoteAddress} subscribed to series ${message.seriesId}`);
        break;
      }

      case 'unsubscribe': {
        if (!message.seriesId || typeof message.seriesId !== 'string') {
          this.send(client.ws, { type: 'error', data: { message: 'seriesId is required' } });
          return;
        }
        client.subscriptions.delete(message.seriesId);
        logger.debug(`[WS] Client ${client.remoteAddress} unsubscribed from series ${message.seriesId}`);
        break;
      }

      case 'ping': {
        this.send(client.ws, { type: 'pong' });
        break;
      }

      default: {
        this.send(client.ws, {
          type: 'error',
          data: { message: `Unknown message type: ${(message as { type: string }).type}` },
        });
      }
    }
  }

  // ── Broadcast methods (called by orchestrator/discovery callbacks) ─────

  /**
   * Broadcast a snapshot_update to all clients subscribed to any affected series.
   * Called by the PollingOrchestrator after each poll cycle.
   */
  async broadcastSnapshotUpdate(pollResult: PollCycleResult, seriesIds: string[]): Promise<void> {
    if (this.clients.size === 0) return;

    for (const seriesId of seriesIds) {
      const subscribedClients = this.getSubscribedClients(seriesId);
      if (subscribedClients.length === 0) continue;

      try {
        const latestSnapshots = await ViewershipSnapshotModel.getLatestSnapshot(seriesId);

        const payload: SnapshotUpdatePayload = {
          type: 'snapshot_update',
          data: {
            seriesId,
            pollResult,
            latestSnapshots,
          },
        };

        for (const client of subscribedClients) {
          this.send(client.ws, payload);
        }
      } catch (err) {
        logger.error(`[WS] Failed to build snapshot_update for series ${seriesId}`, {
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Broadcast a discovery_update to all clients subscribed to the series.
   * Called by the DiscoveryService after each discovery cycle.
   */
  broadcastDiscoveryUpdate(discoveryResult: DiscoveryResult): void {
    if (this.clients.size === 0) return;

    const subscribedClients = this.getSubscribedClients(discoveryResult.seriesId);
    if (subscribedClients.length === 0) return;

    const payload: DiscoveryUpdatePayload = {
      type: 'discovery_update',
      data: {
        seriesId: discoveryResult.seriesId,
        discoveryResult,
      },
    };

    for (const client of subscribedClients) {
      // Don't send discovery data to public viewers
      if (client.isPublic) continue;
      this.send(client.ws, payload);
    }
  }

  /**
   * Broadcast a status_update when a broadcast day status changes.
   * Called by the PollingOrchestrator during transition.
   */
  broadcastStatusUpdate(
    seriesId: string,
    broadcastDayId: string,
    previousStatus: string,
    newStatus: string,
  ): void {
    if (this.clients.size === 0) return;

    const subscribedClients = this.getSubscribedClients(seriesId);
    if (subscribedClients.length === 0) return;

    const payload: StatusUpdatePayload = {
      type: 'status_update',
      data: {
        seriesId,
        broadcastDayId,
        previousStatus,
        newStatus,
      },
    };

    for (const client of subscribedClients) {
      this.send(client.ws, payload);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async buildWelcomePayload(publicOnly = false): Promise<WelcomePayload> {
    // Get active series (public clients only see public series)
    let activeSeries = await TournamentSeriesModel.findAll({ status: 'active' });
    if (publicOnly) {
      activeSeries = activeSeries.filter((s) => s.is_public);
    }

    // Get live broadcast days
    const liveBroadcastDays = await db<BroadcastDay>('broadcast_days')
      .where('status', 'live')
      .select('*');

    return {
      type: 'welcome',
      data: {
        activeSeries: activeSeries.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
        })),
        liveBroadcastDays,
      },
    };
  }

  private getSubscribedClients(seriesId: string): TrackedClient[] {
    const result: TrackedClient[] = [];
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(seriesId)) {
        result.push(client);
      }
    }
    return result;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private heartbeat(): void {
    for (const [ws, client] of this.clients) {
      if (!client.isAlive) {
        logger.info(`[WS] Client ${client.remoteAddress} failed heartbeat — terminating`);
        this.clients.delete(ws);
        ws.terminate();
        continue;
      }

      client.isAlive = false;
      ws.ping();
    }
  }
}
