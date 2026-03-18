#!/usr/bin/env npx tsx
/**
 * TikTok Relay — runs on a residential Mac to avoid data-center IP blocks.
 *
 * Fetches live viewer counts via tiktok-live-connector (WebSocket-free HTTP API)
 * and pushes them to the Clutch Viewership Tracker server's relay endpoint.
 *
 * Usage:
 *   npx tsx scripts/tiktok-relay.ts              # single run
 *   npx tsx scripts/tiktok-relay.ts --loop       # continuous 60s loop
 *
 * Environment (from .env or shell):
 *   RELAY_URL     — Server URL (default: https://tracker.clutch.game)
 *   RELAY_SECRET  — Shared secret for relay auth
 *
 * The script auto-discovers which TikTok channels to poll by querying the server.
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
const INTERVAL_MS = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ChannelResult {
  identifier: string;
  viewers: number;
  title: string | null;
  displayName: string | null;
  isLive: boolean;
}

// ── Fetch viewer count for a single TikTok channel ───────────────────────

async function fetchTikTokLive(username: string): Promise<ChannelResult> {
  const clean = username.replace(/^@/, '');

  try {
    const { WebcastPushConnection } = await import('tiktok-live-connector');

    const connection = new WebcastPushConnection(clean, {
      fetchRoomInfoOnConnect: false,
      enableExtendedGiftInfo: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roomInfo = await connection.fetchRoomInfo() as Record<string, any>;
    const data = roomInfo?.data;

    if (!data || data.status !== 2) {
      return { identifier: username, viewers: 0, title: null, displayName: null, isLive: false };
    }

    return {
      identifier: username,
      viewers: data.user_count ?? 0,
      title: data.title || null,
      displayName: data.owner?.nickname || null,
      isLive: true,
    };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('offline') || msg.includes('UserOffline') || msg.includes('not found')) {
      return { identifier: username, viewers: 0, title: null, displayName: null, isLive: false };
    }
    log(`  ERROR fetching ${username}: ${msg}`);
    return { identifier: username, viewers: 0, title: null, displayName: null, isLive: false };
  }
}

// ── Push results to the server ───────────────────────────────────────────

async function pushToServer(results: ChannelResult[]): Promise<void> {
  const payload = {
    channels: results.map((r) => ({
      identifier: r.identifier,
      viewers: r.viewers,
      title: r.title,
      displayName: r.displayName,
    })),
  };

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

  const result = await response.json() as { matched: number; snapshotsInserted: number };
  log(`  Pushed: ${result.matched} matched, ${result.snapshotsInserted} snapshots inserted`);
}

// ── Main ─────────────────────────────────────────────────────────────────

// Hard-coded channel list — add more as needed
const TIKTOK_CHANNELS = [
  '@pubg.esports.official',
];

async function runOnce() {
  log(`Polling ${TIKTOK_CHANNELS.length} TikTok channel(s)...`);

  const results = await Promise.all(TIKTOK_CHANNELS.map(fetchTikTokLive));

  const live = results.filter((r) => r.isLive);
  log(`  ${live.length}/${results.length} live — ${live.map((r) => `${r.identifier}=${r.viewers}`).join(', ') || 'none'}`);

  await pushToServer(results);
}

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }

  log(`TikTok Relay → ${RELAY_URL}`);
  log(`Mode: ${LOOP_MODE ? 'continuous loop' : 'single run'}`);

  if (LOOP_MODE) {
    while (true) {
      try {
        await runOnce();
      } catch (err) {
        log(`ERROR: ${(err as Error).message}`);
      }
      await sleep(INTERVAL_MS);
    }
  } else {
    await runOnce();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
