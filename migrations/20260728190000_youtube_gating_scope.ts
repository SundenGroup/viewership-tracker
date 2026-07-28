import type { Knex } from 'knex';

/**
 * Per-channel approval SCOPE.
 *
 * Approving a YouTube channel used to mean "count everything they stream
 * unless the title names another game" — which required enumerating every
 * other game that exists. That list is unbounded and rots.
 *
 * The bounded list is the tracker's OWN vocabulary (game name, aliases,
 * event names), which we already maintain for discovery. So the reviewer
 * now makes a one-bit judgment they're well placed to make:
 *
 *   matching (default) — a variety streamer. Count the streams that match
 *                        this game's vocabulary, skip the rest.
 *   all               — a dedicated channel (an org's official channel,
 *                        a tournament channel). Everything they stream in
 *                        the Gaming category is this game.
 */
export async function up(knex: Knex): Promise<void> {
  // ADD COLUMN is instant in PG11+, but it still needs ACCESS EXCLUSIVE —
  // and the nightly pg_dump holds a snapshot across every table. Without a
  // lock_timeout the DDL sits in the lock queue and everything behind it
  // queues too, so a migration that merely can't run starts stalling the
  // poller's writes. Fail fast and let it be re-run instead.
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.schema.alterTable('game_tracker_youtube_channels', (t) => {
    t.text('scope').notNullable().defaultTo('matching');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_tracker_youtube_channels', (t) => {
    t.dropColumn('scope');
  });
}
