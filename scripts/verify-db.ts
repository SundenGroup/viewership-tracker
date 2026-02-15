/**
 * Database verification script
 *
 * Runs migrations, inserts sample data matching PEC 2026 spec,
 * exercises all aggregation queries, tests scope filtering and
 * cascade deletes, then cleans up.
 *
 * Usage: DATABASE_URL=postgresql://localhost/clutch_viewership_test npx ts-node scripts/verify-db.ts
 */
import knex from 'knex';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/clutch_viewership_test';

const db = knex({
  client: 'pg',
  connection: TEST_DB_URL,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  try {
    // ── 1. Run migrations ─────────────────────────────────────────────────
    section('1. Running migrations');
    await db.migrate.latest({
      directory: './migrations',
      extension: 'ts',
    });
    console.log('  Migrations applied successfully.');

    // Verify all tables exist
    const tables = await db.raw(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tableNames: string[] = tables.rows.map((r: { table_name: string }) => r.table_name);
    console.log(`  Tables: ${tableNames.join(', ')}`);

    const expected = [
      'broadcast_days', 'channels', 'knex_migrations', 'knex_migrations_lock',
      'post_event_metrics', 'stages', 'tournament_series', 'viewership_snapshots',
    ];
    for (const t of expected) {
      assert(`Table "${t}" exists`, tableNames.includes(t));
    }

    // ── 2. Insert sample tournament series ────────────────────────────────
    section('2. Inserting PEC 2026 sample data');

    const [series] = await db('tournament_series').insert({
      name: 'PUBG EMEA Championship 2026',
      short_name: 'PEC 2026',
      game: 'PUBG: Battlegrounds',
      partner: 'Krafton',
      status: 'active',
      start_date: '2026-03-01',
      end_date: '2026-04-15',
      discovery_keywords: JSON.stringify(['PEC', 'PUBG EMEA', 'PEC 2026']),
      discovery_game_ids: JSON.stringify({ twitch: '493057', youtube: 'PUBG' }),
    }).returning('*');
    console.log(`  Series: ${series.name} (${series.id})`);
    assert('Series created', !!series.id);

    // 4 stages
    const stageNames = ['Group Stage', 'Playoffs Week 1', 'Playoffs Week 2', 'Grand Finals'];
    const stages = [];
    for (let i = 0; i < stageNames.length; i++) {
      const [stage] = await db('stages').insert({
        series_id: series.id,
        name: stageNames[i],
        order: i + 1,
        start_date: `2026-03-${String(1 + i * 7).padStart(2, '0')}`,
        end_date: `2026-03-${String(3 + i * 7).padStart(2, '0')}`,
        status: i === 0 ? 'completed' : 'draft',
      }).returning('*');
      stages.push(stage);
    }
    assert('4 stages created', stages.length === 4);
    console.log(`  Stages: ${stages.map(s => s.name).join(', ')}`);

    // 3 broadcast days per stage = 12 total
    const broadcastDays = [];
    for (const stage of stages) {
      for (let d = 0; d < 3; d++) {
        const dayNum = d + 1;
        const dateOffset = (stage.order - 1) * 7 + d;
        const date = `2026-03-${String(1 + dateOffset).padStart(2, '0')}`;
        const [day] = await db('broadcast_days').insert({
          stage_id: stage.id,
          series_id: series.id,
          label: `${stage.name} — Day ${dayNum}`,
          date,
          broadcast_start: `${date}T14:00:00Z`,
          broadcast_end: `${date}T22:00:00Z`,
          status: stage.status === 'completed' ? 'completed' : 'scheduled',
        }).returning('*');
        broadcastDays.push(day);
      }
    }
    assert('12 broadcast days created', broadcastDays.length === 12);

    // ── 3. Insert 3 sample channels ──────────────────────────────────────
    section('3. Inserting sample channels');

    const channelData = [
      { platform: 'twitch', channel_identifier: 'pubg_emea', display_name: 'PUBG EMEA', language: 'en', region: 'EU', tier: 'primary' },
      { platform: 'youtube', channel_identifier: 'UCxyz123', display_name: 'PUBG Esports YouTube', language: 'en', region: 'EU', tier: 'primary' },
      { platform: 'kick', channel_identifier: 'pubg_emea_kick', display_name: 'PUBG EMEA Kick', language: 'de', region: 'EU', tier: 'secondary' },
    ];

    const channels = [];
    for (const ch of channelData) {
      const [channel] = await db('channels').insert({
        ...ch,
        series_id: series.id,
        is_active: true,
      }).returning('*');
      channels.push(channel);
    }
    assert('3 channels created (Twitch, YouTube, Kick)', channels.length === 3);
    console.log(`  Channels: ${channels.map(c => `${c.display_name} [${c.platform}]`).join(', ')}`);

    // ── 4. Insert 10 viewership snapshots across 2 broadcast days ────────
    section('4. Inserting viewership snapshots');

    const day1 = broadcastDays[0]; // Group Stage Day 1
    const day2 = broadcastDays[1]; // Group Stage Day 2
    const stage1 = stages[0];

    // Day 1: 6 snapshots (2 per channel at different times)
    const day1Snapshots = [
      { channel: channels[0], viewers: 15000, minuteOffset: 0 },
      { channel: channels[1], viewers: 8000, minuteOffset: 0 },
      { channel: channels[2], viewers: 3000, minuteOffset: 0 },
      { channel: channels[0], viewers: 22000, minuteOffset: 1 },
      { channel: channels[1], viewers: 12000, minuteOffset: 1 },
      { channel: channels[2], viewers: 5000, minuteOffset: 1 },
    ];

    // Day 2: 4 snapshots (varied)
    const day2Snapshots = [
      { channel: channels[0], viewers: 18000, minuteOffset: 0 },
      { channel: channels[1], viewers: 9500, minuteOffset: 0 },
      { channel: channels[0], viewers: 25000, minuteOffset: 1 },
      { channel: channels[1], viewers: 14000, minuteOffset: 1 },
    ];

    const allSnapshotData = [
      ...day1Snapshots.map(s => ({
        channel_id: s.channel.id,
        broadcast_day_id: day1.id,
        stage_id: stage1.id,
        series_id: series.id,
        timestamp: new Date(`2026-03-01T${14 + s.minuteOffset}:00:00Z`),
        concurrent_viewers: s.viewers,
        platform: s.channel.platform,
        language: s.channel.language,
        region: s.channel.region,
      })),
      ...day2Snapshots.map(s => ({
        channel_id: s.channel.id,
        broadcast_day_id: day2.id,
        stage_id: stage1.id,
        series_id: series.id,
        timestamp: new Date(`2026-03-02T${14 + s.minuteOffset}:00:00Z`),
        concurrent_viewers: s.viewers,
        platform: s.channel.platform,
        language: s.channel.language,
        region: s.channel.region,
      })),
    ];

    await db('viewership_snapshots').insert(allSnapshotData);
    const snapshotCount = await db('viewership_snapshots').count('* as count').first();
    assert('10 snapshots inserted', Number(snapshotCount?.count) === 10);

    // ── 5. Run aggregation queries ───────────────────────────────────────
    section('5. Aggregation queries');

    // getPeakCCV at series scope
    const peakSeries = await db('viewership_snapshots')
      .where('series_id', series.id)
      .select('timestamp')
      .sum('concurrent_viewers as total_ccv')
      .groupBy('timestamp')
      .orderBy('total_ccv', 'desc')
      .first();
    console.log(`  Peak CCV (series): ${peakSeries?.total_ccv} at ${peakSeries?.timestamp}`);
    assert('getPeakCCV returns result', !!peakSeries);
    // Day 1 minute 1: 22000+12000+5000=39000. Day 2 minute 1: 25000+14000=39000. Both are 39000.
    assert('Peak CCV is 39000', Number(peakSeries?.total_ccv) === 39000);

    // getAverageCCV at series scope
    const avgSub = db('viewership_snapshots')
      .where('series_id', series.id)
      .select('timestamp')
      .sum('concurrent_viewers as ts_total')
      .groupBy('timestamp')
      .as('per_ts');
    const avgResult = await db.from(avgSub).avg('ts_total as avg_ccv').first<{ avg_ccv: string | null }>();
    const avgCCV = parseFloat(avgResult?.avg_ccv ?? '0');
    console.log(`  Average CCV (series): ${avgCCV.toFixed(2)}`);
    // 4 timestamps: 26000, 39000, 27500, 39000 → avg = 32875
    assert('getAverageCCV returns reasonable value', avgCCV > 0 && avgCCV === 32875);

    // getTotalViewedHours at series scope
    const totalResult = await db('viewership_snapshots')
      .where('series_id', series.id)
      .sum('concurrent_viewers as total_viewer_minutes')
      .first();
    const totalHours = (parseFloat(totalResult?.total_viewer_minutes as string) / 60).toFixed(2);
    console.log(`  Total Viewed Hours (series): ${totalHours}`);
    // Sum of all viewers: 15000+8000+3000+22000+12000+5000+18000+9500+25000+14000 = 131500
    // 131500 / 60 = 2191.67
    assert('getTotalViewedHours returns correct value', totalHours === '2191.67');

    // getPlatformBreakdown at series scope
    const platformBreakdown = await db('viewership_snapshots')
      .where('series_id', series.id)
      .select('platform as key')
      .sum('concurrent_viewers as total_ccv')
      .avg('concurrent_viewers as avg_ccv')
      .max('concurrent_viewers as peak_ccv')
      .groupBy('platform')
      .orderBy('total_ccv', 'desc');
    console.log('  Platform breakdown:');
    for (const row of platformBreakdown) {
      console.log(`    ${row.key}: total=${row.total_ccv}, avg=${parseFloat(row.avg_ccv as string).toFixed(0)}, peak=${row.peak_ccv}`);
    }
    assert('Platform breakdown has 3 platforms', platformBreakdown.length === 3);
    // Twitch: 15000+22000+18000+25000=80000
    const twitchRow = platformBreakdown.find(r => r.key === 'twitch');
    assert('Twitch total CCV is 80000', Number(twitchRow?.total_ccv) === 80000);

    // getLanguageBreakdown at series scope
    const langBreakdown = await db('viewership_snapshots')
      .where('series_id', series.id)
      .select('language as key')
      .sum('concurrent_viewers as total_ccv')
      .groupBy('language')
      .orderBy('total_ccv', 'desc');
    console.log('  Language breakdown:');
    for (const row of langBreakdown) {
      console.log(`    ${row.key}: total=${row.total_ccv}`);
    }
    assert('Language breakdown has 2 languages (en, de)', langBreakdown.length === 2);

    // getTimeSeriesData at series scope
    const timeSeries = await db.raw(`
      SELECT
        date_trunc('minute', "timestamp")
          + (EXTRACT(epoch FROM "timestamp" - date_trunc('minute', "timestamp"))::int / 60 * 60)
          * interval '1 second' AS bucket,
        SUM(concurrent_viewers)::text AS total_ccv,
        COUNT(DISTINCT channel_id)::text AS channel_count
      FROM viewership_snapshots
      WHERE "series_id" = ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [series.id]);
    console.log('  Time series data:');
    for (const row of timeSeries.rows) {
      console.log(`    ${row.bucket}: ccv=${row.total_ccv}, channels=${row.channel_count}`);
    }
    assert('Time series has 4 buckets', timeSeries.rows.length === 4);

    // ── 6. Scope filtering test ──────────────────────────────────────────
    section('6. Scope filtering');

    // Day scope — day1 only
    const day1Snaps = await db('viewership_snapshots')
      .where('broadcast_day_id', day1.id)
      .count('* as count')
      .first();
    const day2Snaps = await db('viewership_snapshots')
      .where('broadcast_day_id', day2.id)
      .count('* as count')
      .first();
    const stageSnaps = await db('viewership_snapshots')
      .where('stage_id', stage1.id)
      .count('* as count')
      .first();
    const seriesSnaps = await db('viewership_snapshots')
      .where('series_id', series.id)
      .count('* as count')
      .first();

    console.log(`  Day 1 scope: ${day1Snaps?.count} snapshots`);
    console.log(`  Day 2 scope: ${day2Snaps?.count} snapshots`);
    console.log(`  Stage scope: ${stageSnaps?.count} snapshots`);
    console.log(`  Series scope: ${seriesSnaps?.count} snapshots`);

    assert('Day 1 has 6 snapshots', Number(day1Snaps?.count) === 6);
    assert('Day 2 has 4 snapshots', Number(day2Snaps?.count) === 4);
    assert('Stage scope has 10 (all in stage 1)', Number(stageSnaps?.count) === 10);
    assert('Series scope has 10 (all data)', Number(seriesSnaps?.count) === 10);

    // Day scope peak CCV differs from series scope
    const peakDay1 = await db('viewership_snapshots')
      .where('broadcast_day_id', day1.id)
      .select('timestamp')
      .sum('concurrent_viewers as total_ccv')
      .groupBy('timestamp')
      .orderBy('total_ccv', 'desc')
      .first();
    const peakDay2 = await db('viewership_snapshots')
      .where('broadcast_day_id', day2.id)
      .select('timestamp')
      .sum('concurrent_viewers as total_ccv')
      .groupBy('timestamp')
      .orderBy('total_ccv', 'desc')
      .first();
    console.log(`  Peak CCV day 1: ${peakDay1?.total_ccv}`);
    console.log(`  Peak CCV day 2: ${peakDay2?.total_ccv}`);
    // Day 1 peak: 39000. Day 2 peak: 39000. Both same here but count differs.
    assert('Day 1 peak CCV is 39000', Number(peakDay1?.total_ccv) === 39000);
    assert('Day 2 peak CCV is 39000', Number(peakDay2?.total_ccv) === 39000);

    const avgDay1Sub = db('viewership_snapshots')
      .where('broadcast_day_id', day1.id)
      .select('timestamp')
      .sum('concurrent_viewers as ts_total')
      .groupBy('timestamp')
      .as('d1');
    const avgDay1 = await db.from(avgDay1Sub).avg('ts_total as avg_ccv').first<{ avg_ccv: string | null }>();
    const avgDay2Sub = db('viewership_snapshots')
      .where('broadcast_day_id', day2.id)
      .select('timestamp')
      .sum('concurrent_viewers as ts_total')
      .groupBy('timestamp')
      .as('d2');
    const avgDay2 = await db.from(avgDay2Sub).avg('ts_total as avg_ccv').first<{ avg_ccv: string | null }>();
    console.log(`  Average CCV day 1: ${parseFloat(avgDay1?.avg_ccv ?? '0').toFixed(2)}`);
    console.log(`  Average CCV day 2: ${parseFloat(avgDay2?.avg_ccv ?? '0').toFixed(2)}`);
    // Day 1: (26000+39000)/2 = 32500. Day 2: (27500+39000)/2 = 33250
    assert('Day 1 avg differs from Day 2 avg', avgDay1?.avg_ccv !== avgDay2?.avg_ccv);

    // ── 7. Verify indexes ────────────────────────────────────────────────
    section('7. Checking indexes');

    const indexes = await db.raw(`
      SELECT
        t.relname AS table_name,
        i.relname AS index_name,
        array_to_string(array_agg(a.attname ORDER BY x.ordinality), ', ') AS columns
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
      WHERE n.nspname = 'public'
        AND t.relname NOT LIKE 'knex_%'
      GROUP BY t.relname, i.relname
      ORDER BY t.relname, i.relname
    `);
    console.log('  Indexes found:');
    for (const idx of indexes.rows) {
      console.log(`    ${idx.table_name}: ${idx.index_name} (${idx.columns})`);
    }

    // Check critical composite indexes on viewership_snapshots
    const vsIndexes = indexes.rows.filter((r: { table_name: string }) => r.table_name === 'viewership_snapshots');
    const hasSeriesTs = vsIndexes.some((r: { columns: string }) => r.columns === 'series_id, timestamp');
    const hasDayTs = vsIndexes.some((r: { columns: string }) => r.columns === 'broadcast_day_id, timestamp');
    const hasChTs = vsIndexes.some((r: { columns: string }) => r.columns === 'channel_id, timestamp');
    assert('Index on viewership_snapshots(series_id, timestamp)', hasSeriesTs);
    assert('Index on viewership_snapshots(broadcast_day_id, timestamp)', hasDayTs);
    assert('Index on viewership_snapshots(channel_id, timestamp)', hasChTs);

    // Check unique constraint on channels
    const chIndexes = indexes.rows.filter((r: { table_name: string }) => r.table_name === 'channels');
    const hasUniqueConstraint = chIndexes.some((r: { columns: string }) =>
      r.columns === 'series_id, platform, channel_identifier'
    );
    assert('Unique index on channels(series_id, platform, channel_identifier)', hasUniqueConstraint);

    // ── 8. Test cascade deletes ──────────────────────────────────────────
    section('8. Testing cascade deletes');

    // --- 8a. Stage → broadcast_days CASCADE ---
    const daysBeforeDelete = await db('broadcast_days')
      .where('stage_id', stage1.id)
      .count('* as count')
      .first();
    console.log(`  Broadcast days in Stage 1 before delete: ${daysBeforeDelete?.count}`);
    assert('Stage 1 has 3 broadcast days before delete', Number(daysBeforeDelete?.count) === 3);

    const snapsBeforeStageDelete = await db('viewership_snapshots')
      .where('stage_id', stage1.id)
      .count('* as count')
      .first();
    console.log(`  Snapshots with stage_id = Stage 1 before delete: ${snapsBeforeStageDelete?.count}`);

    // Delete stage 1 → should cascade broadcast_days, SET NULL on snapshots.stage_id
    await db('stages').where('id', stage1.id).delete();

    const daysAfterDelete = await db('broadcast_days')
      .where('stage_id', stage1.id)
      .count('* as count')
      .first();
    console.log(`  Broadcast days after stage delete: ${daysAfterDelete?.count}`);
    assert('CASCADE: Deleting stage removed its broadcast days', Number(daysAfterDelete?.count) === 0);

    // Snapshots should still exist but stage_id is now NULL
    const snapsAfterStageDelete = await db('viewership_snapshots')
      .whereNull('stage_id')
      .count('* as count')
      .first();
    const totalSnapsAfterStageDelete = await db('viewership_snapshots')
      .count('* as count')
      .first();
    console.log(`  Snapshots total after stage delete: ${totalSnapsAfterStageDelete?.count}`);
    console.log(`  Snapshots with stage_id=NULL after stage delete: ${snapsAfterStageDelete?.count}`);
    assert('SET NULL: Snapshots preserved after stage delete', Number(totalSnapsAfterStageDelete?.count) === 10);
    assert('SET NULL: Snapshots stage_id set to NULL', Number(snapsAfterStageDelete?.count) === 10);

    // --- 8b. Series → channels CASCADE → snapshots CASCADE (via channel_id) ---
    const channelsBeforeSeriesDelete = await db('channels')
      .where('series_id', series.id)
      .count('* as count')
      .first();
    console.log(`  Channels before series delete: ${channelsBeforeSeriesDelete?.count}`);

    await db('tournament_series').where('id', series.id).delete();

    const channelsAfterSeriesDelete = await db('channels')
      .where('series_id', series.id)
      .count('* as count')
      .first();
    const snapshotsAfterSeriesDelete = await db('viewership_snapshots')
      .count('* as count')
      .first();
    const stagesAfterSeriesDelete = await db('stages')
      .where('series_id', series.id)
      .count('* as count')
      .first();

    console.log(`  Channels after series delete: ${channelsAfterSeriesDelete?.count}`);
    console.log(`  Snapshots after series delete: ${snapshotsAfterSeriesDelete?.count}`);
    console.log(`  Stages after series delete: ${stagesAfterSeriesDelete?.count}`);

    assert('CASCADE: Deleting series removed all channels', Number(channelsAfterSeriesDelete?.count) === 0);
    assert('CASCADE: Deleting series removed all snapshots (via channels)', Number(snapshotsAfterSeriesDelete?.count) === 0);
    assert('CASCADE: Deleting series removed remaining stages', Number(stagesAfterSeriesDelete?.count) === 0);

    // ── 9. Cleanup ───────────────────────────────────────────────────────
    section('9. Cleanup');
    await db.migrate.rollback({
      directory: './migrations',
      extension: 'ts',
    }, true);
    console.log('  All migrations rolled back.');

    // ── Summary ──────────────────────────────────────────────────────────
    section('SUMMARY');
    console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

run();
