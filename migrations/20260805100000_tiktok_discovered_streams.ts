import type { Knex } from 'knex';

/**
 * Staging buffer for TikTok live-category discovery.
 *
 * TikTok's category feed (webcast.tiktok.com/webcast/feed/) requires
 * request signatures only a real browser session can produce, so the
 * server cannot call it directly. Instead the residential tracking
 * machine's Chrome captures the feed (scripts/tiktok-category-discovery.ts)
 * and relays the rooms here. TikTokAdapter.searchLiveStreams() then reads
 * FRESH rows from this table, feeding the normal discovery pipeline —
 * keywords, thresholds and blocklists apply downstream exactly as they
 * do for Twitch/SOOP results.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL lock_timeout = '5s'`);
    await trx.schema.createTable('tiktok_discovered_streams', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      /** Category slug as scraped, e.g. 'gaming/PUBG:_BATTLEGROUNDS'. */
      table.string('category').notNullable();
      /** Bare username (no @) — matches how discovery inserts channels. */
      table.string('username').notNullable();
      table.string('nickname').nullable();
      table.string('room_id').nullable();
      table.string('title').nullable();
      table.integer('viewer_count').notNullable().defaultTo(0);
      table.string('language').nullable();
      table.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      table.unique(['category', 'username'], { indexName: 'tiktok_discovered_cat_user_unique' });
      table.index('captured_at', 'tiktok_discovered_captured_idx');
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tiktok_discovered_streams');
}
