#!/usr/bin/env npx tsx
/**
 * Twitch Relay — runs on a remote server (e.g. US) to poll Twitch viewer counts
 * from a different geographic location / CDN POP.
 *
 * Pushes results to the Clutch Viewership Tracker server's relay endpoint.
 * The server takes MAX(local poll, relay poll) per channel per minute.
 *
 * Usage:
 *   npx tsx scripts/twitch-relay.ts              # single run
 *   npx tsx scripts/twitch-relay.ts --loop       # continuous 30s loop
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
const INTERVAL_MS = 30_000; // 30 seconds — matches server polling interval

const GQL_URL = 'https://gql.twitch.tv/gql';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Public Twitch web client ID
const GQL_BATCH_SIZE = 35;

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
  isLive: boolean;
}

// ── Fetch viewer counts via Twitch GQL ────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function fetchTwitchViewers(logins: string[]): Promise<ChannelResult[]> {
  const results: ChannelResult[] = [];
  const batches = chunk(logins, GQL_BATCH_SIZE);

  for (const batch of batches) {
    try {
      const ops = batch.map((login, i) => ({
        operationName: `V${i}`,
        query: `query V${i} { user(login: "${login}") { stream { viewersCount } } }`,
      }));

      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: {
          'Client-ID': GQL_CLIENT_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ops),
      });

      if (!res.ok) {
        log(`  GQL error: ${res.status} ${res.statusText}`);
        continue;
      }

      const data = (await res.json()) as Array<{
        data: { user: { stream: { viewersCount: number } | null } | null };
      }>;

      for (let i = 0; i < batch.length; i++) {
        const stream = data[i]?.data?.user?.stream;
        results.push({
          identifier: batch[i],
          viewers: stream?.viewersCount ?? 0,
          isLive: !!stream,
        });
      }
    } catch (err) {
      log(`  ERROR fetching batch: ${(err as Error).message}`);
    }
  }

  return results;
}

// ── Push results to the server ────────────────────────────────────────────

async function pushToServer(results: ChannelResult[]): Promise<void> {
  const payload = {
    platform: 'twitch',
    channels: results.map((r) => ({
      identifier: r.identifier,
      viewers: r.viewers,
    })),
  };

  const response = await fetch(`${RELAY_URL}/api/relay/twitch`, {
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

  const result = (await response.json()) as { matched: number; updated: number };
  log(`  Pushed: ${result.matched} matched, ${result.updated} updated (higher)`);
}

// ── Channel list — auto-fetched from server ───────────────────────────────

async function fetchChannelList(): Promise<string[]> {
  try {
    const res = await fetch(`${RELAY_URL}/api/relay/twitch/channels`, {
      headers: { Authorization: `Bearer ${RELAY_SECRET}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = (await res.json()) as { channels: string[] };
    return data.channels;
  } catch {
    log('  Could not fetch channel list from server, using hardcoded fallback');
    return FALLBACK_CHANNELS;
  }
}

// Fallback channel list if server endpoint isn't available yet
const FALLBACK_CHANNELS = [
  'pubg_battlegrounds',
  'pubgesportsmap',
  'pubg_br',
  'pubg_cis',
  'pubgjapan',
  'pubgthailandofficial',
  'pubgthailandofficial_2',
  'pubg_battlegroundstr',
  'pubg_taiwan',
  'pokamolodoy',
  'tgltn',
  'hwinn',
  'kickstart',
  'shrimzy',
];

// ── Main ──────────────────────────────────────────────────────────────────

let channelList: string[] = [];
let lastChannelFetch = 0;
const CHANNEL_REFRESH_MS = 5 * 60_000; // Re-fetch channel list every 5 minutes

async function runOnce() {
  // Refresh channel list periodically
  if (Date.now() - lastChannelFetch > CHANNEL_REFRESH_MS) {
    channelList = await fetchChannelList();
    lastChannelFetch = Date.now();
    log(`Channel list: ${channelList.length} channels`);
  }

  log(`Polling ${channelList.length} Twitch channel(s)...`);

  const results = await fetchTwitchViewers(channelList);

  const live = results.filter((r) => r.isLive);
  log(`  ${live.length}/${results.length} live`);

  // Only push live channels with viewers > 0
  const toSend = results.filter((r) => r.isLive && r.viewers > 0);
  if (toSend.length > 0) {
    await pushToServer(toSend);
  }
}

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }

  log(`Twitch Relay → ${RELAY_URL}`);
  log(`Mode: ${LOOP_MODE ? 'continuous loop (30s)' : 'single run'}`);

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
