import type { Knex } from 'knex';

/**
 * Add stream-level tracking columns to viewership_snapshots.
 *
 * YouTube channels can run multiple simultaneous live streams (e.g. multi-language
 * feeds, main + companion). These nullable columns allow storing per-stream data
 * while leaving all other platforms (and single-stream YT channels) unaffected.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('viewership_snapshots', (table) => {
    table.string('stream_id').nullable().comment('YouTube video ID when multi-streaming');
    table.string('stream_title').nullable().comment('Stream title at time of snapshot');
    table.index(['channel_id', 'stream_id', 'timestamp'], 'idx_snapshots_channel_stream_ts');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('viewership_snapshots', (table) => {
    table.dropIndex([], 'idx_snapshots_channel_stream_ts');
    table.dropColumn('stream_title');
    table.dropColumn('stream_id');
  });
}
