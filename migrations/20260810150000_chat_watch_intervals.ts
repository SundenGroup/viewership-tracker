import type { Knex } from 'knex';

/**
 * Watch intervals for the chat collector.
 *
 * The rollup (chat_minute_rollup) only gains a row when a minute had at
 * least one message, so a watched-but-silent channel is indistinguishable
 * from an unwatched one — and the health scorer's chat-coverage gate then
 * refuses to grade exactly the quiet-chat streams it exists to examine.
 * These rows record WHEN the collector was actually subscribed to a
 * channel's chat: one row per continuous watch stretch, heartbeated every
 * flush (60s) so a crash can't leave a lying open interval.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('chat_watch_intervals', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('channel_id').notNullable().references('id').inTable('channels').onDelete('CASCADE');
    t.timestamp('started_at', { useTz: true }).notNullable();
    /** Advanced every collector flush while the watch is live; an open
     *  interval's effective end is last_seen_at, not now(). */
    t.timestamp('last_seen_at', { useTz: true }).notNullable();
    t.timestamp('ended_at', { useTz: true }).nullable();
    t.index(['channel_id', 'started_at'], 'chat_watch_intervals_channel_start_idx');
  });
  // The collector's heartbeat/orphan queries touch only open intervals.
  await knex.raw(
    `CREATE INDEX chat_watch_intervals_open_idx ON chat_watch_intervals (id) WHERE ended_at IS NULL`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('chat_watch_intervals');
}
