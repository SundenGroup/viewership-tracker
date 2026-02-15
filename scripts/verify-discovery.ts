/**
 * DiscoveryService verification script.
 *
 * Uses direct imports (not the API server) so we can construct
 * DiscoveryService instances with custom thresholds.
 *
 * Tests:
 *   a. Seed a test series with discovery_keywords and Twitch game ID for PUBG
 *   b. Create a broadcast day with status 'live'
 *   c. Run executeDiscoveryCycle once, print DiscoveryResult
 *   d. Query channels table, print any auto-discovered channels
 *   e. Blocklist test: block one channel, run discovery again, confirm not re-added
 *   f. Threshold test: create service with threshold=999999, run discovery, confirm nothing added
 *   g. Cleanup
 *
 * The test passes even if no streams are discovered (PUBG may not be live).
 * The key validation is that the service runs without errors and the logic works.
 *
 * Requires:
 *   - PostgreSQL (clutch_viewership_test)
 *   - Twitch credentials in .env
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/clutch_viewership_test \
 *     npx ts-node scripts/verify-discovery.ts
 */

import knex from 'knex';
import { config } from '../src/utils/config';
import { AdapterRegistry } from '../src/adapters';
import { DiscoveryService } from '../src/services/discovery-service';

// ── DB connection ────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL || config.database.url;
const db = knex({ client: 'pg', connection: dbUrl, pool: { min: 1, max: 4 } });

// ── Helpers ──────────────────────────────────────────────────────────

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
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

// ── Main ─────────────────────────────────────────────────────────────

