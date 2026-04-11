/**
 * Self-hosted TikTok WebSocket client — intercepts the WebSocket connection
 * that TikTok's own JavaScript creates in the browser, then connects to it
 * from Node.js for real-time viewer count updates.
 *
 * NO external dependencies (no Euler, no tiktok-live-connector).
 * Requires Chrome browser server running on CDP port 9224 and a logged-in
 * TikTok session in the browser profile.
 *
 * Flow:
 * 1. Open TikTok live page in Chrome tab
 * 2. TikTok's JS handles all signing/auth and creates a WebSocket
 * 3. We intercept the WebSocket URL via CDP Network.webSocketCreated
 * 4. We extract cookies from the browser session
 * 5. We connect to the same WebSocket from Node.js with those cookies
 * 6. We receive real-time protobuf events including viewer counts
 */

import * as http from 'http';
import * as zlib from 'zlib';

const CDP_PORT = 9224;

// ── CDP helpers ──────────────────────────────────────────────────────────

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

class CDPSession {
  private ws: import('ws').WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: unknown) => void>>();

  async connect(wsUrl: string): Promise<void> {
    const { default: WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Handle method responses
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
          // Handle events
          if (msg.method) {
            const handlers = this.eventHandlers.get(msg.method) ?? [];
            for (const h of handlers) h(msg.params);
          }
        } catch {}
      });
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
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
      }, 30000);
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
    this.eventHandlers.clear();
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

// ── Protobuf parsing (minimal, no dependency) ────────────────────────────
// TikTok uses protobuf for WebSocket messages. We only need to extract
// viewerCount from WebcastRoomUserSeqMessage. Simple varint decoding.

function readVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, bytesRead };
}

// Extract viewer count from raw protobuf by looking for known patterns
function extractViewerCountFromProtobuf(data: Buffer): number | null {
  // Try to decompress if gzipped
  let buf = data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf);
    } catch {
      return null;
    }
  }

  // WebcastRoomUserSeqMessage has viewerCount at field 3 (wire type 0 = varint)
  // We look for the message type string "WebcastRoomUserSeqMessage" in the outer frame
  const typeStr = 'WebcastRoomUserSeqMessage';
  const typeIdx = buf.indexOf(typeStr);
  if (typeIdx === -1) return null;

  // The viewerCount is typically the first significant varint after the type marker
  // in the inner message. Let's search for field tag 0x18 (field 3, varint)
  // within a reasonable range after the type marker
  for (let i = typeIdx; i < Math.min(typeIdx + 500, buf.length - 1); i++) {
    if (buf[i] === 0x18) { // field 3, wire type 0 (varint)
      const { value } = readVarint(buf, i + 1);
      if (value > 0 && value < 10_000_000) { // Reasonable viewer count range
        return value;
      }
    }
  }

  return null;
}

// ── TikTok WebSocket Channel ─────────────────────────────────────────────

export interface TikTokWSChannel {
  username: string;
  displayName: string;
  viewers: number;
  isLive: boolean;
  tabId: string | null;
  wsConnected: boolean;
}

/**
 * TikTokWSInterceptClient — intercepts WebSocket connections from Chrome
 * and connects to them from Node.js for real-time viewer counts.
 */
export class TikTokWSInterceptClient {
  private channels = new Map<string, {
    username: string;
    displayName: string;
    tabId: string;
    cdpSession: CDPSession | null;
    nodeWs: import('ws').WebSocket | null;
    viewers: number;
    isLive: boolean;
    lastUpdate: number;
  }>();

  /**
   * Connect to a TikTok live channel by opening a Chrome tab,
   * intercepting the WebSocket URL, and connecting from Node.js.
   */
  async connectChannel(username: string, displayName: string): Promise<void> {
    const clean = username.replace(/^@/, '');
    if (this.channels.has(clean) && this.channels.get(clean)!.nodeWs) return;

    console.log(`[TikTokWS] Connecting to ${displayName} (${clean})...`);

    // Open or find existing tab
    const targets = await cdpRequest('/json') as CDPTarget[];
    let target = targets.find((t) =>
      t.type === 'page' && t.url.toLowerCase().includes(`tiktok.com/@${clean.toLowerCase()}`),
    );

    if (!target) {
      const url = `https://www.tiktok.com/@${clean}/live`;
      target = await cdpRequest(`/json/new?${encodeURIComponent(url)}`, 'PUT') as CDPTarget;
      await sleep(3000);
      // Refresh target to get updated wsUrl
      const freshTargets = await cdpRequest('/json') as CDPTarget[];
      target = freshTargets.find((t) => t.id === target!.id) ?? target;
    }

    const channel = {
      username: clean,
      displayName,
      tabId: target.id,
      cdpSession: null as CDPSession | null,
      nodeWs: null as import('ws').WebSocket | null,
      viewers: 0,
      isLive: false,
      lastUpdate: Date.now(),
    };
    this.channels.set(clean, channel);

    // Connect to tab via CDP and enable Network monitoring
    const session = new CDPSession();
    await session.connect(target.webSocketDebuggerUrl);
    channel.cdpSession = session;

    // Hide webdriver
    await session.evaluate(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);

    // Enable network monitoring to intercept WebSocket creation
    await session.send('Network.enable', {});

    // Listen for WebSocket creation events
    let wsIntercepted = false;
    session.on('Network.webSocketCreated', async (params: unknown) => {
      const p = params as { requestId: string; url: string };
      if (p.url.includes('webcast') && p.url.includes('push') && !wsIntercepted) {
        wsIntercepted = true;
        console.log(`[TikTokWS] Intercepted WebSocket for ${displayName}: ${p.url.substring(0, 80)}...`);

        // Extract cookies from browser for our Node.js connection
        const cookieResult = await session.send('Network.getCookies', {
          urls: ['https://www.tiktok.com', 'https://webcast.tiktok.com'],
        }) as { cookies: Array<{ name: string; value: string }> };

        const cookieStr = cookieResult.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');

        // Connect to the same WebSocket from Node.js
        await this.connectNodeWebSocket(clean, p.url, cookieStr);
      }
    });

    // Also try reading viewer count from DOM as fallback
    await this.readDOMViewerCount(clean, session);

    // Wait for WebSocket interception (up to 15 seconds)
    for (let i = 0; i < 15; i++) {
      if (wsIntercepted) break;
      await sleep(1000);
    }

    if (!wsIntercepted) {
      console.log(`[TikTokWS] No WebSocket intercepted for ${displayName} — using DOM fallback`);
    }

    // Reload the page if it seems stuck (navigate to live URL)
    if (!wsIntercepted && !channel.isLive) {
      await session.send('Page.navigate', { url: `https://www.tiktok.com/@${clean}/live` });
      // Wait a bit more for WebSocket
      for (let i = 0; i < 10; i++) {
        if (wsIntercepted) break;
        await sleep(1000);
      }
    }
  }

