/**
 * Verification script for the PollingOrchestrator.
 *
 * Tests:
 *  - Broadcast day status transitions (scheduled → live, live → completed)
 *  - executePollCycle() with real adapter data
 *  - Snapshot insertion into the database
 *  - getStatus() correctness
 *  - Idle cycle when no broadcast days are live
 *  - start() / stop() lifecycle
 *
 * Requires:
 *  - PostgreSQL running with clutch_viewership_test database
 *  - All API credentials in .env
 *
 * Usage: npx ts-node scripts/verify-polling-orchestrator.ts
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
  // Create a dedicated Knex instance for testing
  const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 1, max: 5 },
  });

  // Run migrations to ensure schema is current
  await db.migrate.latest({
    directory: './migrations',
  });

  // Clean up any previous test data
  await db('viewership_snapshots').delete();
  await db('post_event_metrics').delete();
  await db('channels').delete();
  await db('broadcast_days').delete();
  await db('stages').delete();
  await db('tournament_series').delete();

  // ═══════════════════════════════════════════════════════════════════════
  //  1. Setup test data
  // ═══════════════════════════════════════════════════════════════════════

  section('1. Setup — Insert test data');

  // Create a tournament series
  const [series] = await db('tournament_series').insert({
    name: 'PEC 2026 Test',
    game: 'Counter-Strike',
    partner: 'PGL',
    status: 'active',
    start_date: '2026-02-01',
    end_date: '2026-02-28',
  }).returning('*');
  console.log(`  Series: ${series.name} (${series.id})`);

  // Create a stage
  const [stage] = await db('stages').insert({
    series_id: series.id,
    name: 'Group Stage',
    order: 1,
    status: 'active',
    start_date: '2026-02-10',
    end_date: '2026-02-12',
  }).returning('*');
  console.log(`  Stage: ${stage.name} (${stage.id})`);

  // Create broadcast days:
  //   - Day 1: scheduled, broadcast_start in the past → should auto-transition to 'live'
  //   - Day 2: live (already active)
  //   - Day 3: live, broadcast_end in the past → should auto-transition to 'completed'
  const pastStart = new Date(Date.now() - 60 * 60_000); // 1 hour ago
  const pastEnd = new Date(Date.now() - 10 * 60_000);   // 10 minutes ago
  const futureEnd = new Date(Date.now() + 4 * 60 * 60_000); // 4 hours from now

  const [day1] = await db('broadcast_days').insert({
    stage_id: stage.id,
    series_id: series.id,
    label: 'Day 1 — Auto-Start',
    date: '2026-02-10',
    broadcast_start: pastStart,
    broadcast_end: futureEnd,
    status: 'scheduled',
  }).returning('*');

  const [day2] = await db('broadcast_days').insert({
    stage_id: stage.id,
    series_id: series.id,
    label: 'Day 2 — Already Live',
    date: '2026-02-10',
    broadcast_start: pastStart,
    broadcast_end: futureEnd,
    status: 'live',
  }).returning('*');

  const [day3] = await db('broadcast_days').insert({
    stage_id: stage.id,
    series_id: series.id,
    label: 'Day 3 — Should Complete',
    date: '2026-02-10',
    broadcast_start: new Date(Date.now() - 2 * 60 * 60_000),
    broadcast_end: pastEnd,
    status: 'live',
  }).returning('*');

  console.log(`  Day 1 (scheduled, start in past): ${day1.id}`);
  console.log(`  Day 2 (live): ${day2.id}`);
  console.log(`  Day 3 (live, end in past): ${day3.id}`);

  // Create channels (Twitch + Kick — they have credentials configured)
  const [ch1] = await db('channels').insert({
    series_id: series.id,
    platform: 'twitch',
    channel_identifier: 'shroud',
    display_name: 'shroud',
    language: 'en',
    region: 'NA',
    tier: 'primary',
    source: 'manual',
    is_active: true,
  }).returning('*');

  const [ch2] = await db('channels').insert({
    series_id: series.id,
    platform: 'twitch',
    channel_identifier: 'riotgames',
    display_name: 'Riot Games',
    language: 'en',
    region: 'NA',
    tier: 'primary',
    source: 'manual',
    is_active: true,
  }).returning('*');

  const [ch3] = await db('channels').insert({
    series_id: series.id,
    platform: 'kick',
    channel_identifier: 'xqc',
    display_name: 'xQc',
    language: 'en',
    region: 'NA',
    tier: 'secondary',
    source: 'manual',
    is_active: true,
  }).returning('*');

  // One inactive channel — should be skipped
  await db('channels').insert({
    series_id: series.id,
    platform: 'twitch',
    channel_identifier: 'inactive_channel',
    display_name: 'Inactive',
    language: 'en',
    region: 'NA',
    tier: 'community',
    source: 'manual',
    is_active: false,
  });

  console.log(`  Channels: ${ch1.display_name}, ${ch2.display_name}, ${ch3.display_name} + 1 inactive`);
  assert('Test data inserted', true);

  // ═══════════════════════════════════════════════════════════════════════
  //  2. Initialize orchestrator
  // ═══════════════════════════════════════════════════════════════════════

  section('2. PollingOrchestrator — Initialize');
  const registry = new AdapterRegistry();
  const orchestrator = new PollingOrchestrator(registry, db);
  assert('PollingOrchestrator instantiated', orchestrator instanceof PollingOrchestrator);

  const initialStatus = orchestrator.getStatus();
  assert('Initial state is stopped', initialStatus.state === 'stopped');
  assert('No last poll time', initialStatus.lastPollTime === null);
  assert('No last poll result', initialStatus.lastPollResult === null);

  // ═══════════════════════════════════════════════════════════════════════
  //  3. Execute poll cycle (triggers transitions + data fetch)
  // ═══════════════════════════════════════════════════════════════════════

  section('3. PollingOrchestrator — executePollCycle()');
  console.log('  Running poll cycle (this calls Twitch + Kick APIs)...');

  const result = await orchestrator.executePollCycle();

  console.log(`  Duration: ${result.duration}ms`);
  console.log(`  Channels polled: ${result.channelsPolled}`);
  console.log(`  Total CCV: ${result.totalCCV}`);
  console.log(`  Snapshots created: ${result.snapshotsCreated}`);
  console.log(`  Errors: ${result.errors.length > 0 ? result.errors.join(', ') : 'none'}`);

  assert('Result has timestamp', result.timestamp instanceof Date);
  assert('Polled 3 active channels (not inactive)', result.channelsPolled === 3);
  assert('Duration is reasonable', result.duration > 0 && result.duration < 30_000);
  assert('No errors in cycle', result.errors.length === 0);

  // ═══════════════════════════════════════════════════════════════════════
  //  4. Verify broadcast day status transitions
  // ═══════════════════════════════════════════════════════════════════════

  section('4. Verify status transitions');

  const day1After = await db('broadcast_days').where({ id: day1.id }).first();
  const day2After = await db('broadcast_days').where({ id: day2.id }).first();
  const day3After = await db('broadcast_days').where({ id: day3.id }).first();

  console.log(`  Day 1: ${day1.status} → ${day1After.status}`);
  console.log(`  Day 2: ${day2.status} → ${day2After.status}`);
  console.log(`  Day 3: ${day3.status} → ${day3After.status}`);

  assert('Day 1 transitioned scheduled → live', day1After.status === 'live');
  assert('Day 2 stayed live', day2After.status === 'live');
  assert('Day 3 transitioned live → completed', day3After.status === 'completed');

  // ═══════════════════════════════════════════════════════════════════════
  //  5. Verify snapshot records in database
  // ═══════════════════════════════════════════════════════════════════════

  section('5. Verify snapshots in database');

  const dbSnapshots = await db('viewership_snapshots')
    .where('series_id', series.id)
    .select('*');

  console.log(`  Total snapshots in DB: ${dbSnapshots.length}`);

  // Day 1 was transitioned to live BEFORE executePollCycle queries for active days,
  // and Day 3 was transitioned to completed, so active days = Day 1 + Day 2.
  // 3 channels × 2 active days = 6 snapshots
  assert('Correct number of snapshots (3 channels × 2 active days)', dbSnapshots.length === 6);

  // Check snapshot fields
  const sampleSnapshot = dbSnapshots[0];
  assert('Snapshot has channel_id', !!sampleSnapshot.channel_id);
  assert('Snapshot has broadcast_day_id', !!sampleSnapshot.broadcast_day_id);
  assert('Snapshot has stage_id', !!sampleSnapshot.stage_id);
  assert('Snapshot has series_id', sampleSnapshot.series_id === series.id);
  assert('Snapshot has timestamp', !!sampleSnapshot.timestamp);
  assert('Snapshot has concurrent_viewers (number)', typeof sampleSnapshot.concurrent_viewers === 'number');
  assert('Snapshot has platform', typeof sampleSnapshot.platform === 'string');

  // Verify snapshots span correct broadcast days (Day 1 and Day 2, not Day 3)
  const snapshotDayIds = [...new Set(dbSnapshots.map((s: { broadcast_day_id: string }) => s.broadcast_day_id))];
  console.log(`  Snapshot broadcast_day_ids: ${snapshotDayIds.join(', ')}`);
  assert('Snapshots only for Day 1 and Day 2', snapshotDayIds.length === 2);
  assert('No snapshots for completed Day 3', !snapshotDayIds.includes(day3.id));

  // Verify platforms present
  const platforms = [...new Set(dbSnapshots.map((s: { platform: string }) => s.platform))];
  console.log(`  Platforms in snapshots: ${platforms.join(', ')}`);
  assert('Both twitch and kick represented', platforms.includes('twitch') && platforms.includes('kick'));

  // ═══════════════════════════════════════════════════════════════════════
  //  6. Idle cycle — no live broadcast days
  // ═══════════════════════════════════════════════════════════════════════

  section('6. Idle cycle — complete all remaining days');

  // Transition all remaining days to completed
  await db('broadcast_days')
    .whereIn('id', [day1.id, day2.id, day3.id])
    .update({ status: 'completed' });

  const idleResult = await orchestrator.executePollCycle();
  console.log(`  Idle cycle: ${idleResult.channelsPolled} channels, ${idleResult.snapshotsCreated} snapshots, ${idleResult.duration}ms`);
  assert('Idle cycle polls 0 channels', idleResult.channelsPolled === 0);
  assert('Idle cycle creates 0 snapshots', idleResult.snapshotsCreated === 0);
  assert('Idle cycle has no errors', idleResult.errors.length === 0);

  // ═══════════════════════════════════════════════════════════════════════
  //  7. start() / stop() lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  section('7. start() / stop() lifecycle');

  orchestrator.start();
  const runningStatus = orchestrator.getStatus();
  assert('State is running after start()', runningStatus.state === 'running');

  // Starting again should be a no-op
  orchestrator.start();
  assert('Double start() is safe (no-op)', orchestrator.getStatus().state === 'running');

  orchestrator.stop();
  const stoppedStatus = orchestrator.getStatus();
  assert('State is stopped after stop()', stoppedStatus.state === 'stopped');

  // ═══════════════════════════════════════════════════════════════════════
  //  8. Cleanup
  // ═══════════════════════════════════════════════════════════════════════

  section('8. Cleanup');
  await registry.shutdown();
  await db('viewership_snapshots').delete();
  await db('post_event_metrics').delete();
  await db('channels').delete();
  await db('broadcast_days').delete();
  await db('stages').delete();
  await db('tournament_series').delete();
  await db.destroy();
  assert('Test data cleaned up', true);

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
