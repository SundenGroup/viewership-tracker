/**
 * Tests for viewership snapshot aggregation queries.
 *
 * Validates the three-level dedup strategy:
 *   1. SUM multi-stream rows per poll cycle per channel
 *   2. MAX across poll cycles per minute per channel
 *   3. SUM across channels for totals
 */
import { Knex } from 'knex';
import { setupTestDb, cleanupTestDb, truncateAll, seedTestData } from '../setup';

let db: Knex;
let testData: Awaited<ReturnType<typeof seedTestData>>;

beforeAll(async () => {
  db = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb();
});

beforeEach(async () => {
  await truncateAll(db);
  testData = await seedTestData(db);
});

function insertSnapshot(overrides: Record<string, unknown> = {}) {
  return db('viewership_snapshots').insert({
    channel_id: testData.twitchChannel.id,
    broadcast_day_id: testData.broadcastDay.id,
    stage_id: testData.stage.id,
    series_id: testData.series.id,
    timestamp: '2026-04-01T10:00:00Z',
    concurrent_viewers: 100,
    platform: 'twitch',
    language: 'en',
    region: 'West',
    ...overrides,
  });
}

describe('Snapshot deduplication', () => {
  test('single snapshot per minute returns correct value', async () => {
    await insertSnapshot({ concurrent_viewers: 500 });

    const result = await db.raw(`
      SELECT SUM(channel_ccv)::int AS total FROM (
        SELECT channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS mb, "timestamp" AS poll_ts,
            channel_id, SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY mb, poll_ts, channel_id
        ) per_cycle GROUP BY mb, channel_id
      ) per_channel
    `, [testData.broadcastDay.id]);

    expect(result.rows[0].total).toBe(500);
  });

  test('two polls per minute takes MAX (not SUM)', async () => {
    // Poll 1: 400 viewers
    await insertSnapshot({ timestamp: '2026-04-01T10:00:10Z', concurrent_viewers: 400 });
    // Poll 2: 500 viewers (API stepped up)
    await insertSnapshot({ timestamp: '2026-04-01T10:00:40Z', concurrent_viewers: 500 });

    const result = await db.raw(`
      SELECT SUM(channel_ccv)::int AS total FROM (
        SELECT channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS mb, "timestamp" AS poll_ts,
            channel_id, SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY mb, poll_ts, channel_id
        ) per_cycle GROUP BY mb, channel_id
      ) per_channel
    `, [testData.broadcastDay.id]);

    // Should be 500 (MAX), not 900 (SUM)
    expect(result.rows[0].total).toBe(500);
  });

  test('multi-stream YouTube rows are summed per poll cycle', async () => {
    const ts = '2026-04-01T10:00:10Z';
    // Same channel, same timestamp, two streams (multi-stream)
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id,
      platform: 'youtube',
      timestamp: ts,
      concurrent_viewers: 300,
      stream_id: 'stream_a',
    });
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id,
      platform: 'youtube',
      timestamp: ts,
      concurrent_viewers: 200,
      stream_id: 'stream_b',
    });

    const result = await db.raw(`
      SELECT SUM(channel_ccv)::int AS total FROM (
        SELECT channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS mb, "timestamp" AS poll_ts,
            channel_id, SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY mb, poll_ts, channel_id
        ) per_cycle GROUP BY mb, channel_id
      ) per_channel
    `, [testData.broadcastDay.id]);

    // Should be 500 (300 + 200 summed per cycle)
    expect(result.rows[0].total).toBe(500);
  });

  test('multi-stream + two polls takes MAX of summed cycles', async () => {
    // Poll 1: two streams = 300 + 200 = 500 total
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id, platform: 'youtube',
      timestamp: '2026-04-01T10:00:10Z', concurrent_viewers: 300, stream_id: 'a',
    });
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id, platform: 'youtube',
      timestamp: '2026-04-01T10:00:10Z', concurrent_viewers: 200, stream_id: 'b',
    });
    // Poll 2: two streams = 350 + 250 = 600 total
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id, platform: 'youtube',
      timestamp: '2026-04-01T10:00:40Z', concurrent_viewers: 350, stream_id: 'a',
    });
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id, platform: 'youtube',
      timestamp: '2026-04-01T10:00:40Z', concurrent_viewers: 250, stream_id: 'b',
    });

    const result = await db.raw(`
      SELECT SUM(channel_ccv)::int AS total FROM (
        SELECT channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS mb, "timestamp" AS poll_ts,
            channel_id, SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY mb, poll_ts, channel_id
        ) per_cycle GROUP BY mb, channel_id
      ) per_channel
    `, [testData.broadcastDay.id]);

    // Should be 600 (MAX of 500, 600)
    expect(result.rows[0].total).toBe(600);
  });

  test('multiple channels sum correctly across minute', async () => {
    // Twitch channel: 1000
    await insertSnapshot({ concurrent_viewers: 1000 });
    // YouTube channel: 500
    await insertSnapshot({
      channel_id: testData.youtubeChannel.id, platform: 'youtube',
      concurrent_viewers: 500,
    });
    // TikTok channel: 200
    await insertSnapshot({
      channel_id: testData.tiktokChannel.id, platform: 'tiktok',
      concurrent_viewers: 200,
    });

    const result = await db.raw(`
      SELECT SUM(channel_ccv)::int AS total FROM (
        SELECT channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS mb, "timestamp" AS poll_ts,
            channel_id, SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY mb, poll_ts, channel_id
        ) per_cycle GROUP BY mb, channel_id
      ) per_channel
    `, [testData.broadcastDay.id]);

    expect(result.rows[0].total).toBe(1700);
  });
});

