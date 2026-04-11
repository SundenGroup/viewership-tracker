/**
 * Self-hosted TikTok Live client — connects to TikTok live streams
 * without any external signing service (no Euler dependency).
 *
 * Uses the persistent Chrome browser (CDP port 9224) to:
 * 1. Load the TikTok live page → TikTok's own SDK handles auth/signing
 * 2. Extract viewer count from the page DOM (same approach as YouTube scraper)
 * 3. Optionally intercept the WebSocket URL from network traffic
 *
 * This is a simpler approach than reverse-engineering signatures:
 * instead of signing API calls ourselves, we let TikTok's own JavaScript
 * do it inside a real browser, and just read the viewer count from the DOM.
 *
 * Same pattern as the Twitch browser scraper — no API, just DOM reading.
 */

import * as http from 'http';

const CDP_PORT = 9224;

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

// ── CDP helpers ──────────────────────────────────────────────────────────

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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout'));
        }
      }, 15000);
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

async function cdpRequest(path: string, method: string = 'GET'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${CDP_PORT}${path}`, { method }, (res) => {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── TikTok Live Channel ──────────────────────────────────────────────────

export interface TikTokLiveChannel {
  username: string;
  displayName: string;
  viewers: number;
  isLive: boolean;
  title: string | null;
  tabId: string | null;
}

/**
 * TikTokBrowserClient — reads TikTok live viewer counts using Chrome tabs.
 *
 * Opens a Chrome tab per TikTok channel (like the Twitch browser scraper),
 * navigates to the live page, and reads the viewer count from the DOM.
 * TikTok's own JavaScript handles all signing/auth internally.
 *
 * No external API, no signing service, no reverse engineering needed.
 */
export class TikTokBrowserClient {
  private tabs = new Map<string, { tabId: string; username: string; displayName: string }>();
  private tabLastReload = new Map<string, number>();

  /**
   * Open a TikTok live tab for a channel.
   */
  async openChannel(username: string, displayName: string): Promise<void> {
    const clean = username.replace(/^@/, '');
    if (this.tabs.has(clean)) return;

    try {
      // Check for existing TikTok tab
      const targets = await cdpRequest('/json') as CDPTarget[];
      const existing = targets.find((t) =>
        t.type === 'page' && t.url.toLowerCase().includes(`tiktok.com/@${clean.toLowerCase()}`),
      );

      if (existing) {
        this.tabs.set(clean, { tabId: existing.id, username: clean, displayName });
        return;
      }

      // Open new tab
      const url = `https://www.tiktok.com/@${clean}/live`;
      const target = await cdpRequest(`/json/new?${encodeURIComponent(url)}`, 'PUT') as CDPTarget;
      this.tabs.set(clean, { tabId: target.id, username: clean, displayName });
      await sleep(3000); // Wait for page to load
    } catch (err) {
      throw new Error(`Failed to open tab for ${clean}: ${(err as Error).message}`);
    }
  }

  /**
   * Read the viewer count from a TikTok live tab.
   */
  async readViewerCount(username: string): Promise<TikTokLiveChannel> {
    const clean = username.replace(/^@/, '');
    const tab = this.tabs.get(clean);

    const offline: TikTokLiveChannel = {
      username: clean,
      displayName: tab?.displayName ?? clean,
      viewers: 0,
      isLive: false,
      title: null,
      tabId: tab?.tabId ?? null,
    };

    if (!tab) return offline;

    const session = new CDPSession();
    try {
      const targets = await cdpRequest('/json') as CDPTarget[];
      const target = targets.find((t) => t.id === tab.tabId);
      if (!target) {
        this.tabs.delete(clean);
        return offline;
      }

      // Check if tab navigated away
      if (!target.url.toLowerCase().includes(clean.toLowerCase())) {
        await session.connect(target.webSocketDebuggerUrl);
        await session.send('Page.navigate', { url: `https://www.tiktok.com/@${clean}/live` });
        session.close();
        return offline;
      }

      await session.connect(target.webSocketDebuggerUrl);

      // Hide webdriver
      await session.evaluate(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);

      // Extract data from the TikTok live page
      const result = await session.evaluate(`
        (function() {
          // Method 1: Check for live status via liveRoomUserInfo in the page data
          // TikTok SPA stores room data in various DOM elements

          // Try to find viewer count from the DOM
          // The live page shows "X viewers" near the top
          const viewerEls = document.querySelectorAll('[data-e2e="live-viewer-count"], [class*="viewer-count"], [class*="viewerCount"]');
          for (const el of viewerEls) {
            const text = (el.textContent || '').replace(/[^0-9]/g, '');
            if (text && parseInt(text) > 0) {
              return JSON.stringify({ isLive: true, viewers: parseInt(text), method: 'dom-viewer-count' });
            }
          }

          // Method 2: Check for userCount in the embedded JSON data
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.includes('userCount') && text.includes('liveRoomStats')) {
              const match = text.match(/"userCount"\\s*:\\s*(\\d+)/);
              if (match) {
                return JSON.stringify({ isLive: true, viewers: parseInt(match[1]), method: 'json-userCount' });
              }
            }
          }

          // Method 3: Search all text for viewer patterns
          const allText = document.body?.innerText || '';
          const viewerMatch = allText.match(/(\\d[\\d,.]*[KkMm]?)\\s*(?:viewer|watching)/i);
          if (viewerMatch) {
            let num = viewerMatch[1].replace(/,/g, '');
            if (num.match(/[Kk]$/)) num = String(Math.round(parseFloat(num) * 1000));
            if (num.match(/[Mm]$/)) num = String(Math.round(parseFloat(num) * 1000000));
            const viewers = parseInt(num);
            if (viewers > 0) {
              return JSON.stringify({ isLive: true, viewers, method: 'text-pattern' });
            }
          }

          // Method 4: Check if the page has a live indicator
          const hasLive = document.querySelector('[class*="live-indicator"], [class*="LiveBadge"]');
          const hasVideo = document.querySelector('video');
          if (hasLive || (hasVideo && hasVideo.readyState > 0)) {
            // Live but can't find viewer count
            return JSON.stringify({ isLive: true, viewers: 0, method: 'live-no-count' });
          }

          // Check if page shows "LIVE has ended" or offline state
          if (allText.includes('LIVE has ended') || allText.includes('offline')) {
            return JSON.stringify({ isLive: false, viewers: 0, method: 'offline-text' });
          }

          return JSON.stringify({ isLive: false, viewers: 0, method: 'no-indicators' });
        })()
      `) as string;

      const parsed = JSON.parse(result as string);

      // Periodically reload offline tabs
      if (!parsed.isLive) {
        const lastReload = this.tabLastReload.get(clean) ?? 0;
        if (Date.now() - lastReload > 5 * 60_000) {
          await session.send('Page.reload', {});
          this.tabLastReload.set(clean, Date.now());
        }
      }

      session.close();

      return {
        username: clean,
        displayName: tab.displayName,
        viewers: parsed.viewers,
        isLive: parsed.isLive,
        title: null,
        tabId: tab.tabId,
      };
    } catch (err) {
      session.close();
      return offline;
    }
  }

  /**
   * Close a TikTok tab.
   */
  async closeChannel(username: string): Promise<void> {
    const clean = username.replace(/^@/, '');
    const tab = this.tabs.get(clean);
    if (tab) {
      try {
        await cdpRequest(`/json/close/${tab.tabId}`, 'GET');
      } catch {}
      this.tabs.delete(clean);
    }
  }

  /**
   * Get all tracked channels.
   */
  getChannels(): string[] {
    return [...this.tabs.keys()];
  }
}
