import type { Knex } from 'knex';

/**
 * Holding pen for YouTube streams awaiting gating review.
 *
 * While a channel sits in the review queue its viewership used to be
 * simply dropped — so review latency permanently cost data, and the
 * channels forced into review (everything above alwaysReviewAboveCcv)
 * were exactly the biggest ones. This table stores those would-be
 * snapshots OUT OF BAND: it is keyed by the YouTube channel identifier,
 * not by a channels-table row, and no read path (leaderboards, trends,
 * reports, rollups) ever touches it. Approving a channel promotes its
 * held rows into game_tracker_snapshots retroactively; denying — or a
 * TTL for channels nobody rules on — deletes them.
 */
export async function up(knex: Knex): Promise<void> {
  // pg_dump (deploy pre-backup) holds AccessShare on everything; fail
  // fast instead of queueing behind it and blocking writers.
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL lock_timeout = '5s'`);
    await trx.schema.createTable('game_tracker_youtube_quarantine', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('game_tracker_id').notNullable()
        .references('id').inTable('game_trackers').onDelete('CASCADE');
      // The UC… id as YouTube reports it — deliberately NOT a channels FK,
      // so unreviewed channels never create rows in the real tables.
      table.string('channel_identifier').notNullable();
      table.string('display_name').nullable();
      table.string('video_id').nullable();
      table.string('stream_title').nullable();
      table.integer('concurrent_viewers').notNullable().defaultTo(0);
      table.string('language').nullable();
      table.timestamp('started_at', { useTz: true }).nullable();
      table.timestamp('timestamp', { useTz: true }).notNullable();

      // Promotion/discard work per (tracker, channel); the sweep works by age.
      table.index(['game_tracker_id', 'channel_identifier'], 'gt_yt_quarantine_tracker_channel_idx');
      table.index('timestamp', 'gt_yt_quarantine_ts_idx');
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_youtube_quarantine');
}
