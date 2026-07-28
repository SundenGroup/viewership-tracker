import type { Knex } from 'knex';

/**
 * YouTube support for the live game tracker (Discover).
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * Unlike Twitch/Kick, YouTube exposes no reliable machine-readable game
 * association (topicDetails returns generic "Action_game" for both PUBG PC
 * and BGMI). Gating is therefore OUR judgment, made explicit and persistent:
 *   - youtube_config holds per-tracker search aliases + title keyword rules
 *   - game_tracker_youtube_channels records one durable decision per channel
 *     (allow / deny), with everything unmatched parked as 'pending' for
 *     review rather than silently included or dropped.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_trackers', (t) => {
    t.boolean('youtube_enabled').notNullable().defaultTo(false);
    // { queries: string[], include: string[], exclude: string[],
    //   autoAllowMinCcv?: number, maxRoster?: number }
    t.jsonb('youtube_config').notNullable().defaultTo('{}');
  });

  await knex.schema.createTable('game_tracker_youtube_channels', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('game_tracker_id')
      .notNullable()
      .references('id')
      .inTable('game_trackers')
      .onDelete('CASCADE');
    /** YouTube channel id (UC…). */
    t.text('channel_identifier').notNullable();
    t.text('display_name');
    /** allow | deny | pending — 'pending' is the review queue. */
    t.text('decision').notNullable().defaultTo('pending');
    /** Why the gate landed here (rule that matched, or admin note). */
    t.text('reason');
    /** Evidence for the reviewer: what they were streaming when caught. */
    t.text('sample_title');
    t.text('sample_video_id');
    t.integer('sample_ccv');
    t.timestamp('last_seen_at', { useTz: true });
    t.text('decided_by');
    t.timestamp('decided_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['game_tracker_id', 'channel_identifier']);
    t.index(['game_tracker_id', 'decision']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('game_tracker_youtube_channels');
  await knex.schema.alterTable('game_trackers', (t) => {
    t.dropColumn('youtube_enabled');
    t.dropColumn('youtube_config');
  });
}
