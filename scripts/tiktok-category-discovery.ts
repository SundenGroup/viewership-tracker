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
/** Open capture tabs in front (the behaviour before 2026-11-18). */
const FOREGROUND_TABS = process.env.TIKTOK_DISCOVER_FOREGROUND === '1';
/** Capture only these categories ("a|b"), for a manual test pass. */
const ONLY_CATEGORIES = (process.env.TIKTOK_DISCOVER_ONLY ?? '').split('|').map((x) => x.trim()).filter(Boolean);
/** Cursor-paginate the category feed up to this many pages per pass. */
const MAX_FEED_PAGES = 12;
/**
 * Language settings the category feed is asked again with, after the
 * browser's own. TikTok hands one viewer about 30 rooms of a category and
 * picks them by the viewer's language. Measured on 2026-11-18 with 45
 * settings: the GTA V grid gave a Swedish browser 29 rooms and 249 across
 * all of them. What the measurement showed:
 *   - the code must be the bare language ("pt", "de"): "pt-BR" and "de-DE"
 *     return nothing new, and regional variants ("en-US", "es-MX",
 *     "ar-SA") return what the bare code already gave;
 *   - the country parameters change nothing;
 *   - asking a setting twice returns the same rooms, so the gain is the
 *     language and not chance;
 *   - every setting stops at about 30 rooms, so a large language is still
 *     only seen in part.
 *
 * Every category gets the short list. A tracker that sets
 * metadata.tiktok_wide_sweep gets the wide one for its categories (the
 * server names them in discover-config): it adds about 40 seconds per
 * category to a pass.
 *
 * Override with TIKTOK_DISCOVER_LANGS / TIKTOK_DISCOVER_WIDE_LANGS
 * ("en|es|ar"; an empty string turns that list off).
 */
const pipeList = (raw: string) => raw.split('|').map((x) => x.trim()).filter(Boolean);
const SWEEP_LANGUAGES = pipeList(process.env.TIKTOK_DISCOVER_LANGS ?? 'en|es|ar|fr|pt|de|ru');
const WIDE_LANGUAGES = pipeList(
  process.env.TIKTOK_DISCOVER_WIDE_LANGS ?? 'pl|uk|vi|it|id|hu|hr|tl|ms|uz|bn|hi|ne|az|tr|ro|cs',
);
/** Pages per language of the short list: these hold up to 25 new rooms each. */
const SWEEP_PAGES = Math.max(1, Number(process.env.TIKTOK_DISCOVER_LANG_PAGES ?? 4) || 4);
/** Pages per language of the wide list: a handful of rooms each. */
const WIDE_PAGES = 2;
/** Pause between pages of a language call (the page's own feed keeps its slower pace). */
const SWEEP_PAGE_PAUSE_MS = 500;
/** List languages that added nothing as well (for measuring which settings are worth asking). */
const SWEEP_REPORT_EMPTY = process.env.TIKTOK_DISCOVER_REPORT_EMPTY === '1';
const PAGE_SETTLE_MS = 8_000;
/** Longest wait for the page to fire its signed feed call (a background tab is slower). */
const FEED_WAIT_MS = 25_000;
const FEED_SEEN_EXPR = `performance.getEntriesByType('resource').some(e => e.name.includes('webcast.tiktok.com/webcast/feed/') && e.name.includes('pc_web_game_category_feed'))`;

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
const CAPTURE_EXPR = (maxPages: number, language: string | null = null, pauseMs = 900) => `
(async () => {
  const out = [];
  const signed = performance.getEntriesByType('resource')
    .map(e => e.name)
    .filter(u => u.includes('webcast.tiktok.com/webcast/feed/')
              && u.includes('pc_web_game_category_feed'));
  // The page's own call, remembered the first time: our replays below show
  // up among the page's requests too, and the "last feed call" would then be
  // one of ours, with another language and a cursor deep into its list.
  const base = window.__clutchFeedBase || (window.__clutchFeedBase = signed[signed.length - 1]);
  if (!base) return { error: 'no signed category-grid feed URL on page', feeds: [] };
  const lang = ${JSON.stringify(language)};
  let cursor = null;
  for (let i = 0; i < ${maxPages}; i++) {
    try {
      let u = base;
      if (lang) {
        // The same signed call, asked as a viewer of another language, from the top of its list.
        const url = new URL(base);
        for (const key of ['app_language', 'webcast_language', 'browser_language']) url.searchParams.set(key, lang);
        if (cursor != null) url.searchParams.set('max_time', cursor);
        else url.searchParams.delete('max_time');
        u = url.toString();
      } else if (cursor != null) {
        u = u.includes('max_time=')
          ? u.replace(/([?&])max_time=\\d*/, '$1max_time=' + cursor)
          : u + '&max_time=' + cursor;
      }
      const r = await fetch(u, { credentials: 'include' });
      const j = await r.json();
      out.push(j);
      if (j.status_code !== 0 || !j.extra || !j.extra.has_more) break;
      cursor = j.extra.max_time;
      await new Promise(res => setTimeout(res, ${pauseMs}));
    } catch (e) { out.push({ error: String(e) }); break; }
  }
  return { feeds: out };
})()
`;

