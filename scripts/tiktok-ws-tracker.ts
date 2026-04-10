#!/usr/bin/env npx tsx
/**
 * TikTok WebSocket Tracker — connects to TikTok live streams via WebSocket
 * for real-time viewer count updates.
 *
 * Auto-fetches the active TikTok channel list from the server API, so no
 * .env editing needed — just add channels in the tool and they're tracked.
 *
 * Runs ALONGSIDE the existing tiktok-relay.ts scraper (additive, not replacing).
 * Server keeps the highest value from either source.
 *
 * Usage:
 *   npx tsx scripts/tiktok-ws-tracker.ts          # single check
 *   npx tsx scripts/tiktok-ws-tracker.ts --loop    # continuous tracking
 *
 * Environment (from .env or shell):
 *   RELAY_URL     — Server URL (default: https://tracker.clutch.game)
 *   RELAY_SECRET  — Shared secret for relay auth
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Load .env ─────────────────────────────────────────────────────────────

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const RELAY_URL = process.env.RELAY_URL || 'https://tracker.clutch.game';
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const LOOP_MODE = process.argv.includes('--loop');
const PUSH_INTERVAL_MS = 60_000;       // Push to server every 60 seconds
const CHANNEL_REFRESH_MS = 5 * 60_000; // Re-fetch channel list every 5 minutes
const RECONNECT_DELAY_MS = 30_000;     // Wait before reconnecting a failed connection

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Channel state ─────────────────────────────────────────────────────────

interface TrackedChannel {
  identifier: string;   // e.g. "@pubg.esports.official"
  displayName: string;
  viewers: number;
  isLive: boolean;
  connection: unknown | null;  // TikTokLiveConnection instance
  lastUpdate: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const trackedChannels = new Map<string, TrackedChannel>();

// ── Fetch channel list from server ────────────────────────────────────────

async function fetchChannelList(): Promise<Array<{ channel_identifier: string; display_name: string }>> {
  try {
    const res = await fetch(`${RELAY_URL}/api/relay/tiktok/channels`, {
      headers: { Authorization: `Bearer ${RELAY_SECRET}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = (await res.json()) as { channels: Array<{ channel_identifier: string; display_name: string }> };
    return data.channels;
  } catch (err) {
    log(`  Could not fetch channel list: ${(err as Error).message}`);
    return [];
  }
}

// ── Connect to a TikTok live stream ───────────────────────────────────────

async function connectChannel(identifier: string, displayName: string): Promise<void> {
  const clean = identifier.replace(/^@/, '');

  // Don't reconnect if already connected
  const existing = trackedChannels.get(identifier);
  if (existing?.connection) return;

  try {
    const { TikTokLiveConnection } = await import('tiktok-live-connector');

    const connection = new TikTokLiveConnection(clean, {
      processInitialData: true,
      fetchRoomInfoOnConnect: true,
      enableRequestPolling: true,
      requestPollingIntervalMs: 5000,
    });

    const channel: TrackedChannel = {
      identifier,
      displayName,
      viewers: 0,
      isLive: false,
      connection,
      lastUpdate: Date.now(),
      reconnectTimer: null,
    };

    // Viewer count updates (real-time)
    connection.on('roomUser', (data: { viewerCount: number }) => {
      channel.viewers = data.viewerCount;
      channel.isLive = true;
      channel.lastUpdate = Date.now();
    });

    // Connected
    connection.on('connected', () => {
      channel.isLive = true;
      log(`  ✓ Connected to ${displayName} (${clean})`);
    });

    // Disconnected
    connection.on('disconnected', () => {
      channel.isLive = false;
      channel.connection = null;
      log(`  ✗ Disconnected from ${displayName} (${clean})`);

      // Schedule reconnect
      if (!channel.reconnectTimer) {
        channel.reconnectTimer = setTimeout(() => {
          channel.reconnectTimer = null;
          connectChannel(identifier, displayName).catch(() => {});
        }, RECONNECT_DELAY_MS);
      }
    });

    // Error
    connection.on('error', (err: Error) => {
      log(`  ERROR ${displayName}: ${err.message}`);
    });

    // Stream ended
    connection.on('streamEnd', () => {
      channel.isLive = false;
      channel.viewers = 0;
      channel.connection = null;
      log(`  Stream ended: ${displayName}`);
    });

    trackedChannels.set(identifier, channel);

    await connection.connect();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('offline') || msg.includes('LIVE has ended')) {
      log(`  ${displayName} is offline`);
    } else {
      log(`  Failed to connect to ${displayName}: ${msg}`);
    }

    // Store channel even if connection failed (for tracking state)
    if (!trackedChannels.has(identifier)) {
      trackedChannels.set(identifier, {
        identifier,
        displayName,
        viewers: 0,
        isLive: false,
        connection: null,
        lastUpdate: Date.now(),
        reconnectTimer: null,
      });
    }

    // Schedule reconnect for offline channels
    const ch = trackedChannels.get(identifier)!;
    if (!ch.reconnectTimer) {
      ch.reconnectTimer = setTimeout(() => {
        ch.reconnectTimer = null;
        connectChannel(identifier, displayName).catch(() => {});
      }, RECONNECT_DELAY_MS);
    }
  }
}

// ── Disconnect channels no longer in the list ─────────────────────────────

function cleanupStaleChannels(activeIdentifiers: Set<string>): void {
  for (const [identifier, channel] of trackedChannels) {
    if (!activeIdentifiers.has(identifier)) {
      log(`  Removing ${channel.displayName} (no longer active)`);
      if (channel.reconnectTimer) clearTimeout(channel.reconnectTimer);
      try {
        (channel.connection as any)?.disconnect?.();
      } catch {}
      trackedChannels.delete(identifier);
    }
  }
}

// ── Push results to server ────────────────────────────────────────────────

async function pushToServer(): Promise<void> {
  const liveChannels = [...trackedChannels.values()].filter(
    (ch) => ch.isLive && ch.viewers > 0,
  );

  if (liveChannels.length === 0) {
    log(`Push: 0 live channels — nothing to push`);
    return;
  }

  const payload = {
    channels: liveChannels.map((ch) => ({
      identifier: ch.identifier,
      viewers: ch.viewers,
      title: null,
      displayName: ch.displayName,
    })),
  };

  try {
    const response = await fetch(`${RELAY_URL}/api/relay/tiktok`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Server returned ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { matched: number; snapshotsInserted: number };
    log(`Push: ${liveChannels.length} live → ${result.matched} matched, ${result.snapshotsInserted} inserted`);
  } catch (err) {
    log(`Push ERROR: ${(err as Error).message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function refreshChannels(): Promise<void> {
  const serverChannels = await fetchChannelList();

  if (serverChannels.length === 0) {
    log('No active TikTok channels from server');
    return;
  }

  log(`Server returned ${serverChannels.length} TikTok channel(s)`);
  const activeIdentifiers = new Set<string>();

  for (const ch of serverChannels) {
    activeIdentifiers.add(ch.channel_identifier);

    const existing = trackedChannels.get(ch.channel_identifier);
    if (!existing || !existing.connection) {
      // New channel or disconnected — connect
      await connectChannel(ch.channel_identifier, ch.display_name);
      await sleep(1000); // Stagger connections
    }
  }

  // Remove channels no longer in the server list
  cleanupStaleChannels(activeIdentifiers);
}

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }

  log(`TikTok WebSocket Tracker → ${RELAY_URL}`);
  log(`Mode: ${LOOP_MODE ? 'continuous' : 'single check'}`);

  if (!LOOP_MODE) {
    await refreshChannels();
    await sleep(10_000); // Wait for some data
    await pushToServer();
    process.exit(0);
  }

  // Initial connection
  await refreshChannels();

  // Push loop — every 60 seconds
  setInterval(async () => {
    try {
      await pushToServer();
    } catch (err) {
      log(`Push loop error: ${(err as Error).message}`);
    }
  }, PUSH_INTERVAL_MS);

  // Channel refresh loop — every 5 minutes
  setInterval(async () => {
    try {
      await refreshChannels();
    } catch (err) {
      log(`Channel refresh error: ${(err as Error).message}`);
    }
  }, CHANNEL_REFRESH_MS);

  // Status log
  setInterval(() => {
    const live = [...trackedChannels.values()].filter((ch) => ch.isLive);
    const total = trackedChannels.size;
    log(`Status: ${live.length}/${total} live — ${live.map((ch) => `${ch.displayName}=${ch.viewers}`).join(', ') || 'none'}`);
  }, 60_000);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
