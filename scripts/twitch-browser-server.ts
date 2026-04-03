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
    '--window-size=1280,900',
    // Don't autoplay video/audio — saves resources
    '--autoplay-policy=no-user-gesture-required',
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