async function captureCategory(cdp: CDP, category: string, wide = false): Promise<TikTokFeedRoom[]> {
  // The /live/category/ GRID page — not the /live/ player, whose feed
  // only samples a handful of rooms (see CAPTURE_EXPR).
  const pageUrl = `https://www.tiktok.com/live/category/${category}`;
  // Background tab: a foreground one pulls the Chrome window in front of
  // whatever the person at this machine is doing, once per category, every
  // pass. TIKTOK_DISCOVER_FOREGROUND=1 restores the old behaviour.
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    background: !FOREGROUND_TABS,
  });
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    // A background tab reads as unfocused to the page; say otherwise, so
    // TikTok's own JS still loads the grid and fires its signed feed call.
    if (!FOREGROUND_TABS) {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    }
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    // Let TikTok's JS fire the signed feed call: wait until it shows up
    // among the page's requests instead of a fixed pause. A background tab
    // in a covered window can take far longer than a foreground one.
    const deadline = Date.now() + FEED_WAIT_MS;
    await sleep(3_000);
    while (Date.now() < deadline) {
      const seen = await cdp
        .send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: FEED_SEEN_EXPR, returnByValue: true }, sessionId)
        .catch(() => null);
      if (seen?.result?.value === true) break;
      await sleep(1_000);
    }
    await sleep(1_500);

    type Captured = { result?: { value?: { error?: string; feeds?: unknown[] } } };
    const evalRes = await cdp.send<Captured>(
      'Runtime.evaluate',
      { expression: CAPTURE_EXPR(MAX_FEED_PAGES), awaitPromise: true, returnByValue: true },
      sessionId,
    );
    const value = evalRes.result?.value;
    if (value?.error) log(`  ${category}: ${value.error}`);

    const byUser = new Map<string, TikTokFeedRoom>();
    /** Adds the rooms of some feed pages; returns how many were new and the viewers they hold. */
    const merge = (feeds: unknown[]): { fresh: number; viewers: number } => {
      let fresh = 0;
      let viewers = 0;
      for (const feed of feeds) {
        for (const room of parseFeedRooms(feed)) {
          const key = room.username.toLowerCase();
          const prev = byUser.get(key);
          if (!prev) {
            fresh++;
            viewers += room.viewerCount;
          }
          if (!prev || room.viewerCount > prev.viewerCount) byUser.set(key, room);
        }
      }
      return { fresh, viewers };
    };
    const own = merge(value?.feeds ?? []).fresh;

    // The same feed as a viewer of other languages, one short call each so
    // a slow one cannot run into the browser connection's 30 s limit. Only
    // when the page gave a feed at all: without it there is nothing to ask.
    const added: string[] = [];
    if (own > 0) {
      const asks: Array<[string, number]> = [
        ...SWEEP_LANGUAGES.map((l): [string, number] => [l, SWEEP_PAGES]),
        ...(wide ? WIDE_LANGUAGES.filter((l) => !SWEEP_LANGUAGES.includes(l)).map((l): [string, number] => [l, WIDE_PAGES]) : []),
      ];
      for (const [language, pages] of asks) {
        try {
          const res = await cdp.send<Captured>(
            'Runtime.evaluate',
            { expression: CAPTURE_EXPR(pages, language, SWEEP_PAGE_PAUSE_MS), awaitPromise: true, returnByValue: true },
            sessionId,
          );
          const got = merge(res.result?.value?.feeds ?? []);
          if (got.fresh > 0) added.push(`${language} +${got.fresh}/${got.viewers}`);
          else if (SWEEP_REPORT_EMPTY) added.push(`${language} +0`);
        } catch (err) {
          log(`  ${category}: language ${language} failed: ${(err as Error).message}`);
        }
        await sleep(300);
      }
      if (asks.length > 0) {
        // Per language: rooms it added / viewers in those rooms.
        log(`  ${category}: ${own} room(s) as loaded, ${byUser.size} with other languages${added.length ? ` (${added.join(', ')})` : ''}`);
      }
    }
    return [...byUser.values()];
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// ── Relay I/O ────────────────────────────────────────────────────────────

async function fetchConfig(): Promise<{ categories: string[]; wideCategories?: string[]; intervalSeconds: number }> {
  const res = await fetch(`${RELAY_URL}/api/relay/tiktok/discover-config`, {
    headers: { Authorization: `Bearer ${RELAY_SECRET}` },
  });
  if (!res.ok) throw new Error(`discover-config ${res.status}`);
  return (await res.json()) as { categories: string[]; wideCategories?: string[]; intervalSeconds: number };
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
  const config = await fetchConfig();
  const configured = config.categories;
  const wide = new Set(config.wideCategories ?? []);
  const categories = ONLY_CATEGORIES.length > 0 ? configured.filter((c) => ONLY_CATEGORIES.includes(c)) : configured;
  if (categories.length === 0) {
    log('No categories configured (TIKTOK_DISCOVER_CATEGORIES on server).');
    return;
  }
  const cdp = new CDP();
  await cdp.connect();
  try {
    for (const category of categories) {
      try {
        let rooms = await captureCategory(cdp, category, wide.has(category));
        // An empty capture is usually a page that never fired its feed call:
        // one more try before this category goes without rooms for a pass.
        if (rooms.length === 0) rooms = await captureCategory(cdp, category, wide.has(category));
        const top = [...rooms].sort((x, y) => y.viewerCount - x.viewerCount).slice(0, 3)
          .map((r) => `${r.username}=${r.viewerCount}`).join(', ');
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
    const startedAt = Date.now();
    try {
      intervalSeconds = (await fetchConfig()).intervalSeconds || 300;
      await runPass();
    } catch (err) {
      log(`Pass ERROR: ${(err as Error).message}`);
    }
    // The interval runs from pass START to pass start. The server serves a
    // room for seven minutes after its capture; sleeping a full interval
    // after a two-minute pass left every room missing for a minute or more.
    const elapsedMs = Date.now() - startedAt;
    await sleep(Math.max(30_000, intervalSeconds * 1000 - elapsedMs));
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
