import type { Knex } from 'knex';

/**
 * Web Push notifications.
 *
 * Two tables:
 *   push_subscriptions — one row per device (user can have many).
 *   push_vapid_keys    — server-wide VAPID keypair (one row, generated once).
 *
 * The VAPID private key is encrypted at rest with AES-256-GCM keyed off
 * JWT_SECRET, mirroring src/utils/crypto.ts (same pattern as
 * youtube_api_keys.secret_encrypted).
 *
 * Per-event-type preferences live as a jsonb map on the subscription row so
 * users can mute noisy events (auto-discovery candidates) without losing the
 * subscription itself.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('push_vapid_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('public_key').notNullable();
    table.text('private_key_encrypted').notNullable();
    table.string('contact_email').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('NOW()'));
    table.timestamp('updated_at').notNullable().defaultTo(knex.raw('NOW()'));

    table.index('is_active', 'push_vapid_keys_is_active_idx');
  });

  await knex.schema.createTable('push_subscriptions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.text('endpoint').notNullable().unique();
    table.text('p256dh').notNullable();
    table.text('auth').notNullable();
    table.string('user_agent').nullable();
    table.jsonb('preferences').notNullable().defaultTo(knex.raw(`'{
      "broadcast_started": true,
      "broadcast_ending": true,
      "polling_stalled": true,
      "quota_exhausted": true,
      "discovery_candidate": true
    }'::jsonb`));
    table.timestamp('last_notified_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('NOW()'));
    table.timestamp('updated_at').notNullable().defaultTo(knex.raw('NOW()'));

    table.index('user_id', 'push_subscriptions_user_id_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('push_subscriptions');
  await knex.schema.dropTableIfExists('push_vapid_keys');
}
