import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import logger from '../utils/logger';
import type { PlatformAdapter, ChannelSnapshot, DiscoveredStream } from './types';

// Register stealth plugin once at module level
chromium.use(stealthPlugin());

const TIKTOK_BASE = 'https://www.tiktok.com';
const PAGE_TIMEOUT_MS = 30_000;
const MIN_PAGE_LOAD_DELAY_MS = 5_000;
const MAX_CONTEXT_AGE_MS = 30 * 60_000; // 30 minutes
const MAX_CONTEXTS = 3;
const CAPTCHA_COOLDOWN_MS = 10 * 60_000; // 10 minutes

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// Viewer count selectors — TikTok's DOM changes frequently, so we try multiple
const VIEWER_COUNT_SELECTORS = [
  '[data-e2e="live-viewer-count"]',
  '[class*="viewer"] [class*="count"]',
  '[class*="LiveViewerCount"]',
  '[class*="viewer-count"]',
];

// Indicators that we hit a CAPTCHA or block page
const CAPTCHA_INDICATORS = [
  'verify your identity',
  'captcha',
  'human verification',
  'access denied',
  'please verify',
];

interface ManagedContext {
  context: BrowserContext;
  createdAt: number;
}

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok';

  private browser: Browser | null = null;
  private contexts: ManagedContext[] = [];
  private readonly cooldowns = new Map<string, number>(); // username → cooldown-until timestamp
  private isShuttingDown = false;

  // ── Browser lifecycle ─────────────────────────────────────────────────

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    logger.info('TikTok: launching Chromium browser');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    this.browser.on('disconnected', () => {
      logger.warn('TikTok: browser disconnected');
      this.browser = null;
      this.contexts = [];
    });

    return this.browser;
  }

  private async acquireContext(): Promise<BrowserContext> {
    // Evict stale contexts
    const now = Date.now();
    const stale = this.contexts.filter((c) => now - c.createdAt > MAX_CONTEXT_AGE_MS);
    for (const s of stale) {
      try { await s.context.close(); } catch { /* already closed */ }
    }
    this.contexts = this.contexts.filter((c) => now - c.createdAt <= MAX_CONTEXT_AGE_MS);

    // Reuse an existing context if under limit
    if (this.contexts.length > 0) {
      return this.contexts[0].context;
    }

    // Create new context
    const browser = await this.ensureBrowser();
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    this.contexts.push({ context, createdAt: now });

    // Enforce pool limit
    while (this.contexts.length > MAX_CONTEXTS) {
      const oldest = this.contexts.shift();
      if (oldest) {
        try { await oldest.context.close(); } catch { /* ok */ }
      }
    }

    return context;
  }

  // ── Cooldown management ───────────────────────────────────────────────

  private isOnCooldown(username: string): boolean {
    const until = this.cooldowns.get(username);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldowns.delete(username);
      return false;
    }
    return true;
  }

  private setCooldown(username: string): void {
    this.cooldowns.set(username, Date.now() + CAPTCHA_COOLDOWN_MS);
    logger.warn(`TikTok: "${username}" on cooldown for ${CAPTCHA_COOLDOWN_MS / 1000}s (CAPTCHA/block detected)`);
  }

  // ── Viewer count parsing ──────────────────────────────────────────────

  private parseViewerCount(text: string): number {
    const cleaned = text.trim().replace(/,/g, '');

    // Handle K/M suffixes: "12.5K" → 12500, "1.2M" → 1200000
    const suffixMatch = cleaned.match(/^([\d.]+)\s*([KkMm])?$/);
    if (!suffixMatch) {
      const digits = cleaned.replace(/\D/g, '');
      return digits ? parseInt(digits, 10) : 0;
    }

    const num = parseFloat(suffixMatch[1]);
    const suffix = (suffixMatch[2] ?? '').toUpperCase();
    if (suffix === 'K') return Math.round(num * 1_000);
    if (suffix === 'M') return Math.round(num * 1_000_000);
    return Math.round(num);
  }

  // ── Single channel scrape ─────────────────────────────────────────────

  private async scrapeChannel(username: string): Promise<ChannelSnapshot> {
    const offlineResult: ChannelSnapshot = {
      channelIdentifier: username,
      displayName: username,
      concurrentViewers: 0,
      isLive: false,
      language: null,
      gameName: null,
      title: null,
      startedAt: null,
    };

    if (this.isOnCooldown(username)) {
      logger.debug(`TikTok: skipping "${username}" (on cooldown)`);
      return offlineResult;
    }

    let page: Page | null = null;

    try {
      const context = await this.acquireContext();
      page = await context.newPage();

      const liveUrl = `${TIKTOK_BASE}/@${encodeURIComponent(username)}/live`;
      logger.debug(`TikTok: navigating to ${liveUrl}`);

      const response = await page.goto(liveUrl, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS,
      });

      // Wait for dynamic content to render
      await page.waitForTimeout(3000 + Math.random() * 2000);

      // Check for CAPTCHA / block
      const pageContent = await page.content();
      const pageLower = pageContent.toLowerCase();
      const captchaDetected = CAPTCHA_INDICATORS.some((ind) => pageLower.includes(ind));

      if (captchaDetected) {
        this.setCooldown(username);
        return offlineResult;
      }

      // Check if redirected away from /live (user not streaming)
      const currentUrl = page.url();
      if (!currentUrl.includes('/live')) {
        logger.debug(`TikTok: "${username}" redirected to ${currentUrl} — not live`);
        return offlineResult;
      }

      // Check HTTP status
      if (response && response.status() >= 400) {
        logger.debug(`TikTok: "${username}" returned status ${response.status()}`);
        return offlineResult;
      }

      // Try to extract viewer count from known selectors
      let viewerCount = 0;
      let found = false;

      for (const selector of VIEWER_COUNT_SELECTORS) {
        try {
          const el = await page.$(selector);
          if (el) {
            const text = await el.textContent();
            if (text) {
              viewerCount = this.parseViewerCount(text);
              found = true;
              break;
            }
          }
        } catch {
          // Selector didn't match, try next
        }
      }

      if (!found) {
        // Last resort: regex scan the page text for "N viewers" / "N watching"
        const bodyText = await page.textContent('body') ?? '';
        const viewerMatch = bodyText.match(/([\d,.]+[KkMm]?)\s*(?:viewer|watching)/i);
        if (viewerMatch) {
          viewerCount = this.parseViewerCount(viewerMatch[1]);
          found = true;
        }
      }

      if (!found) {
        logger.warn(`TikTok: could not find viewer count element for "${username}"`, {
          url: currentUrl,
          selectorsAttempted: VIEWER_COUNT_SELECTORS.length,
        });
        // Still might be live, but we can't read the count
        return {
          ...offlineResult,
          isLive: true,
          title: await this.extractTitle(page),
        };
      }

      const title = await this.extractTitle(page);

      return {
        channelIdentifier: username,
        displayName: username,
        concurrentViewers: viewerCount,
        isLive: true,
        language: null, // TikTok doesn't expose this in the DOM reliably
        gameName: null,
        title,
        startedAt: null,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);

      if (message.includes('Timeout') || message.includes('timeout')) {
        logger.warn(`TikTok: page timeout for "${username}" (${PAGE_TIMEOUT_MS}ms)`);
      } else {
        logger.warn(`TikTok: error scraping "${username}"`, { error: message });
      }

      return offlineResult;
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ok */ }
      }
    }
  }

  private async extractTitle(page: Page): Promise<string | null> {
    try {
      const titleEl = await page.$('[data-e2e="live-room-title"], [class*="LiveTitle"], title');
      if (titleEl) {
        const text = await titleEl.textContent();
        if (text?.trim()) return text.trim();
      }
      // Fall back to page title
      const pageTitle = await page.title();
      if (pageTitle && !pageTitle.includes('TikTok')) return pageTitle;
    } catch { /* best effort */ }
    return null;
  }

  // ── Core methods (PlatformAdapter) ────────────────────────────────────

  async getViewerCounts(usernames: string[]): Promise<ChannelSnapshot[]> {
    if (usernames.length === 0) return [];

    const results: ChannelSnapshot[] = [];

    // Process sequentially — one page at a time to manage resources
    for (let i = 0; i < usernames.length; i++) {
      const snapshot = await this.scrapeChannel(usernames[i]);
      results.push(snapshot);

      // Polite delay between page loads (unless last item)
      if (i < usernames.length - 1) {
        const delay = MIN_PAGE_LOAD_DELAY_MS + Math.random() * 2000;
        await sleep(delay);
      }
    }

    logger.debug(`TikTok getViewerCounts: ${results.filter(r => r.isLive).length}/${usernames.length} live`);
    return results;
  }

  async searchLiveStreams(
    _gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]> {
    if (!keywords || keywords.length === 0) {
      logger.info('TikTok: discovery requires manual channel input (no public search API)');
      return [];
    }

    // Best-effort: try scraping TikTok search for live content
    let page: Page | null = null;

    try {
      const context = await this.acquireContext();
      page = await context.newPage();

      const results: DiscoveredStream[] = [];
      const seen = new Set<string>();

      for (const keyword of keywords) {
        try {
          const searchUrl = `${TIKTOK_BASE}/search/live?q=${encodeURIComponent(keyword)}`;
          await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: PAGE_TIMEOUT_MS,
          });

          await page.waitForTimeout(3000 + Math.random() * 2000);

          // Check for CAPTCHA
          const content = await page.content();
          if (CAPTCHA_INDICATORS.some((ind) => content.toLowerCase().includes(ind))) {
            logger.warn('TikTok: CAPTCHA detected during search, aborting discovery');
            break;
          }

          // Try to find live stream cards
          const cards = await page.$$('[data-e2e="search-live-card"], [class*="LiveCard"], [class*="live-card"]');

          for (const card of cards) {
            try {
              const link = await card.$('a[href*="/@"]');
              const href = link ? await link.getAttribute('href') : null;
              if (!href) continue;

              const usernameMatch = href.match(/@([^/]+)/);
              if (!usernameMatch) continue;

              const channelId = usernameMatch[1];
              if (seen.has(channelId)) continue;
              seen.add(channelId);

              const titleEl = await card.$('[class*="title"], [class*="Title"]');
              const title = titleEl ? (await titleEl.textContent() ?? keyword) : keyword;

              const viewerEl = await card.$('[class*="viewer"], [class*="count"]');
              const viewerText = viewerEl ? (await viewerEl.textContent() ?? '0') : '0';

              results.push({
                channelIdentifier: channelId,
                displayName: channelId,
                concurrentViewers: this.parseViewerCount(viewerText),
                language: null,
                title: title.trim() || keyword,
              });
            } catch {
              // Skip malformed card
            }
          }

          // Delay between keyword searches
          await sleep(MIN_PAGE_LOAD_DELAY_MS + Math.random() * 2000);
        } catch (err) {
          logger.warn(`TikTok: search failed for keyword "${keyword}"`, {
            error: (err as Error).message,
          });
        }
      }

      logger.debug(`TikTok searchLiveStreams: found ${results.length} streams`, { keywords });
      return results;
    } catch (err) {
      logger.warn('TikTok: searchLiveStreams failed, manual channel input recommended', {
        error: (err as Error).message,
      });
      return [];
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ok */ }
      }
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('TikTok: shutting down browser pool');

    for (const managed of this.contexts) {
      try { await managed.context.close(); } catch { /* ok */ }
    }
    this.contexts = [];

    if (this.browser) {
      try { await this.browser.close(); } catch { /* ok */ }
      this.browser = null;
    }

    logger.info('TikTok: browser pool shut down');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
