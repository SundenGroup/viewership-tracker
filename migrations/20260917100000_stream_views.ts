import type { Knex } from 'knex';

/**
 * Live views per stream (plan: docs/plans/2026-09-16-views-roundup.md).
 *
 *   - stream_view_readings: the platform's public view counter while a
 *     stream runs (YouTube), at most one row per stream per minute. Only
 *     used to work out how many views fell inside a broadcast window when
 *     the stream ran longer than the window.
 *   - stream_views: the per broadcast day result, one row per channel,
 *     source, snapshot and stream. `views` is the platform's number as
 *     read, `event_views` the part that counts for the event.
 *   - stream_views_runs: which collector pass ran for which day, so a pass
 *     that found nothing is not repeated every hour.
 *
 * Additive DDL only: three new tables, nothing touches the hot tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('stream_view_readings'))) {
    await knex.schema.createTable('stream_view_readings', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('channel_id').notNullable().references('id').inTable('channels').onDelete('CASCADE');
      t.uuid('broadcast_day_id').nullable().references('id').inTable('broadcast_days').onDelete('SET NULL');
      t.uuid('series_id').nullable();
      t.string('platform', 32).notNullable();
      t.text('stream_ref').notNullable();
      t.timestamp('read_at', { useTz: true }).notNullable();
      t.bigInteger('views').notNullable();
      t.unique(['channel_id', 'stream_ref', 'read_at']);
      t.index(['broadcast_day_id', 'channel_id']);
    });
  }

  if (!(await knex.schema.hasTable('stream_views'))) {
    await knex.schema.createTable('stream_views', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('channel_id').notNullable().references('id').inTable('channels').onDelete('CASCADE');
      t.uuid('broadcast_day_id').notNullable().references('id').inTable('broadcast_days').onDelete('CASCADE');
      t.uuid('series_id').nullable();
      t.uuid('stage_id').nullable();
      t.string('platform', 32).notNullable();
      // Twitch video id, YouTube video id, SOOP broad_no, Kick video id; '' when the row is not tied to one stream.
      t.text('stream_ref').notNullable().defaultTo('');
      // youtube_public | youtube_live | youtube_analytics | twitch_vod | kick_vod | soop_vod |
      // tiktok_livecenter | twitch_stream_summary | csv_import | estimate
      t.string('source', 32).notNullable();
      // live_end | plus_3h | plus_36h | plus_7d | manual | estimate
      t.string('snapshot', 16).notNullable();
      t.bigInteger('views').nullable();
      // false for numbers that must never enter a total (Kick replay views).
      t.boolean('counted').notNullable().defaultTo(true);
      t.timestamp('broadcast_started_at', { useTz: true }).nullable();
      t.timestamp('broadcast_ended_at', { useTz: true }).nullable();
      t.integer('broadcast_minutes').nullable();
      t.integer('tracked_minutes').nullable();
      t.decimal('event_share', 7, 4).nullable();
      // full | windowed | viewer_minutes | time_share | none
      t.string('event_share_method', 16).nullable();
      t.bigInteger('event_views').nullable();
      // measured | adjusted | estimated | replay
      t.string('confidence', 12).notNullable();
      t.jsonb('extra').notNullable().defaultTo('{}');
      t.text('note').nullable();
      t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['channel_id', 'broadcast_day_id', 'source', 'snapshot', 'stream_ref']);
      t.index(['broadcast_day_id']);
      t.index(['series_id']);
    });
  }

  if (!(await knex.schema.hasTable('stream_views_runs'))) {
    await knex.schema.createTable('stream_views_runs', (t) => {
      t.uuid('broadcast_day_id').notNullable().references('id').inTable('broadcast_days').onDelete('CASCADE');
      t.string('snapshot', 16).notNullable();
      t.timestamp('ran_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.jsonb('summary').notNullable().defaultTo('{}');
      t.primary(['broadcast_day_id', 'snapshot']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stream_views_runs');
  await knex.schema.dropTableIfExists('stream_views');
  await knex.schema.dropTableIfExists('stream_view_readings');
}
