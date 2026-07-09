import type { Knex } from 'knex';

/**
 * Discover "streamer depth" — promote derived stream sessions to stored
 * rows, plus chat + follower engagement tables.
 *
 * - stream_sessions: one row per (tracker, channel, stream_id) broadcast.
 *   Maintained live by GameTrackerService (upsert per poll cycle, close
 *   pass after 10 min of silence, finals computed at close). Historical
 *   rows come from scripts/backfill-stream-sessions.ts.
 * - chat_minute_rollup: per-channel per-minute chat volume, written by
 *   the chat collector (scripts/chat-collector.ts). unique_chatters on
 *   sessions is the SUM of per-minute chatters — an approximation.
 * - channel_follower_snapshots: point-in-time follower counts polled by
 *   GameTrackerService for the top live channels of each tracker.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('stream_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('game_tracker_id').notNullable()
      .references('id').inTable('game_trackers').onDelete('CASCADE');
    table.uuid('channel_id').notNullable()
      .references('id').inTable('channels').onDelete('CASCADE');
    table.text('stream_id').notNullable();
    table.timestamp('started_at', { useTz: true }).notNullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable();
    table.timestamp('ended_at', { useTz: true }).nullable();
    table.text('status').notNullable().defaultTo('live'); // 'live' | 'ended'
    table.integer('peak_ccv').notNullable().defaultTo(0);
    table.integer('avg_ccv').notNullable().defaultTo(0);
    // Viewer-minutes (SUM of per-minute MAX ccv) — filled on close.
    table.bigInteger('ccv_minutes').notNullable().defaultTo(0);
    table.integer('minutes_live').notNullable().defaultTo(0);
    table.jsonb('titles').notNullable().defaultTo('[]'); // [{ title, at }]
    table.text('category').nullable();
    table.integer('followers_start').nullable();
    table.integer('followers_end').nullable();
    table.integer('messages').notNullable().defaultTo(0);
    table.integer('unique_chatters').notNullable().defaultTo(0);

    table.unique(['game_tracker_id', 'channel_id', 'stream_id'], {
      indexName: 'stream_sessions_tracker_channel_stream_unique',
    });
  });
  await knex.raw(
    'CREATE INDEX stream_sessions_channel_started_idx ON stream_sessions (channel_id, started_at DESC)',
  );
  await knex.raw(
    'CREATE INDEX stream_sessions_tracker_started_idx ON stream_sessions (game_tracker_id, started_at DESC)',
  );
  // Close pass scans exactly this: live rows of a tracker by last_seen_at.
  await knex.raw(
    `CREATE INDEX stream_sessions_live_idx ON stream_sessions (game_tracker_id, last_seen_at) WHERE status = 'live'`,
  );

  await knex.schema.createTable('chat_minute_rollup', (table) => {
    table.uuid('channel_id').notNullable()
      .references('id').inTable('channels').onDelete('CASCADE');
    table.timestamp('minute', { useTz: true }).notNullable();
    table.integer('messages').notNullable().defaultTo(0);
    table.integer('chatters').notNullable().defaultTo(0);
    table.primary(['channel_id', 'minute']);
  });

  await knex.schema.createTable('channel_follower_snapshots', (table) => {
    table.uuid('channel_id').notNullable()
      .references('id').inTable('channels').onDelete('CASCADE');
    table.timestamp('ts', { useTz: true }).notNullable();
    table.integer('followers').notNullable();
    table.primary(['channel_id', 'ts']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('channel_follower_snapshots');
  await knex.schema.dropTableIfExists('chat_minute_rollup');
  await knex.schema.dropTableIfExists('stream_sessions');
}
