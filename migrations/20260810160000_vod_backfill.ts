import type { Knex } from 'knex';

/**
 * VOD chat backfill bookkeeping.
 *
 * - chat_watch_intervals.source: 'live' rows come from the collector's
 *   real-time subscriptions; 'vod' rows are written by the replay
 *   backfill after it has fetched a session's COMPLETE chat from the
 *   recording — the whole span is then verified coverage.
 * - vod_chat_backfills: one row per attempted session so a session with
 *   no VOD (or a failed replay) isn't refetched forever.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chat_watch_intervals', (t) => {
    t.string('source', 16).notNullable().defaultTo('live');
  });
  await knex.schema.createTable('vod_chat_backfills', (t) => {
    t.uuid('session_id')
      .primary()
      .references('id')
      .inTable('stream_sessions')
      .onDelete('CASCADE');
    t.timestamp('attempted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    /** ok | no_vod | replay_unavailable | error */
    t.string('status', 24).notNullable();
    t.text('detail').nullable();
    t.integer('messages').nullable();
    t.integer('minutes').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vod_chat_backfills');
  await knex.schema.alterTable('chat_watch_intervals', (t) => {
    t.dropColumn('source');
  });
}
