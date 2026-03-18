#!/usr/bin/env npx tsx
/**
 * Persistent Chrome Browser Server for TikTok scraping
 *
 * Keeps a real Chrome running with a persistent profile so TikTok session
 * cookies survive between polls. The TikTok adapter connects via CDP.
 *
 * First run:
 *   1. Start this script
 *   2. Open http://localhost:9222 in your browser to access DevTools
 *   3. Navigate to tiktok.com in the Chrome instance and solve any CAPTCHA
 *   4. Session cookies persist in the profile directory
 *
 * Usage:
 *   npx tsx scripts/tiktok-browser-server.ts
 *   # Or via PM2:
 *   pm2 start scripts/tiktok-browser-server.ts --name tiktok-browser --interpreter npx --interpreter-args tsx
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..');
const PROFILE_DIR = path.join(PROJECT_DIR, '.tiktok-browser-profile');
const CDP_PORT = 9222;
const CDP_FILE = path.join(PROJECT_DIR, '.tiktok-cdp');

function findChrome(): string {
  const paths = [
    // Linux (server)
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS (dev)
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  // Try which
  try {
    const found = execSync('which google-chrome || which chromium-browser || which chromium 2>/dev/null', {
      encoding: 'utf-8',
    }).trim();
    if (found) return found;
  } catch { /* not in PATH */ }

  // Try Playwright's bundled Chromium
  const homeDir = process.env.HOME || '';
  const cacheDirs = [
    path.join(homeDir, '.cache', 'ms-playwright'),
    path.join(homeDir, 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    const dirs = fs.readdirSync(cacheDir)
      .filter((d) => d.startsWith('chromium') && !d.includes('headless_shell'))
      .sort();
    for (const dir of dirs.reverse()) {
      // Try all known sub-paths
      const candidates = [
        path.join(cacheDir, dir, 'chrome-linux64', 'chrome'),
        path.join(cacheDir, dir, 'chrome-linux', 'chrome'),
        path.join(cacheDir, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
  }

  throw new Error('Chrome/Chromium not found. Install: apt install chromium-browser');
}

async function main() {
  const chromePath = findChrome();
  console.log('[TikTok Browser] Chrome:', chromePath);
  console.log('[TikTok Browser] Profile:', PROFILE_DIR);
  console.log('[TikTok Browser] CDP port:', CDP_PORT);

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1280,900',
    'https://www.tiktok.com',
  ];

  const child = spawn(chromePath, args, {
    detached: false,
    stdio: 'ignore',
  });

  child.on('error', (err) => {
    console.error('[TikTok Browser] Failed to start Chrome:', err.message);
    process.exit(1);
  });

  // Wait for Chrome to start
  await new Promise((r) => setTimeout(r, 3000));

  // Save CDP endpoint
  const cdpUrl = `http://localhost:${CDP_PORT}`;
  fs.writeFileSync(CDP_FILE, cdpUrl);

  console.log('[TikTok Browser] Chrome is running (headless).');
  console.log('[TikTok Browser] CDP endpoint:', cdpUrl);

  const cleanup = () => {
    try { fs.unlinkSync(CDP_FILE); } catch { /* ok */ }
  };

  child.on('exit', (code) => {
    console.log('[TikTok Browser] Chrome exited with code:', code);
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\n[TikTok Browser] Shutting down...');
    cleanup();
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  });

  process.on('SIGTERM', () => {
    cleanup();
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  });

  // Keep alive
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  console.error('[TikTok Browser] Fatal:', err);
  process.exit(1);
});
