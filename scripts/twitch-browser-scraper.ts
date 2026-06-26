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

// Channel list is fetched from the server API (officials + top CCV,
// capped server-side by BROWSER_CHANNELS_LIMIT, default 20).
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
    // pubg_battlegrounds is excluded from browser scraping BY DEFAULT
    // because of Twitch's cohost feature ("Stream Together"): during
    // PAS / PEC / PNC broadcasts its page badge shows the COMBINED total
    // across all co-streamers, not its own slice. v1–v5 DOM extractors
    // failed (matched localized display names against the login, gated
    // on the obsolete "Main Broadcast" marker, picked Math.min). With no
    // reliable extractor it defers to server-side Helix — stepped 3–5
    // min but correct per-channel.
    //
    // The v6 extractor (readViewerCount, Shared-Viewership popover via
    // href) is now in place. To ACTIVATE it, add pubg_battlegrounds AND
    // every co-streamer to COHOST_CHANNELS — that both lets the channel
    // back into the scrape list here AND makes readViewerCount read the
    // per-channel slice (or abstain to Helix), never the combined badge.
    // With COHOST_CHANNELS unset, behaviour is identical to before.
    // See docs/plans/2026-05-09-twitch-cohost-per-channel-graphql.md
    const cohostAllow = (process.env.COHOST_CHANNELS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    let channels = data.channels.filter(
      (c) =>
        c.toLowerCase() !== 'pubg_battlegrounds' ||
        cohostAllow.includes('pubg_battlegrounds'),
    );
    if (Number.isFinite(MAX_CHANNELS) && channels.length > MAX_CHANNELS) {
      log(`Capping channel list at MAX_CHANNELS=${MAX_CHANNELS} (server returned ${channels.length})`);
      channels = channels.slice(0, MAX_CHANNELS);
    }
    CHANNELS = channels;
    lastChannelFetch = Date.now();
    log(`Channel list refreshed: ${CHANNELS.length} channels (officials + top CCV, server-capped via BROWSER_CHANNELS_LIMIT${Number.isFinite(MAX_CHANNELS) ? `, local cap ${MAX_CHANNELS}` : ''})${CHANNELS.length === 0 ? ' — 0 is normal when no broadcast is live' : ''}`);
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

  // Dispatch a REAL (trusted) left click at viewport coords. Twitch
  // ignores a synthetic element.click() for the Shared Viewership popover,
  // so the cohost extractor opens it this way instead.
  async realClick(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // Press Escape — closes the popover after we've read it.
  async pressEscape(): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
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
    // ── Cohost-aware extractor (v6) ───────────────────────────────────
    //
    // During Twitch "Stream Together", the player viewer badge shows the
    // COMBINED total across all co-streamers. The per-channel breakdown
    // lives in the "Shared Viewership" popover, opened by clicking the
    // badge. v1–v5 failed because they matched the channel LOGIN as DOM
    // text (e.g. "kr1stw") against the popover's LOCALIZED display names
    // (e.g. "西南69"), gated on the obsolete "Main Broadcast" marker, and
    // picked Math.min of row numbers (returning a co-streamer's count).
    //
    // v6 fixes all three:
    //   • detect cohost by whether a "Total Viewers" / "Shared
    //     Viewership" popover actually opens (not a text marker);
    //   • map each popover row by its <a href="/{login}"> anchor — the
    //     canonical login, independent of localized glyphs — never text;
    //   • for the page-owner's slug, derive an exact value as
    //     total − Σ(other rows) ONLY when every other row is exact
    //     (a rounded "4.6K" other would inject its own ±50 error);
    //   • NEVER write the combined badge for a cohosting channel. If we
    //     can't extract a confident per-channel slice, return 0 so the
    //     server-side Helix base row (correct, stepped) carries the tick.
    //
    // Only allowlisted channels (COHOST_CHANNELS / the is_cohosted
    // roster) run this path; every other channel uses the plain badge.
    //   COHOST_CHANNELS=pubg_battlegrounds,kr1stw,pubg_taiwan,pubgjapan
    const cohostAllowList = (process.env.COHOST_CHANNELS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const cohostEnabled = cohostAllowList.includes(tab.channel.toLowerCase());
    const slug = tab.channel.toLowerCase();

    // ── Cohost-aware extractor (v7) ───────────────────────────────────
    //
    // Stream Together shows the COMBINED total in the player badge; the
    // per-channel breakdown lives in the "Shared Viewership" popover.
    // CONFIRMED against the live DOM: that popover only opens on a REAL
    // (trusted) mouse click — Twitch ignores a synthetic element.click()
    // — which is why v6 (synthetic click) never opened it and always
    // abstained. v7 opens it with a CDP Input.dispatchMouseEvent at the
    // badge's coordinates, then maps each row by its <a href="/{login}">
    // anchor and takes the page-owner's slug row. If anything is off it
    // ABSTAINS (returns 0) so the server poll carries — it NEVER writes
    // the combined badge for a cohost channel. Only COHOST_CHANNELS run
    // this path; everything else uses the plain badge.

    // Shared in-page helpers for both extraction steps.
    const PRELUDE = `
      function parseCount(text) {
        if (text == null) return { value: 0, rounded: false };
        const s = String(text).trim().replace(/[,\\s]/g, '');
        const m = s.match(/^([0-9]*\\.?[0-9]+)([KkMm]?)/);
        if (!m) return { value: 0, rounded: false };
        const num = parseFloat(m[1]);
        if (isNaN(num)) return { value: 0, rounded: false };
        const unit = m[2].toUpperCase();
        if (unit === 'K') return { value: Math.round(num * 1000), rounded: true };
        if (unit === 'M') return { value: Math.round(num * 1000000), rounded: true };
        return { value: Math.round(num), rounded: false };
      }
      function loginFromHref(href) {
        if (!href) return null;
        let h = href;
        try { h = decodeURIComponent(h); } catch (e) {}
        const m = h.match(/^\\/([a-zA-Z0-9_]{2,25})\\/?$/);
        return m ? m[1].toLowerCase() : null;
      }
      function readBadge() {
        const el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
                || document.querySelector('[data-a-target="player-info-viewer-count"]');
        return el ? parseCount(el.textContent).value : 0;
      }
      function findPopover(slug) {
        // Language-agnostic: the Shared Viewership popover is a small
        // container of 2-12 channel rows (each <a href="/login"> + number)
        // that INCLUDES the page-owner's own row (slug). The sidebar lists
        // OTHER channels, not the current one, so requiring the slug be
        // present distinguishes the popover — and avoids depending on the
        // localized "Total Viewers" header (the relay UI may be in Swedish
        // etc.). Climb from the slug's own anchor to the smallest
        // container that holds the participant list.
        const slugAnchors = Array.from(document.querySelectorAll('a[href]'))
          .filter((a) => loginFromHref(a.getAttribute('href')) === slug);
        for (const sa of slugAnchors) {
          let node = sa.parentElement;
          for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
            let chCount = 0;
            for (const a of node.querySelectorAll('a[href]')) {
              if (loginFromHref(a.getAttribute('href'))) chCount++;
            }
            if (chCount >= 2 && chCount <= 12) {
              const rows = parseRows(node);
              if (rows.length >= 2 && rows.some((r) => r.login === slug)) return node;
            }
          }
        }
        return null;
      }
      function parseRows(root) {
        const rows = [];
        const seen = new Set();
        for (const a of Array.from(root.querySelectorAll('a[href]'))) {
          const login = loginFromHref(a.getAttribute('href'));
          if (!login || seen.has(login)) continue;
          let node = a;
          for (let d = 0; d < 4 && node; d++, node = node.parentElement) {
            const txt = (node.textContent || '').trim();
            if (!txt || txt.length > 80) continue;
            const m = txt.match(/([0-9][0-9.,]*\\s*[KkMm]?)\\s*$/);
            if (!m) continue;
            const c = parseCount(m[1]);
            if (c.value <= 0) continue;
            seen.add(login);
            rows.push({ login: login, value: c.value, rounded: c.rounded });
            break;
          }
        }
        return rows;
      }
    `;

    // Step 1: read the badge value + the badge's centre coordinates.
    const badgeInfo = (await session.evaluate(`
      (function () {
        ${PRELUDE}
        const combined = readBadge();
        const el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
                || document.querySelector('[data-a-target="player-info-viewer-count"]');
        if (!el) return { combined: combined, coords: null, chain: [] };
        // Ancestor chain — to find the real dropdown trigger.
        const chain = [];
        let n = el;
        for (let d = 0; d < 8 && n; d++, n = n.parentElement) {
          chain.push({
            tag: n.tagName,
            role: n.getAttribute('role'),
            haspopup: n.getAttribute('aria-haspopup'),
            expanded: n.getAttribute('aria-expanded'),
            target: n.getAttribute('data-a-target'),
          });
        }
        // Click the nearest interactive dropdown trigger, not just the number.
        const trig = el.closest('[aria-haspopup],[aria-expanded],button,[role="button"]') || el;
        const r = trig.getBoundingClientRect();
        return {
          combined: combined,
          coords: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
          chain: chain,
          triggerTag: trig.tagName,
          triggerHaspopup: trig.getAttribute('aria-haspopup'),
        };
      })()
    `)) as {
      combined: number;
      coords: { x: number; y: number } | null;
      chain?: unknown[];
      triggerTag?: string;
      triggerHaspopup?: string | null;
    };

    const combined = badgeInfo?.combined ?? 0;

    interface CohostResult {
      mode: string;
      viewers: number;
      combined: number;
      rows: Array<{ login: string; value: number; rounded: boolean }>;
      method?: string;
      computed?: number;
      diag?: unknown;
    }
    let result: CohostResult;
    let elementAtClick: unknown = null;

    if (!cohostEnabled) {
      // Non-cohost channel: the badge IS its correct per-channel value.
      result = { mode: 'disabled', viewers: combined, combined, rows: [] };
    } else if (!badgeInfo?.coords) {
      result = { mode: 'cohost-no-badge', viewers: 0, combined, rows: [] };
    } else {
      const coords = badgeInfo.coords;
      // Step 2: bring the tab forward + hover + REAL trusted click on the
      // dropdown trigger. CDP clicks don't reliably reach Twitch's React
      // handler on a BACKGROUNDED tab, so foreground it first.
      await session.send('Page.bringToFront').catch(() => {});
      await sleep(300);
      await session
        .send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y })
        .catch(() => {});
      await sleep(250);
      await session.realClick(coords.x, coords.y);
      await sleep(900);

      // What's actually under the click point — confirms we hit the trigger.
      elementAtClick = await session.evaluate(`
        (function () {
          const e = document.elementFromPoint(${coords.x}, ${coords.y});
          return e ? { tag: e.tagName, target: e.getAttribute('data-a-target'), role: e.getAttribute('role'), cls: (e.className || '').toString().slice(0, 70) } : null;
        })()
      `);

      // Step 3: parse the popover and compute this channel's slice.
      result = (await session.evaluate(`
        (function () {
          ${PRELUDE}
          const SLUG = ${JSON.stringify(slug)};
          const combined = readBadge();

          // ── diagnostics (always computed, so failures are explainable) ──
          const bodyText = document.body.innerText || '';
          const allAnchors = [];
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const login = loginFromHref(a.getAttribute('href'));
            if (!login) continue;
            let node = a, num = null;
            for (let d = 0; d < 4 && node; d++, node = node.parentElement) {
              const txt = (node.textContent || '').trim();
              const nm = txt.match(/([0-9][0-9.,]*\\s*[KkMm]?)\\s*$/);
              if (nm) { num = nm[1]; break; }
            }
            allAnchors.push({ login: login, num: num });
          }
          const diag = {
            bodyHasShared: /Shared Viewership|Total Viewers/i.test(bodyText),
            globalAnchorCount: allAnchors.length,
            anchorsWithNum: allAnchors.filter((a) => a.num != null).slice(0, 12),
            slugInAnchors: allAnchors.some((a) => a.login === SLUG),
            haspopupEls: Array.from(document.querySelectorAll('[aria-haspopup]')).slice(0, 12).map((e) => ({ tag: e.tagName, target: e.getAttribute('data-a-target'), text: (e.textContent || '').trim().slice(0, 24) })),
            viewerTargets: Array.from(document.querySelectorAll('[data-a-target]')).map((e) => e.getAttribute('data-a-target')).filter((t) => t && /view|shared|together|multi|cohost/i.test(t)).slice(0, 15),
            countTree: (function () {
              // Dump the viewer-count badge's container subtree to locate the
              // real Stream Together dropdown trigger (chevron / button).
              var vc = document.querySelector('[data-a-target="animated-channel-viewers-count"]');
              if (!vc) return null;
              var box = vc;
              for (var k = 0; k < 4 && box.parentElement; k++) box = box.parentElement;
              return Array.from(box.querySelectorAll('*')).slice(0, 60).map(function (e) {
                var r = e.getBoundingClientRect();
                return {
                  tag: e.tagName,
                  cls: (e.className || '').toString().slice(0, 36),
                  tgt: e.getAttribute('data-a-target'),
                  role: e.getAttribute('role'),
                  hp: e.getAttribute('aria-haspopup'),
                  exp: e.getAttribute('aria-expanded'),
                  lbl: (e.getAttribute('aria-label') || '').slice(0, 28),
                  svg: !!e.querySelector(':scope > svg'),
                  txt: (e.textContent || '').trim().slice(0, 16),
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2),
                };
              });
            })(),
          };

          const popover = findPopover(SLUG);
          diag.popoverFound = !!popover;
          if (!popover) return { mode: 'cohost-no-popover', viewers: 0, combined: combined, rows: [], diag: diag };
          const rows = parseRows(popover);
          diag.popoverRows = rows.map((r) => ({ login: r.login, value: r.value, rounded: r.rounded }));
          const mine = rows.find((r) => r.login === SLUG);
          const others = rows.filter((r) => r.login !== SLUG);
          if (!mine || rows.length < 2) return { mode: 'cohost-unresolved', viewers: 0, combined: combined, rows: rows, diag: diag };
          let value = mine.value;
          let method = mine.rounded ? 'rounded-direct' : 'exact-direct';
          const roundedOthers = others.filter((o) => o.rounded).length;
          const sumOthers = others.reduce((s, o) => s + o.value, 0);
          if (mine.rounded && combined > 0 && roundedOthers === 0) { value = combined - sumOthers; method = 'subtraction-exact'; }
          const sane = value > 0 && (combined === 0 || value <= combined) && value < 500000;
          if (!sane) return { mode: 'cohost-insane', viewers: 0, combined: combined, rows: rows, method: method, computed: value, diag: diag };
          return { mode: 'cohost', viewers: value, combined: combined, rows: rows, method: method, diag: diag };
        })()
      `)) as CohostResult;

      // Debug: screenshot the post-click state so we can SEE the layout
      // and where the real Stream Together dropdown actually is.
      try {
        // jpeg (not png): a 1600x900 png base64 is ~1-2MB and was silently
        // failing the CDP send; jpeg q55 is ~200KB and reliable. Report the
        // error into the debug sink instead of swallowing it.
        const shot = (await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })) as { data?: string };
        if (shot?.data) void postCohostDebug(`shot-${tab.channel}`, { jpeg_base64: shot.data });
        else void postCohostDebug(`shot-${tab.channel}`, { screenshot_error: 'no data field in result' });
      } catch (e) {
        void postCohostDebug(`shot-${tab.channel}`, { screenshot_error: (e as Error)?.message || String(e) });
      }

      // Step 4: close the popover so it doesn't linger over the player.
      await session.pressEscape();
    }

    const viewers = typeof result?.viewers === 'number' ? result.viewers : 0;
    const rowsStr = (result?.rows ?? [])
      .map((r) => `${r.login}:${r.value}${r.rounded ? '~' : ''}`)
      .join(',');
    if (result?.mode === 'cohost') {
      log(`  ${tab.channel}: cohost slice=${result.viewers} (combined=${result.combined}, method=${result.method}, rows=${rowsStr})`);
    } else if (
      result?.mode === 'cohost-unresolved' ||
      result?.mode === 'cohost-insane' ||
      result?.mode === 'cohost-no-popover'
    ) {
      log(`  ${tab.channel}: cohost extract FAILED (${result.mode}) — abstaining, server poll carries. combined=${result.combined} rows=${rowsStr || 'none'}`);
    } else if (process.env.COHOST_DEBUG === '1' && cohostEnabled) {
      log(`  ${tab.channel}: cohost-debug mode=${result.mode} viewers=${result.viewers} combined=${result.combined} rows=${rowsStr || 'none'}`);
    }

    // Ship cohost diagnostics to the server — one file per channel,
    // overwritten each cycle, so the current state is readable via SSH
    // (/tmp/cvt-debug/cohost-<channel>.json) without the PC console.
    if (cohostEnabled) {
      void postCohostDebug(tab.channel, {
        mode: result.mode,
        coords: badgeInfo?.coords ?? null,
        combined,
        viewers: result.viewers,
        method: result.method,
        diag: result.diag,
        chain: badgeInfo?.chain,
        triggerTag: badgeInfo?.triggerTag,
        triggerHaspopup: badgeInfo?.triggerHaspopup,
        elementAtClick,
      });
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

// Best-effort diagnostic push for cohost channels. Writes one file per
// channel on the server (label=cohost-<channel>), overwritten each cycle,
// so the latest extraction state is readable via SSH while we tune the
// extractor. Never throws — diagnostics must not affect scraping.
async function postCohostDebug(channel: string, payload: unknown): Promise<void> {
  if (!RELAY_SECRET) return;
  const label = `cohost-${channel.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
  try {
    await fetch(`${RELAY_URL}/api/relay/twitch/debug?label=${label}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SECRET}`,
      },
      body: JSON.stringify({ channel, at: new Date().toISOString(), ...(payload as object) }),
    });
  } catch {
    /* ignore — diagnostics are best-effort */
  }
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
