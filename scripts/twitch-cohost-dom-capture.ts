#!/usr/bin/env npx tsx
/**
 * Twitch cohost DOM capture + diagnose.
 *
 * One-shot tool to figure out how to extract per-channel viewer counts
 * from the "Shared Viewership" popover during Stream Together. Connects
 * to the SAME Chrome the scraper uses (CDP port 9224), opens the channel
 * page, and:
 *   1. locates the viewer-count badge + its clickable ancestor chain,
 *   2. tries a SYNTHETIC click (element.click()) to open the popover,
 *   3. if that fails, tries a REAL CDP mouse click at the badge's
 *      coordinates (a trusted event — Twitch often ignores synthetic
 *      clicks for popovers),
 *   4. dumps the popover structure: the "Total Viewers" header, and every
 *      channel-link row (<a href="/login"> + nearby number).
 *
 * Run on the PC during a LIVE cohost broadcast, then paste the output:
 *   npx tsx scripts/twitch-cohost-dom-capture.ts
 *   npx tsx scripts/twitch-cohost-dom-capture.ts pubg_br   # other channel
 *
 * It only READS — no data is written anywhere.
 */
import * as http from 'http';

const CDP_PORT = 9224;
const CHANNEL = (process.argv[2] || 'pubg_battlegrounds').toLowerCase();

interface CDPTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

function cdpGet(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${CDP_PORT}${path}`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

function createTab(url: string): Promise<CDPTarget> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

class CDP {
  private ws: import('ws').WebSocket | null = null;
  private id = 0;
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
        } catch {
          /* ignore */
        }
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws) throw new Error('not connected');
    const id = ++this.id;
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
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return r?.result?.value;
  }

  async realClick(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// In-page probe: reports the header + channel-link rows currently in the
// DOM. Returned by value so we can compare before/after a click.
const PROBE = `
  (function () {
    function loginFromHref(h) {
      if (!h) return null;
      try { h = decodeURIComponent(h); } catch (e) {}
      var m = h.match(/^\\/([a-zA-Z0-9_]{2,25})\\/?$/);
      return m ? m[1].toLowerCase() : null;
    }
    var header = null;
    var els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,strong,div');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t.length <= 40 && (/^Total Viewers/i.test(t) || /^Shared Viewership/i.test(t))) {
        header = { tag: els[i].tagName, target: els[i].getAttribute('data-a-target'), text: t, cls: (els[i].className || '').toString().slice(0, 80) };
        break;
      }
    }
    var anchors = [];
    var seen = {};
    var as = document.querySelectorAll('a[href]');
    for (var j = 0; j < as.length; j++) {
      var login = loginFromHref(as[j].getAttribute('href'));
      if (!login || seen[login]) continue;
      var node = as[j], num = null, ctx = null;
      for (var d = 0; d < 4 && node; d++, node = node.parentElement) {
        var txt = (node.textContent || '').trim();
        var nm = txt.match(/([0-9][0-9.,]*\\s*[KkMm]?)\\s*$/);
        if (nm) { num = nm[1]; ctx = txt.slice(0, 50); break; }
      }
      seen[login] = 1;
      anchors.push({ login: login, num: num, ctx: ctx, aTarget: as[j].getAttribute('data-a-target'), role: as[j].getAttribute('role') });
    }
    return {
      pageBodyMentionsShared: /Shared Viewership|Total Viewers/i.test(document.body.innerText || ''),
      header: header,
      anchorCount: anchors.length,
      anchorsWithNumbers: anchors.filter(function (a) { return a.num != null; }),
    };
  })()
