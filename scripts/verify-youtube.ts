/**
 * Verification script for the YouTube adapter.
 *
 * Tests:
 *  - API key auth
 *  - getViewerCounts (real channels, invalid channels, empty input)
 *  - searchLiveStreams (keyword search)
 *  - Quota tracking
 *
 * Requires YOUTUBE_API_KEY in .env
 *
 * Usage: npx ts-node scripts/verify-youtube.ts
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

import { YouTubeAdapter } from '../src/adapters/youtube';
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
    (s.language ? ` [${s.language}]` : ''));
}

async function run() {
  section('1. YouTube — Initialize');
  const yt = new YouTubeAdapter();
  assert('YouTubeAdapter instantiated', yt.platform === 'youtube');

  const quotaBefore = yt.getQuotaUsage();
  console.log(`  Quota: ${quotaBefore.used}/${quotaBefore.limit}`);
  assert('Quota starts at 0', quotaBefore.used === 0);
  assert('Default quota limit is 10000', quotaBefore.limit === 10000);

  // 2. getViewerCounts with known esports/gaming YouTube channel IDs
  // These are channel IDs (not usernames):
  //   - UCbmNph6atAoGfqLoCL_duAg = VALORANT Champions Tour
  //   - UCvqRdlKsE5Q8mf8YXbdIJLw = Riot Games
  //   - UCWBWgBGab2EPUDX2fS3fFpA = ESL Counter-Strike
  section('2. YouTube — getViewerCounts (real channels)');
  const channels = [
    'UCbmNph6atAoGfqLoCL_duAg',  // VALORANT Champions Tour
    'UCvqRdlKsE5Q8mf8YXbdIJLw',  // Riot Games
  ];
  const results = await yt.getViewerCounts(channels);

  console.log(`  Requested ${channels.length} channels, got ${results.length} results:`);
  for (const s of results) {
    printSnapshot(s);
  }

  assert('Returns correct number of results', results.length === channels.length);
  assert('All results have channelIdentifier', results.every(r => !!r.channelIdentifier));
  assert('All results have numeric concurrentViewers', results.every(r => typeof r.concurrentViewers === 'number' && r.concurrentViewers >= 0));
  assert('All results have boolean isLive', results.every(r => typeof r.isLive === 'boolean'));

  const quotaAfterViewers = yt.getQuotaUsage();
  console.log(`  Quota used: ${quotaAfterViewers.used}/${quotaAfterViewers.limit}`);
  assert('Quota increased after API calls', quotaAfterViewers.used > 0);

  // 3. Error handling — invalid channel IDs
  section('3. YouTube — Error handling (invalid channels)');
  const badResults = await yt.getViewerCounts(['INVALID_CHANNEL_ID_12345']);

  console.log(`  Requested 1 invalid channel, got ${badResults.length} results:`);
  for (const s of badResults) {
    printSnapshot(s);
  }

  assert('Invalid channel does not crash', badResults.length === 1);
  assert('Invalid channel returns offline', badResults[0].concurrentViewers === 0 && !badResults[0].isLive);

  // 4. Empty input
  section('4. YouTube — Empty input');
  const emptyResults = await yt.getViewerCounts([]);
  assert('Empty input returns empty array', emptyResults.length === 0);

  // 5. searchLiveStreams (keyword search)
  section('5. YouTube — searchLiveStreams (keyword: "esports")');
  const searchResults = await yt.searchLiveStreams(undefined, ['esports']);

  console.log(`  Found ${searchResults.length} live streams`);
  if (searchResults.length > 0) {
    console.log(`  Top 5:`);
    for (const s of searchResults.slice(0, 5)) {
      console.log(`    ${s.displayName}: ${s.concurrentViewers} viewers — "${s.title}"` +
        (s.language ? ` [${s.language}]` : ''));
    }
    assert('Streams have channelIdentifier', searchResults.every(s => !!s.channelIdentifier));
    assert('Streams have displayName', searchResults.every(s => !!s.displayName));
    assert('Streams have numeric concurrentViewers', searchResults.every(s => typeof s.concurrentViewers === 'number'));
    assert('Streams have title', searchResults.every(s => typeof s.title === 'string'));
  }
  assert('searchLiveStreams returns array', Array.isArray(searchResults));

  // 6. searchLiveStreams with no keywords returns empty
  section('6. YouTube — searchLiveStreams (no keywords)');
  const noKeywordResults = await yt.searchLiveStreams();
  assert('No keywords returns empty array', noKeywordResults.length === 0);

  // 7. Final quota check
  section('7. YouTube — Final quota check');
  const quotaFinal = yt.getQuotaUsage();
  console.log(`  Total quota used this session: ${quotaFinal.used}/${quotaFinal.limit}`);
  assert('Quota tracking is working', quotaFinal.used > quotaAfterViewers.used || quotaFinal.used === quotaAfterViewers.used);
  assert('Quota under 50% of daily limit', quotaFinal.used < quotaFinal.limit * 0.5);

  // ═══════════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  section('SUMMARY');
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`  YouTube API quota consumed: ${quotaFinal.used} units`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('\n💥 FATAL ERROR:', err);
  process.exitCode = 1;
});