async function run() {
  const registry = new AdapterRegistry();

  // ═══════════════════════════════════════════════════════════════════
  // (a) Seed a test series
  // ═══════════════════════════════════════════════════════════════════
  section('(a) Seed test series with PUBG keywords');

  const [series] = await db('tournament_series')
    .insert({
      name: 'PEC 2026 Discovery Test',
      short_name: 'PEC26',
      game: 'PUBG',
      partner: 'PEC',
      status: 'active',
      start_date: '2026-02-10',
      end_date: '2026-02-12',
      discovery_keywords: JSON.stringify(['PUBG', 'PEC']),
      discovery_game_ids: JSON.stringify({ twitch: '493057' }),
    })
    .returning('*');

  console.log(`  Series: ${series.name} (${series.id})`);
  console.log(`  Keywords: ${JSON.stringify(series.discovery_keywords)}`);
  console.log(`  Game IDs: ${JSON.stringify(series.discovery_game_ids)}`);

  assert('Series created', !!series.id);
  assert('discovery_keywords = ["PUBG","PEC"]',
    Array.isArray(series.discovery_keywords) && series.discovery_keywords.length === 2);
  assert('discovery_game_ids.twitch = 493057', series.discovery_game_ids?.twitch === '493057');

  const seriesId = series.id;

  // ═══════════════════════════════════════════════════════════════════
  // (b) Create stage + broadcast day → set live
  // ═══════════════════════════════════════════════════════════════════
  section('(b) Create broadcast day with status live');

  const [stage] = await db('stages')
    .insert({
      series_id: seriesId,
      name: 'Group Stage',
      order: 1,
      status: 'active',
    })
    .returning('*');

  assert('Stage created', !!stage.id);

  const now = new Date();
  const [day] = await db('broadcast_days')
    .insert({
      stage_id: stage.id,
      series_id: seriesId,
      label: 'Day 1',
      date: '2026-02-10',
      status: 'live',
      broadcast_start: new Date(now.getTime() - 60 * 60_000),
      broadcast_end: new Date(now.getTime() + 3 * 60 * 60_000),
    })
    .returning('*');

  console.log(`  Broadcast day: ${day.label} (${day.id}) — status: ${day.status}`);
  assert('Broadcast day created', !!day.id);
  assert('Broadcast day is live', day.status === 'live');

  // ═══════════════════════════════════════════════════════════════════
  // (c) Run executeDiscoveryCycle once
  // ═══════════════════════════════════════════════════════════════════
  section('(c) Run executeDiscoveryCycle');

  const discoveryService = new DiscoveryService(registry, db);
  const result = await discoveryService.executeDiscoveryCycle(seriesId);

  console.log(`\n  DiscoveryResult:`);
  console.log(`    seriesId:       ${result.seriesId}`);
  console.log(`    timestamp:      ${result.timestamp}`);
  console.log(`    discovered:     ${result.discovered}`);
  console.log(`    added:          ${result.added}`);
  console.log(`    alreadyTracked: ${result.alreadyTracked}`);
  console.log(`    belowThreshold: ${result.belowThreshold}`);
  console.log(`    blocked:        ${result.blocked}`);
  console.log(`    errors:         ${result.errors.length > 0 ? result.errors.join('; ') : 'none'}`);
  console.log(`    duration:       ${result.duration}ms`);

  assert('seriesId matches', result.seriesId === seriesId);
  assert('timestamp is a Date', result.timestamp instanceof Date);
  assert('discovered >= 0', typeof result.discovered === 'number' && result.discovered >= 0);
  assert('added >= 0', typeof result.added === 'number' && result.added >= 0);
  assert('alreadyTracked >= 0', typeof result.alreadyTracked === 'number' && result.alreadyTracked >= 0);
  assert('belowThreshold >= 0', typeof result.belowThreshold === 'number' && result.belowThreshold >= 0);
  assert('blocked >= 0', typeof result.blocked === 'number' && result.blocked >= 0);
  assert('errors is an array', Array.isArray(result.errors));
  assert('duration > 0', result.duration > 0);
  assert('Bucket counts add up',
    result.added + result.alreadyTracked + result.belowThreshold + result.blocked <= result.discovered);

  const discoveredSome = result.added > 0;
  if (discoveredSome) {
    console.log(`\n  ✔ Streams were discovered and added!`);
  } else {
    console.log(`\n  ⚠ No streams added — PUBG may not have qualifying live streams right now (this is OK)`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // (d) Query channels table — print auto-discovered channels
  // ═══════════════════════════════════════════════════════════════════
  section('(d) Query channels table');

  const channels = await db('channels')
    .where({ series_id: seriesId })
    .orderBy('display_name', 'asc');

  console.log(`  Total channels for series: ${channels.length}`);

  const autoDiscovered = channels.filter((ch: { source: string }) => ch.source === 'auto_discovered');
  console.log(`  auto_discovered channels: ${autoDiscovered.length}`);

  assert('Channel count matches result.added', autoDiscovered.length === result.added);

  if (autoDiscovered.length > 0) {
    console.log(`\n  Discovered channels:`);
    for (const ch of autoDiscovered.slice(0, 10)) {
      console.log(`    ${ch.display_name} [${ch.platform}] — tier=${ch.tier}, active=${ch.is_active}, lang=${ch.language ?? '?'}`);
    }
    if (autoDiscovered.length > 10) {
      console.log(`    ... and ${autoDiscovered.length - 10} more`);
    }

    const allCorrect = autoDiscovered.every(
      (ch: { source: string; tier: string; is_active: boolean }) =>
        ch.source === 'auto_discovered' && ch.tier === 'community' && ch.is_active === true,
    );
    assert('All: source=auto_discovered, tier=community, is_active=true', allCorrect);
  }

  // ═══════════════════════════════════════════════════════════════════
  // (e) Blocklist test
  // ═══════════════════════════════════════════════════════════════════
  section('(e) Blocklist test');

  if (autoDiscovered.length > 0) {
    const target = autoDiscovered[0];
    console.log(`  Blocking: ${target.display_name} (${target.channel_identifier})`);

    await discoveryService.blockChannel(seriesId, target.id);

    // Verify channel is deactivated
    const blockedRow = await db('channels').where('id', target.id).first();
    assert('Channel is_active = false after block', blockedRow.is_active === false);

    // Verify blocklist stored in series metadata
    const updatedSeries = await db('tournament_series').where('id', seriesId).first();
    const meta = updatedSeries.metadata ?? {};
    assert('Blocklist exists in metadata', Array.isArray(meta.blocklist));
    assert('Blocklist contains identifier',
      (meta.blocklist as string[]).includes(target.channel_identifier.toLowerCase()));

    // Run discovery again
    console.log(`\n  Re-running discovery after blocking...`);
    const result2 = await discoveryService.executeDiscoveryCycle(seriesId);
    console.log(`    discovered=${result2.discovered} added=${result2.added} alreadyTracked=${result2.alreadyTracked} blocked=${result2.blocked}`);

    // The blocked channel is still in the channels table (just deactivated).
    // On re-discovery it should be counted as alreadyTracked (since it's
    // still in the DB — the trackedSet lookup doesn't care about is_active).
    const blockedAfter = await db('channels').where('id', target.id).first();
    assert('Blocked channel still inactive after re-discovery', blockedAfter.is_active === false);

    // Ensure the blocked channel wasn't re-activated
    const reActive = await db('channels')
      .where({ series_id: seriesId, channel_identifier: target.channel_identifier, is_active: true })
      .first();
    assert('Blocked channel NOT re-added as active', !reActive);
  } else {
    console.log('  ⚠ No channels discovered — skipping blocklist test (this is OK)');

    // Still validate the blocklist storage mechanism
    await db('tournament_series').where('id', seriesId).update({
      metadata: JSON.stringify({ blocklist: ['dummy_blocked_channel'] }),
      updated_at: db.fn.now(),
    });
    const checkMeta = await db('tournament_series').where('id', seriesId).first();
    assert('Blocklist metadata read/write works',
      (checkMeta.metadata as { blocklist: string[] }).blocklist[0] === 'dummy_blocked_channel');
  }

  // ═══════════════════════════════════════════════════════════════════
  // (f) Threshold test — threshold=999999, nothing should be added
  // ═══════════════════════════════════════════════════════════════════
  section('(f) Threshold test (minViewerThreshold = 999999)');

  // Clear all channels so nothing is "already tracked"
  const deletedCount = await db('channels').where('series_id', seriesId).delete();
  console.log(`  Cleared ${deletedCount} existing channel(s)`);

  // Clear blocklist so it doesn't interfere
  await db('tournament_series').where('id', seriesId).update({
    metadata: JSON.stringify({}),
    updated_at: db.fn.now(),
  });

  const highThresholdService = new DiscoveryService(registry, db, 999999);
  const result3 = await highThresholdService.executeDiscoveryCycle(seriesId);

  console.log(`  discovered=${result3.discovered} added=${result3.added} belowThreshold=${result3.belowThreshold}`);

  assert('Zero channels added with threshold=999999', result3.added === 0);

  if (result3.discovered > 0) {
    assert('All discovered fell below threshold',
      result3.belowThreshold === result3.discovered - result3.alreadyTracked - result3.blocked);
  } else {
    console.log('  ⚠ No streams discovered — threshold test is vacuously true (this is OK)');
  }

  // Confirm nothing in the DB
  const countAfter = await db('channels')
    .where('series_id', seriesId)
    .count('* as count')
    .first();
  assert('Zero channels in DB after high-threshold run',
    parseInt(countAfter?.count as string ?? '0', 10) === 0);

  // ═══════════════════════════════════════════════════════════════════
  // (g) Cleanup
  // ═══════════════════════════════════════════════════════════════════
  section('(g) Cleanup');

  await db('viewership_snapshots').where('series_id', seriesId).delete();
  await db('channels').where('series_id', seriesId).delete();
  await db('broadcast_days').where('series_id', seriesId).delete();
  await db('stages').where('series_id', seriesId).delete();
  await db('tournament_series').where('id', seriesId).delete();

  const gone = await db('tournament_series').where('id', seriesId).first();
  assert('Series deleted', !gone);

  // ═══════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  section('SUMMARY');
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);

  if (failed > 0) {
    process.exitCode = 1;
  }

  await registry.shutdown();
  await db.destroy();
}

run().catch(async (err) => {
  console.error('\n💥 FATAL ERROR:', err.message, err.stack);
  process.exitCode = 1;
  await db.destroy();
});