  /**
   * Connect to TikTok's WebSocket from Node.js using intercepted URL + cookies.
   */
  private async connectNodeWebSocket(username: string, wsUrl: string, cookies: string): Promise<void> {
    const { default: WebSocket } = await import('ws');
    const channel = this.channels.get(username);
    if (!channel) return;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Cookie': cookies,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.tiktok.com',
      },
    });

    ws.on('open', () => {
      console.log(`[TikTokWS] Node.js WebSocket connected for ${channel.displayName}`);
      channel.isLive = true;
      channel.nodeWs = ws;

      // Send heartbeat every 10 seconds
      const heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          // TikTok heartbeat: simple ping frame
          ws.ping();
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 10_000);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const viewerCount = extractViewerCountFromProtobuf(data);
        if (viewerCount !== null && viewerCount > 0) {
          channel.viewers = viewerCount;
          channel.isLive = true;
          channel.lastUpdate = Date.now();
        }
      } catch {}
    });

    ws.on('close', () => {
      console.log(`[TikTokWS] WebSocket closed for ${channel.displayName}`);
      channel.nodeWs = null;
      channel.isLive = false;
    });

    ws.on('error', (err) => {
      console.log(`[TikTokWS] WebSocket error for ${channel.displayName}: ${err.message}`);
    });
  }

  /**
   * Read viewer count from DOM as fallback.
   */
  private async readDOMViewerCount(username: string, session: CDPSession): Promise<void> {
    const channel = this.channels.get(username);
    if (!channel) return;

    try {
      const result = await session.evaluate(`
        (function() {
          // Look for userCount in embedded JSON
          const html = document.documentElement.innerHTML;
          const match = html.match(/"userCount"\\s*:\\s*(\\d+)/);
          if (match) return parseInt(match[1]);

          // Look for viewer count text
          const allText = document.body?.innerText || '';
          const viewerMatch = allText.match(/(\\d[\\d,.]*[KkMm]?)\\s*(?:viewer|watching)/i);
          if (viewerMatch) {
            let num = viewerMatch[1].replace(/,/g, '');
            if (num.match(/[Kk]$/)) return Math.round(parseFloat(num) * 1000);
            if (num.match(/[Mm]$/)) return Math.round(parseFloat(num) * 1000000);
            return parseInt(num);
          }
          return 0;
        })()
      `) as number;

      if (result > 0) {
        channel.viewers = result;
        channel.isLive = true;
        channel.lastUpdate = Date.now();
      }
    } catch {}
  }

  /**
   * Refresh viewer count — re-read DOM for channels without active WebSocket.
   */
  async refreshViewerCounts(): Promise<void> {
    for (const [username, channel] of this.channels) {
      // If we have an active Node.js WebSocket, viewer count updates automatically
      if (channel.nodeWs) continue;

      // Otherwise try to read from DOM
      if (channel.cdpSession) {
        await this.readDOMViewerCount(username, channel.cdpSession);
      }
    }
  }

  /**
   * Get current state of all channels.
   */
  getChannelStates(): TikTokWSChannel[] {
    return [...this.channels.values()].map((ch) => ({
      username: ch.username,
      displayName: ch.displayName,
      viewers: ch.viewers,
      isLive: ch.isLive,
      tabId: ch.tabId,
      wsConnected: !!ch.nodeWs,
    }));
  }

  /**
   * Disconnect a channel.
   */
  async disconnectChannel(username: string): Promise<void> {
    const clean = username.replace(/^@/, '');
    const channel = this.channels.get(clean);
    if (!channel) return;

    channel.nodeWs?.close();
    channel.cdpSession?.close();
    try {
      await cdpRequest(`/json/close/${channel.tabId}`, 'GET');
    } catch {}
    this.channels.delete(clean);
  }

  /**
   * Get list of tracked usernames.
   */
  getTrackedUsernames(): string[] {
    return [...this.channels.keys()];
  }
}
