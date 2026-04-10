/**
 * Browser-based TikTok URL signer.
 *
 * Uses the persistent Chrome browser (CDP port 9224) to generate TikTok
 * signatures using TikTok's own webmssdk. No external service needed.
 *
 * The signer opens a TikTok page once to load the SDK, then reuses it
 * for all subsequent signing requests.
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

/**
 * BrowserSigner — generates TikTok signatures using Chrome browser.
 *
 * Implements the same interface as EulerSigner's webcastSign method
 * so it can be used as a drop-in replacement.
 */
export class BrowserSigner {
  private signerTabId: string | null = null;
  private signerWsUrl: string | null = null;
  private initialized = false;

  /**
   * Initialize the signer by opening a TikTok page in Chrome
   * to load the webmssdk SDK.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('[BrowserSigner] Initializing — loading TikTok SDK in Chrome...');

    // Check if we already have a TikTok tab
    const targets = await cdpRequest('/json') as CDPTarget[];
    const existing = targets.find((t) =>
      t.type === 'page' && t.url.includes('tiktok.com') && !t.url.includes('/live'),
    );

    if (existing) {
      this.signerTabId = existing.id;
      this.signerWsUrl = existing.webSocketDebuggerUrl;
      console.log('[BrowserSigner] Reusing existing TikTok tab');
    } else {
      // Open a new TikTok page
      const target = await cdpRequest('/json/new?https://www.tiktok.com/explore', 'PUT') as CDPTarget;
      this.signerTabId = target.id;
      this.signerWsUrl = target.webSocketDebuggerUrl;
      console.log('[BrowserSigner] Opened new TikTok tab, waiting for SDK to load...');
      // Wait for the page to fully load and SDK to initialize
      await new Promise((r) => setTimeout(r, 8000));
    }

    // Verify the SDK loaded
    const session = new CDPSession();
    try {
      // Refresh target list to get fresh wsUrl
      const freshTargets = await cdpRequest('/json') as CDPTarget[];
      const freshTarget = freshTargets.find((t) => t.id === this.signerTabId);
      if (!freshTarget) throw new Error('Signer tab disappeared');
      this.signerWsUrl = freshTarget.webSocketDebuggerUrl;

      await session.connect(this.signerWsUrl);

      // Hide webdriver flag
      await session.evaluate(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);

      // Check if frontierSign is available
      const hasFrontierSign = await session.evaluate(`typeof window.frontierSign === 'function'`);
      if (hasFrontierSign) {
        console.log('[BrowserSigner] frontierSign() available — using native signing');
      } else {
        console.log('[BrowserSigner] frontierSign() not available — will use byteautomation fallback');
      }

      this.initialized = true;
      console.log('[BrowserSigner] Ready');
    } finally {
      session.close();
    }
  }

  /**
   * Sign a URL using TikTok's own SDK running in the browser.
   *
   * Returns the same shape as Euler's signWebcastUrl response so it can
   * be used as a drop-in replacement.
   */
  async webcastSign(
    url: string,
    _method: string,
    userAgent: string,
    _sessionId?: string,
    _ttTargetIdc?: string,
  ): Promise<{
    response: {
      signedUrl: string;
      userAgent: string;
      tokens: Record<string, string>;
    };
  }> {
    await this.initialize();

    const session = new CDPSession();
    try {
      // Get fresh wsUrl
      const targets = await cdpRequest('/json') as CDPTarget[];
      const target = targets.find((t) => t.id === this.signerTabId);
      if (!target) {
        this.initialized = false;
        throw new Error('Signer tab lost — will reinitialize on next call');
      }

      await session.connect(target.webSocketDebuggerUrl);

      // Try frontierSign first
      const signResult = await session.evaluate(`
        (async function() {
          const url = ${JSON.stringify(url)};

          // Method 1: frontierSign (exposed by secsdk for non-authenticated requests)
          if (typeof window.frontierSign === 'function') {
            try {
              const signed = await window.frontierSign(url);
              if (signed && signed['X-Bogus']) {
                return JSON.stringify({
                  success: true,
                  xBogus: signed['X-Bogus'],
                  msToken: signed['msToken'] || '',
                });
              }
            } catch (e) {}
          }

          // Method 2: Use the fetch interceptor — make a dummy fetch and capture the signed URL
          try {
            const originalFetch = window.__originalFetch || window.fetch;
            let capturedUrl = null;

            // Monkey-patch fetch temporarily to capture the signed URL
            window.fetch = function(input, init) {
              capturedUrl = typeof input === 'string' ? input : input.url;
              // Don't actually make the request — just throw to abort
              throw new Error('__CAPTURE__');
            };

            try {
              await fetch(url);
            } catch (e) {
              if (e.message !== '__CAPTURE__') throw e;
            }

            // Restore original fetch
            window.fetch = originalFetch;

            if (capturedUrl && capturedUrl.includes('X-Bogus')) {
              const bogusMatch = capturedUrl.match(/X-Bogus=([^&]+)/);
              const msMatch = capturedUrl.match(/msToken=([^&]+)/);
              return JSON.stringify({
                success: true,
                signedUrl: capturedUrl,
                xBogus: bogusMatch ? bogusMatch[1] : '',
                msToken: msMatch ? msMatch[1] : '',
              });
            }
          } catch (e) {}

          return JSON.stringify({ success: false, error: 'No signing method available' });
        })()
      `) as string;

      const parsed = JSON.parse(signResult as string);

      if (!parsed.success) {
        throw new Error(`Browser signing failed: ${parsed.error}`);
      }

      // Build signed URL
      let signedUrl = parsed.signedUrl || url;
      if (!signedUrl.includes('X-Bogus') && parsed.xBogus) {
        const separator = signedUrl.includes('?') ? '&' : '?';
        signedUrl = `${signedUrl}${separator}X-Bogus=${parsed.xBogus}`;
        if (parsed.msToken) {
          signedUrl = `${signedUrl}&msToken=${parsed.msToken}`;
        }
      }

      return {
        response: {
          signedUrl,
          userAgent,
          tokens: {
            'X-Bogus': parsed.xBogus || '',
            msToken: parsed.msToken || '',
          },
        },
      };
    } finally {
      session.close();
    }
  }
}
