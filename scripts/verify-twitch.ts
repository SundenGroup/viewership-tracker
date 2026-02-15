/**
 * Verification script for the Twitch adapter.
 *
 * Tests:
 *  - OAuth2 client credentials auth
 *  - getViewerCounts (real channels, invalid channels, empty input)
 *  - searchLiveStreams (top streams, with game filter)
 *  - getGameId (valid and invalid game names)
 *
 * Requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env
 *
 * Usage: npx ts-node scripts/verify-twitch.ts
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

import { TwitchAdapter } from '../src/adapters/twitch';
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
  //  TWITCH ADAPTER
  // ═══════════════════════════════════════════════════════════════════════

  section('1. Twitch — Initialize');
  const twitch = new TwitchAdapter();
  assert('TwitchAdapter instantiated', twitch.platform === 'twitch');

  // 1. getViewerCounts with well-known channels (some likely live)
  section('2. Twitch — getViewerCounts (real channels)');
  const channels = ['shroud', 'pokimane', 'summit1g', 'valorant', 'riotgames'];
  const results = await twitch.getViewerCounts(channels);

  console.log(`  Requested ${channels.length} channels, got ${results.length} results:`);
  for (const s of results) {
    printSnapshot(s);
  }

  assert('Returns correct number of results', results.length === channels.length);
  assert('All results have channelIdentifier', results.every(r => !!r.channelIdentifier));
  assert('All results have numeric concurrentViewers', results.every(r => typeof r.concurrentViewers === 'number' && r.concurrentViewers >= 0));
  assert('All results have boolean isLive', results.every(r => typeof r.isLive === 'boolean'));
  assert('Live channels have gameName', results.filter(r => r.isLive).every(r => typeof r.gameName === 'string'));
  assert('Live channels have startedAt', results.filter(r => r.isLive).every(r => typeof r.startedAt === 'string'));

  // 2. Error handling — invalid channel names
  section('3. Twitch — Error handling (invalid channels)');
  const badResults = await twitch.getViewerCounts(['__nonexistent_channel_12345__', '!!!invalid!!!']);

  console.log(`  Requested 2 invalid channels, got ${badResults.length} results:`);
  for (const s of badResults) {
    printSnapshot(s);
  }

  assert('Invalid channels do not crash', badResults.length === 2);
  assert('Invalid channels return offline', badResults.every(r => r.concurrentViewers === 0 && !r.isLive));

  // 3. Empty input
  section('4. Twitch — Empty input');
  const emptyResults = await twitch.getViewerCounts([]);
  assert('Empty input returns empty array', emptyResults.length === 0);

  // 4. getGameId — valid game
  section('5. Twitch — getGameId (valid game)');
  const csGameId = await twitch.getGameId('Counter-Strike');
  console.log(`  "Counter-Strike" → gameId: ${csGameId}`);
  assert('getGameId returns non-null for valid game', csGameId !== null);
  assert('gameId is a string of digits', csGameId !== null && /^\d+$/.test(csGameId));

  // Try a second game
  const valGameId = await twitch.getGameId('VALORANT');
  console.log(`  "VALORANT" → gameId: ${valGameId}`);
  assert('getGameId returns non-null for VALORANT', valGameId !== null);

  // 5. getGameId — invalid game
  section('6. Twitch — getGameId (invalid game)');
  const badGameId = await twitch.getGameId('ThisGameDoesNotExist12345');
  console.log(`  "ThisGameDoesNotExist12345" → gameId: ${badGameId}`);
  assert('getGameId returns null for nonexistent game', badGameId === null);

  // 6. searchLiveStreams — top streams (no filter)
  section('7. Twitch — searchLiveStreams (top streams)');
  const topStreams = await twitch.searchLiveStreams();
  console.log(`  Found ${topStreams.length} top streams`);
  if (topStreams.length > 0) {
    console.log(`  Top 5:`);
    for (const s of topStreams.slice(0, 5)) {
      console.log(`    ${s.channelIdentifier}: ${s.concurrentViewers} viewers — "${s.title}" [${s.language}]`);
    }
  }
  assert('searchLiveStreams returns array', Array.isArray(topStreams));
  assert('searchLiveStreams returns streams', topStreams.length > 0);
  assert('Streams have channelIdentifier', topStreams.every(s => !!s.channelIdentifier));
  assert('Streams have concurrentViewers', topStreams.every(s => typeof s.concurrentViewers === 'number'));
  assert('Streams sorted by viewers (desc)', topStreams.length < 2 || topStreams[0].concurrentViewers >= topStreams[1].concurrentViewers);

  // 7. searchLiveStreams — with game filter
  section('8. Twitch — searchLiveStreams (game filter)');
  if (valGameId) {
    const valStreams = await twitch.searchLiveStreams(valGameId);
    console.log(`  Found ${valStreams.length} VALORANT streams`);
    if (valStreams.length > 0) {
      console.log(`  Top 3:`);
      for (const s of valStreams.slice(0, 3)) {
        console.log(`    ${s.channelIdentifier}: ${s.concurrentViewers} viewers — "${s.title}"`);
      }
    }
    assert('Game-filtered search returns streams', valStreams.length > 0);
  } else {
    console.log('  Skipped (VALORANT gameId not found)');
  }

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
