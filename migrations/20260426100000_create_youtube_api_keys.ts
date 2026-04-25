import type { Knex } from 'knex';

/**
 * YouTube API key pool.
 *
 * Keys are tagged with a partner string (free text — usually matches
 * tournament_series.partner like "PUBG", "PGL", "GeoGuessr") so per-partner
 * quota usage can be reported. Keys with partner = NULL are "shared/legacy"
 * keys used as the global fallback.
 *
 * Secrets are encrypted at rest with AES-256-GCM keyed off JWT_SECRET.
 *
 * `daily_quota` defaults to Google's standard 10 000 units; admins can edit
 * per key (Google sometimes grants higher quotas to specific projects).
 *
 * Soft-delete via is_active so quota history (in viewership_youtube_quota)
 * stays attributable.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('youtube_api_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('label').notNullable();
    table.string('partner').nullable();
    table.text('secret_encrypted').notNullable();
    table.string('secret_last4').notNullable();
    table.integer('daily_quota').notNullable().defaultTo(10000);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.uuid('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('NOW()'));
    table.timestamp('updated_at').notNullable().defaultTo(knex.raw('NOW()'));
    table.timestamp('last_used_at').nullable();

    table.index('partner', 'youtube_api_keys_partner_idx');
    table.index('is_active', 'youtube_api_keys_is_active_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('youtube_api_keys');
}
