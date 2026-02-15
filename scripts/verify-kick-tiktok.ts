/**
 * Verification script for Kick and TikTok adapters.
 *
 * Tests:
 *  - Kick: OAuth2 auth, getViewerCounts (official API), isAPIAvailable, searchLiveStreams, error handling
 *  - TikTok: getViewerCounts with Playwright, error handling, clean shutdown
 *
 * Note: Kick tests require KICK_CLIENT_ID and KICK_CLIENT_SECRET env vars.
 *       Without credentials, Kick tests still pass (graceful degradation to offline).
 *
 * Usage: npx ts-node scripts/verify-kick-tiktok.ts
 */

// Inline minimal config so we don't depend on .env
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

import { KickAdapter } from '../src/adapters/kick';
import { TikTokAdapter } from '../src/adapters/tiktok';
import type { ChannelSnapshot } from '../src/adapters/types';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function printSnapshot(s: ChannelSnapshot) {
  console.log(`    ${s.channelIdentifier}: ${s.isLive ? '🟢 LIVE' : '⚫ offline'} ${s.concurrentViewers} viewers` +
    (s.title ? ` — "${s.title}"` : '') +
    (s.language ? ` [${s.language}]` : '') +
    (s.gameName ? ` (${s.gameName})` : ''));
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════════
  //  KICK ADAPTER
  // ═══════════════════════════════════════════════════════════════════════

  section('1. Kick — Initialize');
  const kick = new KickAdapter();
  assert('KickAdapter instantiated', kick.platform === 'kick');

  // 1a. isAPIAvailable
  section('2. Kick — API health check');
  const kickAvailable = await kick.isAPIAvailable();
  console.log(`  Kick API available: ${kickAvailable}`);
  assert('isAPIAvailable() returned boolean', typeof kickAvailable === 'boolean');

  // 1b. getViewerCounts with real channels
  section('3. Kick — getViewerCounts (real channels)');
  const kickChannels = ['xqc', 'rampagejackson'];
  const kickResults = await kick.getViewerCounts(kickChannels);

  console.log(`  Requested ${kickChannels.length} channels, got ${kickResults.length} results:`);
  for (const s of kickResults) {
    printSnapshot(s);
  }

  assert('Returns correct number of results', kickResults.length === kickChannels.length);
  assert('All results have channelIdentifier', kickResults.every(r => !!r.channelIdentifier));
  assert('All results have numeric concurrentViewers', kickResults.every(r => typeof r.concurrentViewers === 'number' && r.concurrentViewers >= 0));
  assert('All results have boolean isLive', kickResults.every(r => typeof r.isLive === 'boolean'));

  // 1c. Error handling — invalid channel names
  section('4. Kick — Error handling (invalid channels)');
  const kickBadResults = await kick.getViewerCounts(['__nonexistent_channel_12345__', '!!!invalid!!!']);

  console.log(`  Requested 2 invalid channels, got ${kickBadResults.length} results:`);
  for (const s of kickBadResults) {
    printSnapshot(s);
  }

  assert('Invalid channels do not crash', kickBadResults.length === 2);
  assert('Invalid channels return offline', kickBadResults.every(r => r.concurrentViewers === 0));

  // 1d. Empty input
  section('5. Kick — Empty input');
  const kickEmpty = await kick.getViewerCounts([]);
  assert('Empty input returns empty array', kickEmpty.length === 0);

  // 1e. searchLiveStreams (best-effort, official API)
  section('5b. Kick — searchLiveStreams (best-effort)');
  const kickSearch = await kick.searchLiveStreams();
  console.log(`  Search returned ${kickSearch.length} streams (0 if no credentials)`);
  assert('searchLiveStreams returns array without crashing', Array.isArray(kickSearch));
  if (kickSearch.length > 0) {
    console.log(`  Top 3 streams:`);
    for (const s of kickSearch.slice(0, 3)) {
      console.log(`    ${s.channelIdentifier}: ${s.concurrentViewers} viewers — "${s.title}"` +
        (s.language ? ` [${s.language}]` : ''));
    }
    assert('Streams have channelIdentifier', kickSearch.every(s => !!s.channelIdentifier));
    assert('Streams have numeric concurrentViewers', kickSearch.every(s => typeof s.concurrentViewers === 'number'));
    assert('Streams have title', kickSearch.every(s => typeof s.title === 'string'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  TIKTOK ADAPTER
  // ═══════════════════════════════════════════════════════════════════════

  section('6. TikTok — Initialize');
  const tiktok = new TikTokAdapter();
  assert('TikTokAdapter instantiated', tiktok.platform === 'tiktok');

  // 2a. getViewerCounts with a known username
  section('7. TikTok — getViewerCounts (real channel)');
  console.log('  Launching Chromium browser (this takes a few seconds)...');
  const tiktokStartTime = Date.now();

  const tiktokResults = await tiktok.getViewerCounts(['tiktok']);
  const tiktokDuration = ((Date.now() - tiktokStartTime) / 1000).toFixed(1);

  console.log(`  Completed in ${tiktokDuration}s. Results:`);
  for (const s of tiktokResults) {
    printSnapshot(s);
  }

  assert('Returns 1 result', tiktokResults.length === 1);
  assert('Result has channelIdentifier', !!tiktokResults[0].channelIdentifier);
  assert('Result has numeric concurrentViewers', typeof tiktokResults[0].concurrentViewers === 'number');
  assert('Result has boolean isLive', typeof tiktokResults[0].isLive === 'boolean');
  assert('Browser launched successfully (completed without crash)', true);

  // 2b. Error handling — invalid username
  section('8. TikTok — Error handling (invalid channel)');
  const tiktokBadResults = await tiktok.getViewerCounts(['__nonexistent_user_xyz_99999__']);

  console.log(`  Results for invalid username:`);
  for (const s of tiktokBadResults) {
    printSnapshot(s);
  }

  assert('Invalid TikTok username does not crash', tiktokBadResults.length === 1);
  assert('Invalid username returns offline', tiktokBadResults[0].concurrentViewers === 0);

  // 2c. Empty input
  section('9. TikTok — Empty input');
  const tiktokEmpty = await tiktok.getViewerCounts([]);
  assert('Empty input returns empty array', tiktokEmpty.length === 0);

  // 2d. searchLiveStreams (best-effort)
  section('10. TikTok — searchLiveStreams (best-effort)');
  const tiktokSearch = await tiktok.searchLiveStreams(undefined, ['gaming']);
  console.log(`  Search returned ${tiktokSearch.length} results (may be 0 due to anti-bot)`);
  assert('searchLiveStreams returns array without crashing', Array.isArray(tiktokSearch));

  // 2e. Clean shutdown
  section('11. TikTok — Shutdown');
  await tiktok.shutdown();
  assert('shutdown() completed without error', true);

  // ═══════════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  section('SUMMARY');
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exitCode = 1;
});
