#!/usr/bin/env npx tsx
/**
 * Persistent Chrome Browser Server for Twitch viewer count scraping.
 *
 * Launches real Chrome with a persistent profile and remote debugging.
 * The scraper (twitch-browser-scraper.ts) connects via CDP.
 *
 * Start once:   npx tsx scripts/twitch-browser-server.ts
 * Stop:         Ctrl+C (or close the Chrome window)
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Use fileURLToPath, NOT new URL(import.meta.url).pathname — on Windows
// the latter yields an invalid "/C:/Users/..." path (leading slash before
// the drive letter), which breaks the profile dir + Chrome --user-data-dir
// and surfaces as "ENOENT: no such file or directory".
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(SCRIPT_DIR, 'twitch-browser-profile');
const CDP_PORT = 9224; // Different from TikTok (9222) and Instagram (9223)
const CDP_FILE = path.join(SCRIPT_DIR, '.twitch-browser-cdp');

function findChrome(): string {
  // Per-platform candidate list. We try absolute paths first (faster +
  // no PATH dependency in launchd / Task Scheduler) before falling back
  // to a PATH-based lookup.
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          process.env.LOCALAPPDATA
            ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
            : '',
        ].filter(Boolean)
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const lookup =
      process.platform === 'win32'
        ? 'where chrome.exe'
        : 'which google-chrome || which chromium';
    const out = execSync(lookup, { encoding: 'utf-8' }).trim();
    // `where` can return multiple lines on Windows — take the first.
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first) return first;
  } catch {}

  throw new Error('Chrome not found. Install Google Chrome.');
}

async function main() {
  const chromePath = findChrome();
  console.log('[TwitchBrowser] Chrome:', chromePath);
  console.log('[TwitchBrowser] Profile:', PROFILE_DIR);
  console.log('[TwitchBrowser] CDP port:', CDP_PORT);

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    // Smaller window → Twitch picks a smaller stream variant by default,
    // less video work for the CPU/GPU. We hide playback entirely from JS
    // (see scraper's tameTab) but the smaller default helps on first paint.
    '--window-size=800,600',
    // Resource hardening — important on older Intel Macs (e.g. 2019 MBP)
    // where 10-20 simultaneous Twitch tabs would otherwise melt the
    // chassis. Audio is muted at the Chrome level so OS audio decode
    // never runs even if a tab tries to play. Background-tab CPU
    // throttling stays ON (default) — the scraper foreground-activates
    // each tab only briefly when reading.
    '--mute-audio',
    '--autoplay-policy=user-gesture-required',
    '--disable-features=MediaRouter,DialMediaRouteProvider,InterestFeedContentSuggestions,Translate,OptimizationHints',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-default-apps',
    'about:blank',
  ];

  const child = spawn(chromePath, args, {
    detached: false,
    stdio: 'ignore',
  });

  child.on('error', (err) => {
    console.error('[TwitchBrowser] Failed to start Chrome:', err.message);
    process.exit(1);
  });

  await new Promise((r) => setTimeout(r, 2000));

  const cdpUrl = `http://localhost:${CDP_PORT}`;
  fs.writeFileSync(CDP_FILE, cdpUrl);

  console.log('[TwitchBrowser] Chrome is running.');
  console.log('[TwitchBrowser] CDP endpoint:', cdpUrl);
  console.log('[TwitchBrowser] Keep this terminal open. Press Ctrl+C to stop.\n');

  const cleanup = () => {
    try { fs.unlinkSync(CDP_FILE); } catch {}
  };

  child.on('exit', (code) => {
    console.log('[TwitchBrowser] Chrome exited with code:', code);
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\n[TwitchBrowser] Shutting down Chrome...');
    cleanup();
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  });

  process.on('SIGTERM', () => {
    cleanup();
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  });

  setInterval(() => {}, 60000);
}

main().catch((err) => {
  console.error('[TwitchBrowser] Fatal error:', err);
  process.exit(1);
});
