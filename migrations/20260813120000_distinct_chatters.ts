import type { Knex } from 'knex';

/**
 * True distinct chatters per session.
 *
 * chat_minute_rollup.chatters counts each MINUTE's uniques, so summing it
 * gives chatter-minutes (one person across N minutes counts N times) —
 * ~8× inflated vs real people. The collector now also records, per
 * minute, how many senders were seen for the FIRST time in the channel's
 * current stream (new_chatters); summing those over a session yields the
 * distinct-people count, stored on the session at finalize.
 */
export async function up(knex: Knex): Promise<void> {
  // The collector and scorer hold long statements on these tables — queue
  // for the lock instead of dying on the server's statement timeout.
  await knex.raw('SET LOCAL statement_timeout = 0');
  await knex.schema.alterTable('chat_minute_rollup', (t) => {
    t.integer('new_chatters').notNullable().defaultTo(0);
  });
  await knex.schema.alterTable('stream_sessions', (t) => {
    /** NULL = session predates first-seen tracking (or had no chat data). */
    t.integer('distinct_chatters').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('SET LOCAL statement_timeout = 0');
  await knex.schema.alterTable('stream_sessions', (t) => {
    t.dropColumn('distinct_chatters');
  });
  await knex.schema.alterTable('chat_minute_rollup', (t) => {
    t.dropColumn('new_chatters');
  });
}
