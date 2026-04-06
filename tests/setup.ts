/**
 * Test setup — connects to the test database and provides helpers.
 *
 * Uses DATABASE_URL from .env (should point to clutch_viewership_test).
 * Each test file should call setupTestDb() in beforeAll and cleanupTestDb() in afterAll.
 */
import knex, { Knex } from 'knex';
import dotenv from 'dotenv';

dotenv.config();

let testDb: Knex;

export function getTestDb(): Knex {
  if (!testDb) {
    const url = process.env.DATABASE_URL;
    if (!url || !url.includes('test')) {
      throw new Error(
        'DATABASE_URL must point to a test database (name should contain "test"). ' +
        `Current: ${url}`,
      );
    }
    testDb = knex({ client: 'pg', connection: url, pool: { min: 1, max: 5 } });
  }
  return testDb;
}

export async function setupTestDb(): Promise<Knex> {
  const db = getTestDb();
  await db.migrate.latest();
  return db;
}

export async function cleanupTestDb(): Promise<void> {
  if (testDb) {
    await testDb.destroy();
  }
}

/**
 * Clear all data from tables (in correct order for FK constraints).
 */
export async function truncateAll(db: Knex): Promise<void> {
  await db.raw('TRUNCATE viewership_snapshots, channel_broadcast_days, post_event_metrics, channels, broadcast_days, stages, tournament_series, users CASCADE');
}

/**
 * Insert a minimal series → stage → broadcast_day → channel setup for testing.
 */
export async function seedTestData(db: Knex) {
  const [series] = await db('tournament_series').insert({
    name: 'Test Series',
    short_name: 'test-series',
    status: 'active',
    timezone: 'UTC',
  }).returning('*');

  const [stage] = await db('stages').insert({
    series_id: series.id,
    name: 'Test Stage',
    order: 1,
  }).returning('*');

  const [broadcastDay] = await db('broadcast_days').insert({
    stage_id: stage.id,
    series_id: series.id,
    label: 'Day 1',
    date: '2026-04-01',
    broadcast_start: '2026-04-01T09:00:00Z',
    broadcast_end: '2026-04-01T15:00:00Z',
    status: 'live',
  }).returning('*');

  const [twitchChannel] = await db('channels').insert({
    series_id: series.id,
    platform: 'twitch',
    channel_identifier: 'test_channel',
    display_name: 'Test Channel',
    language: 'en',
    region: 'West',
    tier: 'official',
    source: 'manual',
    is_active: true,
  }).returning('*');

  const [youtubeChannel] = await db('channels').insert({
    series_id: series.id,
    platform: 'youtube',
    channel_identifier: 'UC_test_channel',
    display_name: 'Test YouTube',
    language: 'en',
    region: 'West',
    tier: 'official',
    source: 'manual',
    is_active: true,
    metadata: JSON.stringify({ multi_stream: true }),
  }).returning('*');

  const [tiktokChannel] = await db('channels').insert({
    series_id: series.id,
    platform: 'tiktok',
    channel_identifier: '@test_tiktok',
    display_name: 'Test TikTok',
    language: 'en',
    region: 'West',
    tier: 'official',
    source: 'manual',
    is_active: true,
  }).returning('*');

  return { series, stage, broadcastDay, twitchChannel, youtubeChannel, tiktokChannel };
}
