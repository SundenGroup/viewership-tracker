import type { Knex } from 'knex';

/**
 * TikTok as a Discover platform (fourth category column after
 * Twitch/Kick/SOOP, alongside the gated YouTube branch).
 *
 * The slug is the category path of tiktok.com/live/<slug> — e.g.
 * 'gaming/PUBG:_BATTLEGROUNDS' — and doubles as the join key into
 * tiktok_discovered_streams, the buffer the residential relay fills
 * (TikTok's category feed can't be called from a datacenter; see that
 * table's migration). NOTE: the feed is region-personalized sampling,
 * not an authoritative category list — the UI labels it as such.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL lock_timeout = '5s'`);
    await trx.schema.alterTable('game_trackers', (table) => {
      table.string('tiktok_category_slug').nullable();
      table.string('tiktok_category_name').nullable();
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_trackers', (table) => {
    table.dropColumn('tiktok_category_slug');
    table.dropColumn('tiktok_category_name');
  });
}
