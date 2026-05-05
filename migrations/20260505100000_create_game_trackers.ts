import type { Knex } from 'knex';

/**
 * Live Game Tracker — three new tables for continuous platform-wide
 * game tracking, separate from tournament_series.
 *
 * Plan: docs/plans/2026-05-05-live-game-tracker.md (Phase 1 schema).
 *
 * - game_trackers: one row per tracked game (e.g. "PUBG: Battlegrounds").
 * - game_tracker_channels: channels currently in a tracker's polled set,
 *   with drop-on-mismatch counter.
 * - game_tracker_snapshots: per-poll viewer count. Mirrors
 *   viewership_snapshots shape but in its own table so tournament
 *   queries are physically isolated from game-tracker volume.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('game_trackers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('slug').notNullable().unique();
    table.string('status').notNullable().defaultTo('active'); // 'active' | 'paused'

    // Platform-specific category identifiers — at least one required.
    table.string('twitch_game_id').nullable();
    table.string('twitch_game_name').nullable();
    table.integer('kick_category_id').nullable();
    table.string('kick_category_slug').nullable();

    table.integer('min_ccv_threshold').notNullable().defaultTo(10);
    table.integer('mismatch_threshold_cycles').notNullable().defaultTo(3);
    table.integer('discovery_interval_seconds').notNullable().defaultTo(60);
    table.integer('polling_interval_seconds').notNullable().defaultTo(60);
    table.integer('max_active_channels').notNullable().defaultTo(500);

    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('status', 'game_trackers_status_idx');
    table.index('slug', 'game_trackers_slug_idx');
  });

  await knex.schema.createTable('game_tracker_channels', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.uuid('channel_id').notNullable()
      .references('id').inTable('channels').onDelete('CASCADE');
    table.string('source').notNullable(); // 'auto_discovered' | 'manual'
    table.timestamp('joined_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_match_at', { useTz: true }).nullable();
    table.integer('consecutive_mismatch_cycles').notNullable().defaultTo(0);
    table.timestamp('dropped_at', { useTz: true }).nullable();
    table.string('dropped_reason').nullable();
    table.jsonb('metadata').notNullable().defaultTo('{}');

    table.unique(['game_tracker_id', 'channel_id'], { indexName: 'game_tracker_channels_unique' });
    table.index(['game_tracker_id', 'dropped_at'], 'game_tracker_channels_active_idx');
    table.index('channel_id', 'game_tracker_channels_channel_idx');
  });

  await knex.schema.createTable('game_tracker_snapshots', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.uuid('channel_id').notNullable()
      .references('id').inTable('channels').onDelete('CASCADE');
    table.timestamp('timestamp', { useTz: true }).notNullable();
    table.integer('concurrent_viewers').notNullable().defaultTo(0);
    table.string('platform').notNullable();
    table.string('language').nullable();
    table.string('region').nullable();
    table.string('stream_id').nullable();
    table.string('stream_title').nullable();
    table.string('game_name').nullable();
    // started_at = when the broadcast session began on the platform —
    // enables ramp-time and stream-duration analytics.
    table.timestamp('started_at', { useTz: true }).nullable();

    // Trends range queries: most "what was happening over [from, to)?" hits this.
    table.index(['game_tracker_id', 'timestamp'], 'game_tracker_snapshots_tracker_ts_idx');
    // Per-channel session timeline (e.g. "show me streamer X's PUBG session").
    table.index(['channel_id', 'stream_id', 'timestamp'], 'game_tracker_snapshots_channel_stream_ts_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_snapshots');
  await knex.schema.dropTableIfExists('game_tracker_channels');
  await knex.schema.dropTableIfExists('game_trackers');
}
