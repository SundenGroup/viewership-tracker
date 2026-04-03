#!/usr/bin/env npx tsx
/**
 * Twitch Browser Scraper — reads real-time viewer counts from open Twitch tabs.
 *
 * Connects to a persistent Chrome instance (started by twitch-browser-server.ts)
 * via CDP, opens one tab per channel, and reads the DOM viewer count every 60s.
 * Pushes results to the Clutch Viewership Tracker relay endpoint.
 *
 * The viewer count displayed on the Twitch page updates every ~60 seconds with
 * real per-minute data — more granular than the stepped 3-5 min API cache.
 *
 * Usage:
 *   1. Start browser:  npx tsx scripts/twitch-browser-server.ts
 *   2. Start scraper:  npx tsx scripts/twitch-browser-scraper.ts --loop
 *
 * Environment (from .env or shell):
 *   RELAY_URL     — Server URL (default: https://tracker.clutch.game)
 *   RELAY_SECRET  — Shared secret for relay auth
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

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
const INTERVAL_MS = 60_000; // 60 seconds
const CDP_PORT = 9224;
const CDP_FILE = path.join(__dirname, '.twitch-browser-cdp');

// Priority channels for browser scraping — official + top streamers only.
// Kept small (~15) to avoid overloading the browser with too many tabs.
// Auto-fetch from server is disabled; this curated list is the source of truth.
const CHANNELS = [
  // Official (9)
  'pubg_battlegrounds',
  'pubgesportsmap',
  'PUBG_BR',
  'pubg_cis',
  'pubgjapan',
  'PUBGThailandOfficial',
  'pubgthailandofficial_2',
  'pubg_battlegroundstr',
  'pubg_taiwan',
  // Top streamers by avg CCV across series (9)
  'pokamolodoy',     // avg 3506
  'tgltn',           // avg 1671
  'jacobpopularr',   // avg 708
  'batulins',        // avg 509
  'makatao',         // avg 495
  'ibakhmet',        // avg 375
  'droogtv',         // avg 359
  'heawin',          // avg 327
  'zuluxxman',       // avg 303
];

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── CDP helpers ────────────────────────────────────────────────────────────

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function cdpGet(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getTargets(): Promise<CDPTarget[]> {
  return cdpGet('/json') as Promise<CDPTarget[]>;
}

async function createTab(url: string): Promise<CDPTarget> {
  return cdpGet(`/json/new?${encodeURIComponent(url)}`) as Promise<CDPTarget>;
}

// ── WebSocket CDP session for evaluating JS ────────────────────────────────

class CDPSession {
  private ws: import('ws').WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async connect(wsUrl: string): Promise<void> {
    const { default: WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {}
      });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws) throw new Error('Not connected');
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout'));
        }
      }, 10000);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown } };
    return result?.result?.value;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.pending.clear();
  }
}

// ── Tab manager ────────────────────────────────────────────────────────────

interface ManagedTab {
  channel: string;
  targetId: string;
  wsUrl: string;
}

const managedTabs = new Map<string, ManagedTab>();

async function ensureTabsOpen(channels: string[]): Promise<void> {
  const targets = await getTargets();
  const existingUrls = new Map<string, CDPTarget>();
  for (const t of targets) {
    if (t.type === 'page' && t.url.includes('twitch.tv/')) {
      existingUrls.set(t.url, t);
    }
  }

  for (const channel of channels) {
    const url = `https://www.twitch.tv/${channel}`;
    const existing = managedTabs.get(channel);

    // Check if tab still exists
    if (existing) {
      const target = targets.find((t) => t.id === existing.targetId);
      if (target) continue; // Tab is alive
      managedTabs.delete(channel); // Tab died, recreate
    }

    // Check if there's already a tab with this URL
    const found = [...existingUrls.entries()].find(([u]) =>
      u.toLowerCase().includes(`twitch.tv/${channel.toLowerCase()}`),
    );
    if (found) {
      managedTabs.set(channel, { channel, targetId: found[1].id, wsUrl: found[1].webSocketDebuggerUrl });
      log(`  Reusing existing tab for ${channel}`);
      continue;
    }

    // Open new tab
    try {
      log(`  Opening tab for ${channel}...`);
      const target = await createTab(url);
      managedTabs.set(channel, { channel, targetId: target.id, wsUrl: target.webSocketDebuggerUrl });
      // Wait for page to start loading
      await sleep(2000);
    } catch (err) {
      log(`  ERROR opening tab for ${channel}: ${(err as Error).message}`);
    }
  }

  // Close tabs for channels no longer in the list
  for (const [channel, tab] of managedTabs) {
    if (!channels.includes(channel)) {
      try {
        await cdpGet(`/json/close/${tab.targetId}`);
        managedTabs.delete(channel);
        log(`  Closed tab for ${channel} (no longer active)`);
      } catch {}
    }
  }
}

// ── Read viewer count from a tab ───────────────────────────────────────────

async function readViewerCount(tab: ManagedTab): Promise<{ channel: string; viewers: number; isLive: boolean }> {
  const session = new CDPSession();
  try {
    // Refresh target list to get fresh wsUrl
    const targets = await getTargets();
    const target = targets.find((t) => t.id === tab.targetId);
    if (!target) {
      return { channel: tab.channel, viewers: 0, isLive: false };
    }

    await session.connect(target.webSocketDebuggerUrl);

    // Remove webdriver flag on each read (in case page navigated)
    await session.evaluate(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);

    // Extract viewer count from the page DOM
    // Twitch renders the viewer count in an element with data-a-target="animated-channel-viewers-count"
    // or in a span near the live indicator
    const result = await session.evaluate(`
      (function() {
        // Method 1: data-a-target attribute (most reliable)
        let el = document.querySelector('[data-a-target="animated-channel-viewers-count"]');
        if (el) {
          const text = el.textContent.replace(/[^0-9.KMkm]/g, '');
          return parseViewerText(text);
        }

        // Method 2: p.CoreText with viewer count near live indicator
        // Look for the viewer count text that Twitch renders
        const allText = document.querySelectorAll('p[data-a-target], span[data-a-target]');
        for (const node of allText) {
          const t = node.textContent || '';
          if (/^[\\d,.]+[KkMm]?$/.test(t.trim()) && node.closest('[class*="stream-info"]')) {
            return parseViewerText(t.trim());
          }
        }

        // Method 3: aria-label containing "viewers"
        const ariaEl = document.querySelector('[aria-label*="viewer" i]');
        if (ariaEl) {
          const match = (ariaEl.getAttribute('aria-label') || '').match(/([\\d,]+)/);
          if (match) return parseInt(match[1].replace(/,/g, ''), 10);
        }

        // Method 4: Search for viewer count pattern in live indicator area
        const liveIndicator = document.querySelector('[data-a-target="player-info-viewer-count"]');
        if (liveIndicator) {
          const text = liveIndicator.textContent || '';
          return parseViewerText(text);
        }

        // Method 5: Broadest search — find any element with "Viewers" nearby
        const spans = document.querySelectorAll('span, p');
        for (const s of spans) {
          const t = (s.textContent || '').trim();
          if (/^[\\d,.]+[KkMm]?$/.test(t)) {
            const parent = s.parentElement;
            const parentText = parent?.textContent || '';
            if (/viewer/i.test(parentText)) {
              return parseViewerText(t);
            }
          }
        }

        return 0;

        function parseViewerText(text) {
          if (!text) return 0;
          text = text.replace(/,/g, '').trim();
          const kMatch = text.match(/^([\\d.]+)[Kk]$/);
          if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
          const mMatch = text.match(/^([\\d.]+)[Mm]$/);
          if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
          const num = parseInt(text, 10);
          return isNaN(num) ? 0 : num;
        }
      })()
    `);

    const viewers = typeof result === 'number' ? result : 0;

    // Check if stream is actually live
    const isLive = await session.evaluate(`
      !!document.querySelector('[data-a-target="player-info-viewer-count"]') ||
      !!document.querySelector('[data-a-target="animated-channel-viewers-count"]') ||
      !!document.querySelector('.live-indicator') ||
      !!document.querySelector('[data-test-selector="stream-info-is-live"]') ||
      document.querySelector('video')?.readyState > 0
    `);

    session.close();
    return { channel: tab.channel, viewers, isLive: !!isLive };
  } catch (err) {
    session.close();
    log(`  ERROR reading ${tab.channel}: ${(err as Error).message}`);
    return { channel: tab.channel, viewers: 0, isLive: false };
  }
}

// ── Push results to server ─────────────────────────────────────────────────

interface ChannelResult {
  identifier: string;
  viewers: number;
}

async function pushToServer(results: ChannelResult[]): Promise<void> {
  const payload = {
    platform: 'twitch',
    channels: results,
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

// ── Main ───────────────────────────────────────────────────────────────────

async function runOnce() {
  // Ensure all tabs are open
  await ensureTabsOpen(CHANNELS);

  // Read viewer counts from all tabs
  const results: ChannelResult[] = [];
  let liveCount = 0;

  for (const [channel, tab] of managedTabs) {
    const { viewers, isLive } = await readViewerCount(tab);
    if (isLive && viewers > 0) {
      results.push({ identifier: channel, viewers });
      liveCount++;
    }
  }

  log(`${liveCount}/${managedTabs.size} live — ${results.map((r) => `${r.identifier}=${r.viewers}`).join(', ') || 'none'}`);

  // Push to server
  if (results.length > 0) {
    await pushToServer(results);
  }
}

async function main() {
  if (!RELAY_SECRET) {
    console.error('ERROR: RELAY_SECRET not set. Add it to .env or export it.');
    process.exit(1);
  }

  // Check if browser server is running
  if (!fs.existsSync(CDP_FILE)) {
    console.error('ERROR: Browser server not running. Start it first:');
    console.error('  npx tsx scripts/twitch-browser-server.ts');
    process.exit(1);
  }

  // Verify CDP connection
  try {
    const targets = await getTargets();
    log(`Connected to Chrome (${targets.length} existing tabs)`);
  } catch {
    console.error('ERROR: Cannot connect to Chrome on port ' + CDP_PORT);
    console.error('Make sure twitch-browser-server.ts is running.');
    process.exit(1);
  }

  log(`Twitch Browser Scraper → ${RELAY_URL}`);
  log(`Mode: ${LOOP_MODE ? 'continuous loop (60s)' : 'single run'}`);

  if (LOOP_MODE) {
    // Initial setup — open all tabs with staggered loading
    log(`Opening ${CHANNELS.length} channel tabs...`);
    await ensureTabsOpen(CHANNELS);
    log(`All tabs open. Waiting 10s for pages to load...`);
    await sleep(10_000);

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
