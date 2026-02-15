/**
 * Polling orchestrator verification script.
 *
 * Seeds real test data, runs poll cycles against live Twitch API,
 * and confirms snapshots are written with correct FKs and denormalized fields.
 *
 * Requires: PostgreSQL (clutch_viewership_test), TWITCH_CLIENT_ID/SECRET in .env
 *
 * Usage: npx ts-node scripts/verify-polling.ts
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/clutch_viewership_test';

import knex from 'knex';
import { AdapterRegistry } from '../src/adapters';
import { PollingOrchestrator } from '../src/services/polling-orchestrator';

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

async function run() {
  const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 1, max: 5 },
  });

  // Ensure schema is current
  await db.migrate.latest({ directory: './migrations' });

  // Clean slate
  await db('viewership_snapshots').delete();
  await db('post_event_metrics').delete();
  await db('channels').delete();
  await db('broadcast_days').delete();
  await db('stages').delete();
  await db('tournament_series').delete();

  // ═══════════════════════════════════════════════════════════════════════
  //  (a) Seed database with test data
  // ═══════════════════════════════════════════════════════════════════════

  section('(a) Seed database');

  const [series] = await db('tournament_series').insert({
    name: 'IEM Katowice 2026 — Test',
    short_name: 'IEM KAT',
    game: 'Counter-Strike',
    partner: 'ESL',
    status: 'active',
    start_date: '2026-02-10',
    end_date: '2026-02-15',
  }).returning('*');
  console.log(`  Series: ${series.name} (${series.id})`);

  const [stage] = await db('stages').insert({
    series_id: series.id,
    name: 'Playoffs',
    order: 1,
    status: 'active',
    start_date: '2026-02-10',
    end_date: '2026-02-12',
  }).returning('*');
  console.log(`  Stage: ${stage.name} (${stage.id})`);

  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60_000);

  const [broadcastDay] = await db('broadcast_days').insert({
    stage_id: stage.id,
    series_id: series.id,
    label: 'Playoff Day 1',
    date: '2026-02-10',
    broadcast_start: oneHourAgo,
    broadcast_end: twoHoursFromNow,
    status: 'live',
  }).returning('*');
  console.log(`  Broadcast Day: ${broadcastDay.label} (${broadcastDay.id}) — status: ${broadcastDay.status}`);

  // 2 real Twitch channels (high likelihood of existing, may or may not be live)
  const [ch1] = await db('channels').insert({
    series_id: series.id,
    platform: 'twitch',
    channel_identifier: 'esl_csgo',
    display_name: 'ESL CS:GO',
    language: 'en',
    region: 'EU',
    tier: 'primary',
    source: 'manual',
    is_active: true,
  }).returning('*');

  const [ch2] = await db('channels').insert({
    series_id: series.id,
    platform: 'twitch',
    channel_identifier: 'shroud',
    display_name: 'shroud',
    language: 'en',
    region: 'NA',
    tier: 'secondary',
    source: 'manual',
    is_active: true,
  }).returning('*');

  console.log(`  Channel 1: ${ch1.display_name} [${ch1.platform}] (${ch1.id})`);
  console.log(`  Channel 2: ${ch2.display_name} [${ch2.platform}] (${ch2.id})`);
  assert('Test data seeded', true);

  // ═══════════════════════════════════════════════════════════════════════
  //  (b) Initialize registry + orchestrator
  // ═══════════════════════════════════════════════════════════════════════

  section('(b) Initialize AdapterRegistry + PollingOrchestrator');

  const registry = new AdapterRegistry();
  const orchestrator = new PollingOrchestrator(registry, db);
  assert('Registry created', registry instanceof AdapterRegistry);
  assert('Orchestrator created', orchestrator instanceof PollingOrchestrator);

  // ═══════════════════════════════════════════════════════════════════════
  //  (c) First poll cycle
  // ═══════════════════════════════════════════════════════════════════════

  section('(c) First executePollCycle()');
  console.log('  Calling Twitch API for esl_csgo + shroud...');

  const result1 = await orchestrator.executePollCycle();

  // (d) Print the PollCycleResult
  section('(d) PollCycleResult — first cycle');
  console.log(`  timestamp:        ${result1.timestamp.toISOString()}`);
  console.log(`  channelsPolled:   ${result1.channelsPolled}`);
  console.log(`  totalCCV:         ${result1.totalCCV}`);
  console.log(`  snapshotsCreated: ${result1.snapshotsCreated}`);
  console.log(`  errors:           ${result1.errors.length > 0 ? result1.errors.join(', ') : 'none'}`);
  console.log(`  duration:         ${result1.duration}ms`);

  assert('channelsPolled = 2', result1.channelsPolled === 2);
  assert('snapshotsCreated = 2 (2 channels × 1 broadcast day)', result1.snapshotsCreated === 2);
  assert('No errors', result1.errors.length === 0);
  assert('totalCCV is a number ≥ 0', typeof result1.totalCCV === 'number' && result1.totalCCV >= 0);
  assert('Duration > 0', result1.duration > 0);

  // ═══════════════════════════════════════════════════════════════════════
  //  (e)+(f) Query viewership_snapshots and print them
  // ═══════════════════════════════════════════════════════════════════════

  section('(e)/(f) Query + print inserted snapshots');

  const snapshots1 = await db('viewership_snapshots')
    .where('viewership_snapshots.series_id', series.id)
    .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
    .select(
      'viewership_snapshots.id as snapshot_id',
      'viewership_snapshots.channel_id',
      'viewership_snapshots.broadcast_day_id',
      'viewership_snapshots.stage_id',
      'viewership_snapshots.series_id',
      'viewership_snapshots.timestamp',
      'viewership_snapshots.concurrent_viewers',
      'viewership_snapshots.platform',
      'viewership_snapshots.language',
      'viewership_snapshots.region',
      'channels.display_name',
      'channels.channel_identifier',
    )
    .orderBy('viewership_snapshots.platform');

  console.log(`\n  ${snapshots1.length} snapshot(s) found:\n`);
  for (const s of snapshots1) {
    console.log(`    📊 ${s.display_name} (${s.channel_identifier})`);
    console.log(`       platform: ${s.platform} | viewers: ${s.concurrent_viewers} | lang: ${s.language} | region: ${s.region}`);
    console.log(`       timestamp: ${new Date(s.timestamp).toISOString()}`);
    console.log(`       channel_id:       ${s.channel_id}`);
    console.log(`       broadcast_day_id: ${s.broadcast_day_id}`);
    console.log(`       stage_id:         ${s.stage_id}`);
    console.log(`       series_id:        ${s.series_id}`);
    console.log();
  }

  assert('2 snapshots in database', snapshots1.length === 2);

  // (3) Confirm correct foreign keys
  for (const s of snapshots1) {
    assert(`FK: ${s.channel_identifier} channel_id matches`, s.channel_id === ch1.id || s.channel_id === ch2.id);
    assert(`FK: ${s.channel_identifier} broadcast_day_id matches`, s.broadcast_day_id === broadcastDay.id);
    assert(`FK: ${s.channel_identifier} stage_id matches`, s.stage_id === stage.id);
    assert(`FK: ${s.channel_identifier} series_id matches`, s.series_id === series.id);
  }

  // (4) Confirm denormalized fields
  for (const s of snapshots1) {
    assert(`Denorm: ${s.channel_identifier} platform populated`, s.platform === 'twitch');
    assert(`Denorm: ${s.channel_identifier} language populated`, s.language === 'en');
    assert(`Denorm: ${s.channel_identifier} region populated`, s.region === 'EU' || s.region === 'NA');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  (g) Second poll cycle — confirm repeatable
  // ═══════════════════════════════════════════════════════════════════════

  section('(g) Second executePollCycle()');

  const result2 = await orchestrator.executePollCycle();

  console.log(`  snapshotsCreated: ${result2.snapshotsCreated}`);
  console.log(`  totalCCV:         ${result2.totalCCV}`);
  console.log(`  duration:         ${result2.duration}ms`);

  assert('Second cycle also created 2 snapshots', result2.snapshotsCreated === 2);
  assert('Second cycle had no errors', result2.errors.length === 0);

  // ═══════════════════════════════════════════════════════════════════════
  //  (h) Confirm second poll created NEW records (not duplicates)
  // ═══════════════════════════════════════════════════════════════════════

  section('(h) Confirm new records, not duplicates');

  const allSnapshots = await db('viewership_snapshots')
    .where('series_id', series.id)
    .select('id', 'timestamp', 'channel_id', 'concurrent_viewers');

  console.log(`  Total snapshots after 2 cycles: ${allSnapshots.length}`);

  assert('Total snapshots = 4 (2 per cycle × 2 cycles)', allSnapshots.length === 4);

  // All 4 should have unique IDs
  const uniqueIds = new Set(allSnapshots.map((s: { id: string }) => s.id));
  assert('All 4 snapshots have unique IDs', uniqueIds.size === 4);

  // Should have 2 distinct timestamps (one per cycle)
  const uniqueTimestamps = new Set(allSnapshots.map((s: { timestamp: Date }) => new Date(s.timestamp).getTime()));
  assert('2 distinct timestamps (one per cycle)', uniqueTimestamps.size === 2);

  // ═══════════════════════════════════════════════════════════════════════
  //  (i) Auto-status-transition: live → completed
  // ═══════════════════════════════════════════════════════════════════════

  section('(i) Auto-transition: live → completed');

  const oneHourAgoPast = new Date(Date.now() - 60 * 60_000);

  const [expiredDay] = await db('broadcast_days').insert({
    stage_id: stage.id,
    series_id: series.id,
    label: 'Expired Day — Should Complete',
    date: '2026-02-09',
    broadcast_start: new Date(Date.now() - 3 * 60 * 60_000), // 3 hours ago
    broadcast_end: oneHourAgoPast,                             // 1 hour ago
    status: 'live',
  }).returning('*');

  console.log(`  Created expired broadcast day: ${expiredDay.id} (status: ${expiredDay.status})`);

  // Run a cycle — transitions should happen first
  const result3 = await orchestrator.executePollCycle();
  console.log(`  Cycle 3: ${result3.channelsPolled} channels, ${result3.snapshotsCreated} snapshots`);

  // Verify the expired day was transitioned
  const expiredDayAfter = await db('broadcast_days').where({ id: expiredDay.id }).first();
  console.log(`  Expired day status: ${expiredDay.status} → ${expiredDayAfter.status}`);

  assert('Expired broadcast day transitioned to completed', expiredDayAfter.status === 'completed');

  // The expired day should NOT have any snapshots (it was completed before polling)
  const expiredDaySnapshots = await db('viewership_snapshots')
    .where('broadcast_day_id', expiredDay.id)
    .select('id');
  assert('No snapshots for expired/completed day', expiredDaySnapshots.length === 0);

  // The original live day should still get snapshots
  assert('Cycle 3 still polled 2 channels (original live day)', result3.channelsPolled === 2);
  assert('Cycle 3 created 2 snapshots for the still-live day', result3.snapshotsCreated === 2);

  // ═══════════════════════════════════════════════════════════════════════
  //  (j) Cleanup
  // ═══════════════════════════════════════════════════════════════════════

  section('(j) Cleanup');

  await db('viewership_snapshots').delete();
  await db('post_event_metrics').delete();
  await db('channels').delete();
  await db('broadcast_days').delete();
  await db('stages').delete();
  await db('tournament_series').delete();
  assert('Test data cleaned up', true);

  // ═══════════════════════════════════════════════════════════════════════
  //  (k) Shutdown
  // ═══════════════════════════════════════════════════════════════════════

  section('(k) Shutdown');

  await registry.shutdown();
  await db.destroy();
  assert('AdapterRegistry shut down', true);
  assert('Database connection destroyed', true);

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
