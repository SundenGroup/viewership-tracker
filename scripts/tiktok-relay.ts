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
    // Scrape the TikTok live page directly — more reliable than tiktok-live-connector
    const res = await fetch(`https://www.tiktok.com/@${clean}/live`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();

    // Check if user is live (status: 2 in liveRoomUserInfo)
    const statusMatch = html.match(/"status"\s*:\s*(\d+)/);
    if (!statusMatch || statusMatch[1] !== '2') {
      return { identifier: username, viewers: 0, title: null, displayName: null, isLive: false };
    }

    // Extract viewer count from liveRoomStats
    const statsMatch = html.match(/"liveRoomStats"\s*:\s*\{[^}]*"userCount"\s*:\s*(\d+)/);
    const viewers = statsMatch ? parseInt(statsMatch[1], 10) : 0;

    // Extract display name
    const nameMatch = html.match(/"nickname"\s*:\s*"([^"]+)"/);
    const displayName = nameMatch ? nameMatch[1] : null;

    // Extract title/signature
    const titleMatch = html.match(/"signature"\s*:\s*"([^"]+)"/);
    const title = titleMatch ? titleMatch[1].replace(/\\n/g, ' ').slice(0, 200) : null;

    return {
      identifier: username,
      viewers,
      title,
      displayName,
      isLive: true,
    };
  } catch (err) {
    log(`  ERROR fetching ${clean}: ${(err as Error).message}`);
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

// TikTok channels to poll — add more as needed
const TIKTOK_CHANNELS = [
  '@pubg.esports.official',
  '@pubg_battlegrounds_vn',
  'pubgthailandofficial',
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