`;

async function main() {
  console.log(`\n=== Twitch cohost DOM capture — channel: ${CHANNEL} ===\n`);
  const targets = (await cdpGet('/json')) as CDPTarget[];
  let target = targets.find(
    (t) => t.type === 'page' && t.url.toLowerCase().includes(`twitch.tv/${CHANNEL}`),
  );
  if (!target) {
    console.log(`No open tab for ${CHANNEL} — opening one…`);
    target = await createTab(`https://www.twitch.tv/${CHANNEL}`);
    await sleep(9000);
    // refetch to get a live wsUrl
    const t2 = (await cdpGet('/json')) as CDPTarget[];
    target = t2.find((t) => t.id === target!.id) || target;
  }

  const cdp = new CDP();
  await cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable').catch(() => {});

  // 1. Badge + clickable ancestor chain + coordinates
  const badge = (await cdp.evaluate(`
    (function () {
      var el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
            || document.querySelector('[data-a-target="player-info-viewer-count"]');
      if (!el) return { found: false };
      var r = el.getBoundingClientRect();
      var chain = [];
      var node = el;
      for (var d = 0; d < 8 && node; d++, node = node.parentElement) {
        chain.push({
          tag: node.tagName,
          role: node.getAttribute('role'),
          haspopup: node.getAttribute('aria-haspopup'),
          expanded: node.getAttribute('aria-expanded'),
          target: node.getAttribute('data-a-target'),
          cls: (node.className || '').toString().slice(0, 60),
        });
      }
      return { found: true, text: (el.textContent || '').trim(), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, chain: chain };
    })()
  `)) as { found: boolean; text?: string; rect?: { x: number; y: number; w: number; h: number }; chain?: unknown[] };

  console.log('── BADGE ──');
  console.log(JSON.stringify(badge, null, 2));
  if (!badge.found) {
    console.log('\nBadge not found — is the stream live and the page loaded? Aborting.');
    cdp.close();
    return;
  }

  // 2. baseline probe (popover closed)
  const before = await cdp.evaluate(PROBE);
  console.log('\n── BEFORE any click ──');
  console.log(JSON.stringify(before, null, 2));

  // 3. SYNTHETIC click on the badge's nearest button/[role=button]
  await cdp.evaluate(`
    (function () {
      var el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
            || document.querySelector('[data-a-target="player-info-viewer-count"]');
      if (!el) return;
      var t = el.closest('button,[role="button"]') || el;
      try { t.click(); } catch (e) {}
    })()
  `);
  await sleep(900);
  const afterSynthetic = await cdp.evaluate(PROBE);
  console.log('\n── AFTER synthetic element.click() ──');
  console.log(JSON.stringify(afterSynthetic, null, 2));

  // close it again (best-effort) before trying the real click
  await cdp.evaluate(`
    (function () {
      var el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
            || document.querySelector('[data-a-target="player-info-viewer-count"]');
      if (el) { var t = el.closest('button,[role="button"]') || el; try { t.click(); } catch (e) {} }
    })()
  `);
  await sleep(400);

  // 4. REAL CDP mouse click at the badge centre
  const cx = (badge.rect!.x + badge.rect!.w / 2) | 0;
  const cy = (badge.rect!.y + badge.rect!.h / 2) | 0;
  console.log(`\n── REAL CDP click at (${cx}, ${cy}) ──`);
  await cdp.realClick(cx, cy);
  await sleep(900);
  const afterReal = await cdp.evaluate(PROBE);
  console.log(JSON.stringify(afterReal, null, 2));

  // 5. Verdict
  const opened = (p: unknown) => {
    const r = p as { header?: unknown; anchorsWithNumbers?: unknown[] };
    return !!r?.header || (r?.anchorsWithNumbers?.length ?? 0) >= 2;
  };
  console.log('\n=== VERDICT ===');
  console.log(`  synthetic click opened popover: ${opened(afterSynthetic)}`);
  console.log(`  real CDP click opened popover:  ${opened(afterReal)}`);
  const best = opened(afterReal) ? afterReal : opened(afterSynthetic) ? afterSynthetic : null;
  if (best) {
    const rows = (best as { anchorsWithNumbers?: Array<{ login: string; num: string; ctx: string }> }).anchorsWithNumbers ?? [];
    console.log(`  popover rows with hrefs (${rows.length}):`);
    for (const r of rows) console.log(`     /${r.login}  → ${r.num}   "${r.ctx}"`);
    console.log('  → rows carry <a href="/login">: ' + (rows.length >= 2 ? 'YES (href mapping works)' : 'NO / unclear'));
  } else {
    console.log('  popover did NOT open via either click — the trigger/selector is wrong,');
    console.log('  or the popover is in a shadow root / needs a different gesture.');
  }

  cdp.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
