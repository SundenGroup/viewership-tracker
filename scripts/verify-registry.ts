/**
 * Verification script for the AdapterRegistry.
 *
 * Tests:
 *  - Initialization and lazy adapter creation
 *  - healthCheck() across all 4 platforms
 *  - getViewerCountsMultiPlatform() with channels across platforms
 *  - shutdown()
 *
 * Usage: npx ts-node scripts/verify-registry.ts
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

import { AdapterRegistry } from '../src/adapters';
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

function printSnapshot(platform: string, s: ChannelSnapshot) {
  console.log(`    [${platform}] ${s.channelIdentifier}: ${s.isLive ? '🟢 LIVE' : '⚫ offline'} ${s.concurrentViewers} viewers` +
    (s.title ? ` — "${s.title}"` : '') +
    (s.language ? ` [${s.language}]` : '') +
    (s.gameName ? ` (${s.gameName})` : ''));
}

async function run() {
  // 1. Initialize
  section('1. AdapterRegistry — Initialize');
  const registry = new AdapterRegistry();
  assert('AdapterRegistry instantiated', registry instanceof AdapterRegistry);

  // 2. Health check — all 4 platforms in parallel
  section('2. AdapterRegistry — healthCheck()');
  console.log('  Checking all 4 platforms in parallel...');
  const startTime = Date.now();
  const health = await registry.healthCheck();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Completed in ${duration}s\n`);

  for (const h of health) {
    console.log(`    ${h.available ? '🟢' : '🔴'} ${h.platform}: ${h.available ? 'reachable' : 'unreachable'}`);
  }

  assert('healthCheck returns 4 results', health.length === 4);
  assert('All results have platform string', health.every(h => typeof h.platform === 'string'));
  assert('All results have available boolean', health.every(h => typeof h.available === 'boolean'));

  const reachableCount = health.filter(h => h.available).length;
  console.log(`\n  ${reachableCount}/4 platforms reachable`);

  // 3. getAdapter — lazy initialization
  section('3. AdapterRegistry — getAdapter()');
  const twitch = registry.getAdapter('twitch');
  assert('getAdapter("twitch") returns adapter', twitch.platform === 'twitch');
  const kick = registry.getAdapter('kick');
  assert('getAdapter("kick") returns adapter', kick.platform === 'kick');
  // Getting same adapter again should return same instance
  const twitch2 = registry.getAdapter('twitch');
  assert('Same instance returned on second call', twitch === twitch2);

  // 4. getViewerCountsMultiPlatform — cross-platform query
  section('4. AdapterRegistry — getViewerCountsMultiPlatform()');
  const multiChannels = [
    { platform: 'twitch' as const, channelIdentifier: 'shroud' },
    { platform: 'twitch' as const, channelIdentifier: 'riotgames' },
    { platform: 'kick' as const, channelIdentifier: 'xqc' },
    { platform: 'kick' as const, channelIdentifier: 'nickmercs' },
  ];

  console.log(`  Querying ${multiChannels.length} channels across Twitch + Kick...`);
  const multiStart = Date.now();
  const multiResults = await registry.getViewerCountsMultiPlatform(multiChannels);
  const multiDuration = ((Date.now() - multiStart) / 1000).toFixed(1);
  console.log(`  Completed in ${multiDuration}s\n`);

  for (let i = 0; i < multiChannels.length; i++) {
    printSnapshot(multiChannels[i].platform, multiResults[i]);
  }

  assert('Returns correct number of results', multiResults.length === multiChannels.length);
  assert('Results in same order as input', multiResults[0].channelIdentifier === 'shroud' || multiResults[0].channelIdentifier === 'shroud');
  assert('All have channelIdentifier', multiResults.every(r => !!r.channelIdentifier));
  assert('All have numeric concurrentViewers', multiResults.every(r => typeof r.concurrentViewers === 'number'));
  assert('All have boolean isLive', multiResults.every(r => typeof r.isLive === 'boolean'));

  // 5. Empty input
  section('5. AdapterRegistry — Empty input');
  const emptyResults = await registry.getViewerCountsMultiPlatform([]);
  assert('Empty input returns empty array', emptyResults.length === 0);

  // 6. Shutdown
  section('6. AdapterRegistry — shutdown()');
  await registry.shutdown();
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
