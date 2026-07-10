#!/usr/bin/env npx tsx
/**
 * Kick chatroom-id resolver — runs on the RESIDENTIAL relay box (the same
 * machine as the TikTok relay), NOT on the server.
 *
 * Kick's unofficial API (the only source of chatroom ids, which the chat
 * collector needs for its Pusher subscriptions) hard-403s datacenter IPs
 * but answers residential ones. Chatroom ids are static per channel, so
 * each channel needs resolving exactly ONCE: this script polls the server
 * for pending slugs, resolves them via kick.com, and pushes the ids back.
 * Once a channel's id is cached, the server-side chat collector subscribes
 * to its chat automatically on the next selection cycle.
 *
 * Usage (on the relay box):
 *   npx tsx scripts/kick-chatroom-relay.ts --loop     # every 10 min
 *   npx tsx scripts/kick-chatroom-relay.ts            # single pass
 *
 * Environment (from .env or shell):
 *   RELAY_URL     — Server URL (default: https://tracker.clutch.game)
 *   RELAY_SECRET  — Shared secret for relay auth
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Load .env (same pattern as the other relay scripts) ──────────────────
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
const INTERVAL_MS = 10 * 60_000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [KickChatroom] ${msg}`);
}

async function fetchPending(): Promise<string[]> {
  const res = await fetch(`${RELAY_URL}/api/relay/kick/chatroom-pending`, {
    headers: { Authorization: `Bearer ${RELAY_SECRET}` },
  });
  if (!res.ok) throw new Error(`pending fetch: ${res.status}`);
  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

async function resolveChatroomId(slug: string): Promise<number | null> {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      log(`  ${slug}: HTTP ${res.status} — skipped`);
      return null;
    }
    const data = (await res.json()) as { chatroom?: { id?: number } };
    const id = data?.chatroom?.id;
    return Number.isInteger(id) && (id as number) > 0 ? (id as number) : null;
  } catch (err) {
    log(`  ${slug}: ${(err as Error).message}`);
    return null;
  }
}

async function pushIds(ids: Array<{ slug: string; chatroomId: number }>): Promise<void> {
  const res = await fetch(`${RELAY_URL}/api/relay/kick/chatroom-ids`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RELAY_SECRET}`,
    },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`push: ${res.status} ${await res.text()}`);
  const result = (await res.json()) as { updatedRows: number };
  log(`pushed ${ids.length} id(s) → ${result.updatedRows} channel row(s) updated`);
}

async function runOnce(): Promise<void> {
  const slugs = await fetchPending();
  if (slugs.length === 0) {
    log('no pending channels — all chatroom ids cached');
    return;
  }
  log(`${slugs.length} channel(s) pending resolution`);
  const resolved: Array<{ slug: string; chatroomId: number }> = [];
  for (const slug of slugs) {
    const id = await resolveChatroomId(slug);
    if (id !== null) resolved.push({ slug, chatroomId: id });
    // Gentle pacing — one lookup every 1.5s keeps us invisible.
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (resolved.length > 0) await pushIds(resolved);
  log(`resolved ${resolved.length}/${slugs.length}`);
}

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }
  log(`Kick chatroom relay → ${RELAY_URL} (${LOOP_MODE ? 'loop, 10 min' : 'single run'})`);
  if (LOOP_MODE) {
    for (;;) {
      try {
        await runOnce();
      } catch (err) {
        log(`ERROR: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  } else {
    await runOnce();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
