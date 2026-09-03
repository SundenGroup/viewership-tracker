#!/usr/bin/env npx tsx
/**
 * TikTok Browser Tracker — self-hosted, no external dependencies.
 *
 * Opens TikTok live pages in Chrome, intercepts the WebSocket connection
 * that TikTok's own JS creates, and connects to it from Node.js for
 * real-time viewer count updates. Falls back to DOM reading if WebSocket
 * interception fails.
 *
 * NO Euler, NO tiktok-live-connector. Just Chrome + Node.js.
 * Requires: Chrome browser server on port 9224, logged-in TikTok session.
 *
 * Auto-fetches active TikTok channels from the server API.
 *
 * Usage:
 *   npx tsx scripts/tiktok-browser-tracker.ts --loop
 *
 * Environment (from .env or shell):
 *   RELAY_URL     — Server URL (default: https://tracker.clutch.game)
 *   RELAY_SECRET  — Shared secret for relay auth
 */

import * as fs from 'fs';
import * as path from 'path';
import { TikTokWSInterceptClient } from './lib/tiktok-ws-client';

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
const INTERVAL_MS = 60_000;           // Read every 60 seconds
const CHANNEL_REFRESH_MS = 5 * 60_000; // Refresh channel list every 5 minutes

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// ── Push results to server ────────────────────────────────────────────────

async function pushToServer(results: Array<{ identifier: string; viewers: number; displayName: string; source?: string }>): Promise<void> {
  const payload = {
    channels: results.map((r) => ({
      identifier: r.identifier,
      viewers: r.viewers,
      title: null,
      displayName: r.displayName,
      source: r.source,
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

    const result = (await response.json()) as { matched: number; snapshotsInserted: number; snapshotsUpdated: number };
    log(`  Push: ${results.length} live → ${result.matched} matched, ${result.snapshotsInserted} inserted, ${result.snapshotsUpdated} updated`);
  } catch (err) {
    log(`  Push ERROR: ${(err as Error).message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }

  // Verify Chrome browser is running
  try {
    const http = await import('http');
    await new Promise<void>((resolve, reject) => {
      http.get('http://localhost:9224/json', (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve());
      }).on('error', reject);
    });
  } catch {
    console.error('ERROR: Chrome browser not running on port 9224.');
    console.error('Start it first: npx tsx scripts/twitch-browser-server.ts');
    process.exit(1);
  }

  log(`TikTok Browser Tracker → ${RELAY_URL}`);
  log(`Mode: ${LOOP_MODE ? 'continuous (60s)' : 'single run'}`);
  log('Self-hosted: Chrome WebSocket interception + DOM fallback. No Euler.');

  const client = new TikTokWSInterceptClient();
  let lastChannelFetch = 0;
  let channelList: Array<{ channel_identifier: string; display_name: string }> = [];

  async function refreshAndConnect() {
    if (Date.now() - lastChannelFetch < CHANNEL_REFRESH_MS && channelList.length > 0) return;

    channelList = await fetchChannelList();
    lastChannelFetch = Date.now();
    log(`Channel list: ${channelList.length} TikTok channels`);

    const activeUsernames = new Set<string>();
    for (const ch of channelList) {
      const clean = ch.channel_identifier.replace(/^@/, '');
      activeUsernames.add(clean);
      try {
        await client.connectChannel(ch.channel_identifier, ch.display_name);
      } catch (err) {
        log(`  Error connecting ${ch.display_name}: ${(err as Error).message}`);
      }
    }

    // Disconnect channels no longer active
    for (const username of client.getTrackedUsernames()) {
      if (!activeUsernames.has(username)) {
        await client.disconnectChannel(username);
        log(`  Disconnected ${username} (no longer active)`);
      }
    }
  }

  async function runOnce() {
    // Refresh DOM-based viewer counts for channels without active WebSocket
    await client.refreshViewerCounts();

    const states = client.getChannelStates();
    const results: Array<{ identifier: string; viewers: number; displayName: string; source: string }> = [];

    for (const ch of states) {
      if (ch.isLive && ch.viewers > 0) {
        results.push({
          identifier: `@${ch.username}`,
          viewers: ch.viewers,
          displayName: ch.displayName,
          source: ch.wsConnected ? 'browser-ws' : 'browser-dom',
        });
      }
    }

    const wsCount = states.filter((s) => s.wsConnected).length;
    const liveCount = results.length;
    log(`${liveCount}/${states.length} live (${wsCount} via WebSocket) — ${results.map((r) => `${r.displayName}=${r.viewers}`).join(', ') || 'none'}`);

    if (results.length > 0) {
      await pushToServer(results);
    }
  }

  if (!LOOP_MODE) {
    await refreshAndConnect();
    await sleep(15000); // Wait for WebSocket interception
    await runOnce();
    process.exit(0);
  }

  // Initial setup — connect to all channels
  await refreshAndConnect();
  log(`Waiting 10s for WebSocket connections...`);
  await sleep(10_000);

  // Channel refresh loop (every 5 minutes)
  setInterval(async () => {
    try {
      await refreshAndConnect();
    } catch (err) {
      log(`Channel refresh error: ${(err as Error).message}`);
    }
  }, CHANNEL_REFRESH_MS);

  // Main push loop
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      log(`ERROR: ${(err as Error).message}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