describe('Peak CCV calculation', () => {
  test('finds the correct peak minute', async () => {
    // Minute 1: 500
    await insertSnapshot({ timestamp: '2026-04-01T10:00:00Z', concurrent_viewers: 500 });
    // Minute 2: 800 (peak)
    await insertSnapshot({ timestamp: '2026-04-01T10:01:00Z', concurrent_viewers: 800 });
    // Minute 3: 600
    await insertSnapshot({ timestamp: '2026-04-01T10:02:00Z', concurrent_viewers: 600 });

    const result = await db.raw(`
      SELECT minute_bucket AS "timestamp", SUM(channel_ccv)::int AS total_ccv FROM (
        SELECT minute_bucket, channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS minute_bucket,
            "timestamp" AS poll_ts, channel_id,
            SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY minute_bucket, poll_ts, channel_id
        ) per_cycle GROUP BY minute_bucket, channel_id
      ) per_channel GROUP BY minute_bucket ORDER BY total_ccv DESC LIMIT 1
    `, [testData.broadcastDay.id]);

    expect(result.rows[0].total_ccv).toBe(800);
  });
});

describe('Duplicate TikTok relay handling', () => {
  test('duplicate rows in same minute inflate SUM but not three-level dedup', async () => {
    const ts1 = '2026-04-01T10:00:10Z';
    const ts2 = '2026-04-01T10:00:40Z';

    // TikTok: two relay pushes, same minute, different timestamps
    await insertSnapshot({
      channel_id: testData.tiktokChannel.id, platform: 'tiktok',
      timestamp: ts1, concurrent_viewers: 300,
    });
    await insertSnapshot({
      channel_id: testData.tiktokChannel.id, platform: 'tiktok',
      timestamp: ts2, concurrent_viewers: 310,
    });

    // Three-level dedup should take MAX (310), not SUM (610)
    const result = await db.raw(`
      SELECT SUM(channel_ccv)::int AS total FROM (
        SELECT channel_id, MAX(cycle_ccv) AS channel_ccv FROM (
          SELECT date_trunc('minute', "timestamp") AS mb, "timestamp" AS poll_ts,
            channel_id, SUM(concurrent_viewers) AS cycle_ccv
          FROM viewership_snapshots WHERE broadcast_day_id = ?
          GROUP BY mb, poll_ts, channel_id
        ) per_cycle GROUP BY mb, channel_id
      ) per_channel
    `, [testData.broadcastDay.id]);

    expect(result.rows[0].total).toBe(310);
  });
});
