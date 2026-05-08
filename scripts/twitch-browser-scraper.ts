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

// Optional client-side channel cap. The server returns up to 20 (officials +
// top CCV); on weaker hardware (e.g. 2019 Intel MBP) running 20 simultaneous
// Twitch tabs is too much for the GPU/CPU even with video paused. Set
// MAX_CHANNELS=8 in .env to take only the top 8 from the server's list.
const MAX_CHANNELS = parseInt(process.env.MAX_CHANNELS || '0', 10) || Infinity;

// Channel list is fetched from the server API (officials + top CCV, max 20).
// Refreshes every 5 minutes. No local config needed — just add channels in the tool.
let CHANNELS: string[] = [];
const CHANNEL_REFRESH_MS = 5 * 60_000;
let lastChannelFetch = 0;

async function refreshChannelList(): Promise<void> {
  if (Date.now() - lastChannelFetch < CHANNEL_REFRESH_MS && CHANNELS.length > 0) return;

  try {
    const res = await fetch(`${RELAY_URL}/api/relay/twitch/browser-channels`, {
      headers: { Authorization: `Bearer ${RELAY_SECRET}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = (await res.json()) as { channels: string[] };
    // pubg_battlegrounds was previously hard-filtered out because the
    // single-stream extractor read the COMBINED viewer count from the
    // cohost badge. The new cohost-aware extractor (readViewerCount)
    // matches the per-channel slice by URL slug, so the filter is no
    // longer needed.
    let channels = data.channels;
    if (Number.isFinite(MAX_CHANNELS) && channels.length > MAX_CHANNELS) {
      log(`Capping channel list at MAX_CHANNELS=${MAX_CHANNELS} (server returned ${channels.length})`);
      channels = channels.slice(0, MAX_CHANNELS);
    }
    CHANNELS = channels;
    lastChannelFetch = Date.now();
    log(`Channel list refreshed: ${CHANNELS.length} channels (officials + top CCV, max 20${Number.isFinite(MAX_CHANNELS) ? `, cap ${MAX_CHANNELS}` : ''})`);
  } catch (err) {
    log(`Could not fetch channel list: ${(err as Error).message}`);
    // Keep existing list if refresh fails
  }
}

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
  return new Promise((resolve, reject) => {
    const reqUrl = `http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(url)}`;
    const req = http.request(reqUrl, { method: 'PUT' }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
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
const tabLastReload = new Map<string, number>();

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

    // Check if the tab is still on the correct channel page (Twitch SPA can redirect to homepage)
    const currentUrl = await session.evaluate(`location.href`) as string;
    if (!currentUrl?.toLowerCase().includes(tab.channel.toLowerCase())) {
      log(`  ${tab.channel}: tab navigated away (${currentUrl?.slice(0, 50)}), reloading...`);
      await session.send('Page.navigate', { url: `https://www.twitch.tv/${tab.channel}` });
      session.close();
      return { channel: tab.channel, viewers: 0, isLive: false };
    }

    // First check if the stream is actually live — avoid reading stale/wrong numbers from offline pages
    const isLive = await session.evaluate(`
      (function() {
        // Look for the live indicator (red LIVE badge)
        if (document.querySelector('[data-a-target="animated-channel-viewers-count"]')) return true;
        if (document.querySelector('[data-a-target="player-info-viewer-count"]')) return true;
        if (document.querySelector('.live-indicator-container')) return true;
        if (document.querySelector('[data-test-selector="stream-info-is-live"]')) return true;
        // Check for "LIVE" text badge in the player
        const badges = document.querySelectorAll('[data-a-target="player-info-tag-text"]');
        for (const b of badges) {
          if ((b.textContent || '').trim().toUpperCase() === 'LIVE') return true;
        }
        return false;
      })()
    `);

    if (!isLive) {
      // Reload the page every 5 minutes for offline tabs — the channel might have gone live
      // but the stale SPA page won't show it
      const lastReload = tabLastReload.get(tab.channel) ?? 0;
      if (Date.now() - lastReload > 5 * 60_000) {
        log(`  ${tab.channel}: not live, refreshing page...`);
        await session.send('Page.reload', {});
        tabLastReload.set(tab.channel, Date.now());
      }
      session.close();
      return { channel: tab.channel, viewers: 0, isLive: false };
    }

    // Stream is confirmed live — extract viewer count from the DOM.
    //
    // Cohost-aware extractor. The default Twitch player badge (the
    // [data-a-target="animated-channel-viewers-count"] element) shows
    // the COMBINED viewer count across all cohosts when a stream is
    // cohosted (e.g. pubg_battlegrounds + pubg_br). We need just the
    // page-owner streamer's slice — i.e. only the count for the
    // channel whose URL we're on.
    //
    // Strategy:
    //   1. Read the combined badge (legacy single value, used as
    //      fallback and for cohost detection).
    //   2. Walk the DOM for an <a href="/{slug}"> matching the URL
    //      channel slug, find a number-like sibling. If found and
    //      different from the combined badge, that's the per-cohost
    //      slice. Works whether the popover is open or not — Twitch
    //      typically renders cohost rows in the DOM regardless.
    //   3. If no match without clicking, programmatically click the
    //      popover trigger near the badge, wait briefly, retry.
    //   4. Return both numbers + a flag so we can log which path won.
    //
    // The eval returns a Promise (Runtime.evaluate is called with
    // awaitPromise:true) so we can use setTimeout for the popover wait.
    const result = (await session.evaluate(`
      (async () => {
        function parseViewerText(text) {
          if (!text) return 0;
          text = String(text).replace(/[\\s,]/g, '').trim();
          const kMatch = text.match(/^([\\d.]+)[Kk]$/);
          if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
          const mMatch = text.match(/^([\\d.]+)[Mm]$/);
          if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
          const num = parseInt(text, 10);
          return isNaN(num) ? 0 : num;
        }
        function readBadge() {
          const el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
                  || document.querySelector('[data-a-target="player-info-viewer-count"]');
          if (el) {
            const t = (el.textContent || '').replace(/[^0-9.KMkm]/g, '');
            return { el: el, value: parseViewerText(t) };
          }
          const aria = document.querySelector('[aria-label*="viewer" i]');
          if (aria) {
            const m = (aria.getAttribute('aria-label') || '').match(/([\\d,]+)/);
            if (m) return { el: aria, value: parseInt(m[1].replace(/,/g, ''), 10) };
          }
          return { el: null, value: 0 };
        }

        // Find the per-cohost row in the popover for the URL slug.
        // The previous version walked too far up the parent tree, so
        // it kept matching the page chrome that contains the COMBINED
        // badge. New heuristic: only accept a candidate row whose
        // ancestor text is SHORT (a cohost row reads as "PUBG_BATTLEGROUNDS 639"
        // — a few dozen chars at most), not the whole player chrome.
        //
        // Returns { value, debug } so we can dump diagnostics from the
        // outer log on misses.
        function findSlugRow(slug, combined) {
          if (!slug) return { value: null, debug: { reason: 'no-slug' } };
          const links = Array.from(document.querySelectorAll(
            \`a[href="/\${slug}" i], a[href="/\${slug}/" i]\`,
          ));
          const tries = [];
          for (const a of links) {
            // Walk up just 1–3 levels; cohost rows have the number
            // close to the link.
            let p = a.parentElement;
            for (let depth = 1; depth <= 3 && p; depth++, p = p.parentElement) {
              const ancestorText = (p.textContent || '').trim();
              // Reject sprawling containers — cohost row text is
              // short. Tweak ceiling cautiously: PUBG_BATTLEGROUNDS is
              // 19 chars, plus number, plus a few separators.
              if (ancestorText.length > 80) continue;
              // Reject if the ancestor's text doesn't contain the
              // slug — defensive against unrelated link matches.
              if (!ancestorText.toLowerCase().includes(slug.toLowerCase())) continue;
              const numberish = Array.from(p.querySelectorAll('*'))
                .map(e => (e.textContent || '').trim())
                .filter(t => /^[\\d,.]+[KMkm]?$/.test(t) && t.length < 12);
              if (numberish.length === 0) continue;
              // Pick the smallest matching number (the cohost slice
              // is by definition ≤ combined). Skip exact matches with
              // combined — those are likely the badge, not the row.
              const parsed = numberish.map(parseViewerText).filter(n => n > 0);
              const candidates = parsed.filter(n => n !== combined);
              const pick = candidates.length > 0 ? Math.min(...candidates) : parsed[0];
              tries.push({ depth: depth, text: ancestorText.slice(0, 100), numbers: numberish, pick: pick });
              if (candidates.length > 0) {
                return { value: pick, debug: { tries: tries } };
              }
            }
          }
          return { value: null, debug: { tries: tries, linkCount: links.length } };
        }

        const slug = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
        const badge = readBadge();
        const combined = badge.value;

        // Strategy 1: try without clicking — many Twitch UIs render
        // cohost rows in the DOM even when the popover is collapsed.
        let attempt = findSlugRow(slug, combined);
        let path = attempt.value !== null ? 'dom-direct' : null;

        // Strategy 2: click the popover trigger and retry.
        let triggerInfo = null;
        if (attempt.value === null && badge.el) {
          const trigger =
            badge.el.closest('button[aria-haspopup]') ||
            badge.el.closest('button[aria-expanded]') ||
            badge.el.closest('button, [role="button"]') ||
            badge.el.parentElement?.querySelector('button, [role="button"]');
          triggerInfo = {
            found: !!trigger,
            tag: trigger?.tagName,
            target: trigger?.getAttribute?.('data-a-target'),
            haspopup: trigger?.getAttribute?.('aria-haspopup'),
          };
          if (trigger) {
            try { trigger.click(); } catch (_e) {}
            await new Promise(r => setTimeout(r, 700));
            attempt = findSlugRow(slug, combined);
            if (attempt.value !== null) path = 'dom-after-click';
            try { trigger.click(); } catch (_e) {} // close popover
          }
        }

        const perCohost = attempt.value;
        const isCohost = perCohost !== null && perCohost !== combined;
        const viewers = isCohost ? perCohost : combined;
        return {
          viewers: viewers,
          combined: combined,
          perCohost: perCohost,
          isCohost: isCohost,
          slug: slug,
          path: path,
          debug: { trigger: triggerInfo, tries: attempt.debug?.tries || [], linkCount: attempt.debug?.linkCount },
        };
      })()
    `)) as {
      viewers: number;
      combined: number;
      perCohost: number | null;
      isCohost: boolean;
      slug: string;
      path: string | null;
      debug: {
        trigger: { found: boolean; tag?: string; target?: string; haspopup?: string } | null;
        tries: Array<{ depth: number; text: string; numbers: string[]; pick: number }>;
        linkCount?: number;
      };
    };

    const viewers = typeof result?.viewers === 'number' ? result.viewers : 0;
    if (result?.isCohost) {
      log(`  ${tab.channel}: cohost detected — combined=${result.combined}, slice=${result.perCohost} (path: ${result.path})`);
    } else if (process.env.COHOST_DEBUG === '1' && result?.combined > 0) {
      // Verbose path when the user is iterating. Logs every cycle so
      // we can see why the slug match isn't hitting on a cohost page.
      log(`  ${tab.channel}: cohost-debug combined=${result.combined} perCohost=${result.perCohost} path=${result.path} linkCount=${result.debug?.linkCount}`);
      log(`    trigger=${JSON.stringify(result.debug?.trigger)}`);
      for (const t of (result.debug?.tries ?? []).slice(0, 5)) {
        log(`    try depth=${t.depth} pick=${t.pick} numbers=${JSON.stringify(t.numbers)} text=${JSON.stringify(t.text)}`);
      }
    }

    // Tame the tab — pause any <video>, force the lowest quality preset,
    // mute. Done on every read so it survives Twitch's React re-renders.
    // The viewer-count DOM is updated by Twitch's GraphQL polling
    // independent of video playback, so pausing doesn't affect accuracy.
    // Critical on older Macs (e.g. 2019 Intel MBP) where 10-20 simultaneous
    // streaming tabs would otherwise saturate the GPU and thermal-throttle.
    await session.evaluate(`
      (function() {
        try {
          // Force Twitch to pick the lowest quality on next stream load.
          // Twitch reads this localStorage key on player init.
          const cur = JSON.parse(localStorage.getItem('video-quality') || '{}');
          cur.default = '160p30';
          localStorage.setItem('video-quality', JSON.stringify(cur));
        } catch (_e) {}

        // Pause any current <video> element + mute. Twitch may recreate
        // the player on tab focus, which is why we re-run every cycle.
        for (const v of document.querySelectorAll('video')) {
          try {
            v.muted = true;
            v.pause();
            v.preload = 'none';
          } catch (_e) {}
        }
      })()
    `);

    session.close();
    return { channel: tab.channel, viewers, isLive: true };
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
  // Refresh channel list from server
  await refreshChannelList();
  if (CHANNELS.length === 0) {
    log('No channels to track — waiting for next refresh');
    return;
  }

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
    // Initial setup — fetch channel list and open tabs
    await refreshChannelList();
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
