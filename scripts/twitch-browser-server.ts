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

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PROFILE_DIR = path.join(SCRIPT_DIR, 'twitch-browser-profile');
const CDP_PORT = 9224; // Different from TikTok (9222) and Instagram (9223)
const CDP_FILE = path.join(SCRIPT_DIR, '.twitch-browser-cdp');

function findChrome(): string {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    return execSync('which google-chrome || which chromium', { encoding: 'utf-8' }).trim();
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
