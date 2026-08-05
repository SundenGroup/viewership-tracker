#!/usr/bin/env npx tsx
/**
 * TikTok live-category discovery — runs on the residential tracking
 * machine next to tiktok-browser-tracker.ts, using the same Chrome
 * (CDP port 9224, started by scripts/twitch-browser-server.ts).
 *
 * Why a browser: the category feed (webcast.tiktok.com/webcast/feed/)
 * rejects unsigned requests (status_code 10011), and the signature stack
 * (msToken / X-Gnarly / X-Dynosaur) exists only inside a real session.
 * So we open the tiktok.com/live/category/<category> GRID page, let
 * TikTok's own JS sign its category feed call, then cursor-paginate
 * that signed URL (replay is accepted for a short window — verified
 * 2026-08) and relay the rooms to the server. The server's discovery
 * pipeline does the rest.
 *
 * Usage:
 *   npx tsx scripts/tiktok-category-discovery.ts          # one pass
 *   npx tsx scripts/tiktok-category-discovery.ts --loop   # continuous
 *
 * Env (.env or shell): RELAY_URL, RELAY_SECRET
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { parseFeedRooms, type TikTokFeedRoom } from '../src/utils/tiktok-feed';

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
const CDP_PORT = 9224;
const LOOP_MODE = process.argv.includes('--loop');
/** Cursor-paginate the category feed up to this many pages per pass. */
const MAX_FEED_PAGES = 12;
const PAGE_SETTLE_MS = 8_000;

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Minimal CDP client (browser-level connection, flat sessions) ─────────

class CDP {
  private ws: import('ws').WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async connect(): Promise<void> {
    const version = await new Promise<{ webSocketDebuggerUrl: string }>((resolve, reject) => {
      http
        .get(`http://localhost:${CDP_PORT}/json/version`, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e as Error); }
          });
        })
        .on('error', reject);
    });
    const { default: WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch { /* ignore */ }
      });
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  close(): void {
    this.ws?.close();
  }
}

// ── Category capture ─────────────────────────────────────────────────────

/**
 * Runs inside the page: replay the signed CATEGORY-GRID feed URL and
 * cursor-paginate it. Two feed surfaces exist — the /live/<cat> player
 * fires req_from=pc_web_game_sub_feed_refresh and samples ~a dozen
 * rooms, while the /live/category/<cat> grid fires
 * req_from=pc_web_game_category_feed_refresh and pages through the
 * real category listing (verified 2026-08-05: 36+ broadcasters and
 * still has_more after 6 pages, vs ~11 total on the player feed).
 * Only the grid feed is worth capturing; channel_id=86 requests on the
 * same page are the "suggested hosts" rail — never touch those.
 */
const CAPTURE_EXPR = (maxPages: number) => `
(async () => {
  const out = [];
  const signed = performance.getEntriesByType('resource')
    .map(e => e.name)
    .filter(u => u.includes('webcast.tiktok.com/webcast/feed/')
              && u.includes('pc_web_game_category_feed'));
  const base = signed[signed.length - 1];
  if (!base) return { error: 'no signed category-grid feed URL on page', feeds: [] };
  let cursor = null;
  for (let i = 0; i < ${maxPages}; i++) {
    try {
      let u = base;
      if (cursor != null) {
        u = u.includes('max_time=')
          ? u.replace(/([?&])max_time=\\d*/, '$1max_time=' + cursor)
          : u + '&max_time=' + cursor;
      }
      const r = await fetch(u, { credentials: 'include' });
      const j = await r.json();
      out.push(j);
      if (j.status_code !== 0 || !j.extra || !j.extra.has_more) break;
      cursor = j.extra.max_time;
      await new Promise(res => setTimeout(res, 900));
    } catch (e) { out.push({ error: String(e) }); break; }
  }
  return { feeds: out };
})()
`;

async function captureCategory(cdp: CDP, category: string): Promise<TikTokFeedRoom[]> {
  // The /live/category/ GRID page — not the /live/ player, whose feed
  // only samples a handful of rooms (see CAPTURE_EXPR).
  const pageUrl = `https://www.tiktok.com/live/category/${category}`;
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await sleep(PAGE_SETTLE_MS); // let TikTok's JS fire the signed feed call

    const evalRes = await cdp.send<{ result?: { value?: { error?: string; feeds?: unknown[] } } }>(
      'Runtime.evaluate',
      { expression: CAPTURE_EXPR(MAX_FEED_PAGES), awaitPromise: true, returnByValue: true },
      sessionId,
    );
    const value = evalRes.result?.value;
    if (value?.error) log(`  ${category}: ${value.error}`);

    const byUser = new Map<string, TikTokFeedRoom>();
    for (const feed of value?.feeds ?? []) {
      for (const room of parseFeedRooms(feed)) {
        const prev = byUser.get(room.username.toLowerCase());
        if (!prev || room.viewerCount > prev.viewerCount) byUser.set(room.username.toLowerCase(), room);
      }
    }
    return [...byUser.values()];
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// ── Relay I/O ────────────────────────────────────────────────────────────

async function fetchConfig(): Promise<{ categories: string[]; intervalSeconds: number }> {
  const res = await fetch(`${RELAY_URL}/api/relay/tiktok/discover-config`, {
    headers: { Authorization: `Bearer ${RELAY_SECRET}` },
  });
  if (!res.ok) throw new Error(`discover-config ${res.status}`);
  return (await res.json()) as { categories: string[]; intervalSeconds: number };
}

async function pushRooms(category: string, rooms: TikTokFeedRoom[]): Promise<void> {
  const res = await fetch(`${RELAY_URL}/api/relay/tiktok/discovered`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}` },
    body: JSON.stringify({ category, rooms }),
  });
  if (!res.ok) throw new Error(`push ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { stored: number };
  log(`  ${category}: pushed ${rooms.length} room(s), server stored ${out.stored}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function runPass(): Promise<void> {
  const { categories } = await fetchConfig();
  if (categories.length === 0) {
    log('No categories configured (TIKTOK_DISCOVER_CATEGORIES on server).');
    return;
  }
  const cdp = new CDP();
  await cdp.connect();
  try {
    for (const category of categories) {
      try {
        const rooms = await captureCategory(cdp, category);
        const top = rooms.slice(0, 3).map((r) => `${r.username}=${r.viewerCount}`).join(', ');
        log(`  ${category}: ${rooms.length} live room(s)${top ? ` — top: ${top}` : ''}`);
        if (rooms.length > 0) await pushRooms(category, rooms);
      } catch (err) {
        log(`  ${category} ERROR: ${(err as Error).message}`);
      }
    }
  } finally {
    cdp.close();
  }
}

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }
  await new Promise<void>((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json/version`, (res) => {
      res.resume();
      resolve();
    }).on('error', reject);
  }).catch(() => {
    console.error(`ERROR: Chrome browser not running on port ${CDP_PORT}.`);
    console.error('Start it first: npx tsx scripts/twitch-browser-server.ts');
    process.exit(1);
  });

  log(`TikTok category discovery → ${RELAY_URL} (${LOOP_MODE ? 'loop' : 'single pass'})`);

  if (!LOOP_MODE) {
    await runPass();
    process.exit(0);
  }
  while (true) {
    let intervalSeconds = 300;
    try {
      intervalSeconds = (await fetchConfig()).intervalSeconds || 300;
      await runPass();
    } catch (err) {
      log(`Pass ERROR: ${(err as Error).message}`);
    }
    await sleep(intervalSeconds * 1000);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
