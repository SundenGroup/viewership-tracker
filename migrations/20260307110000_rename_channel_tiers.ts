import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Rename existing enum values (PostgreSQL 10+)
  await knex.raw(`ALTER TYPE channel_tier RENAME VALUE 'primary' TO 'official'`);
  await knex.raw(`ALTER TYPE channel_tier RENAME VALUE 'secondary' TO 'partner'`);
  // Add new 'player' tier
  await knex.raw(`ALTER TYPE channel_tier ADD VALUE 'player'`);
}

export async function down(knex: Knex): Promise<void> {
  // Note: PostgreSQL cannot remove enum values or rename them back easily.
  // This is a one-way migration. To reverse, you'd need to recreate the type.
  await knex.raw(`ALTER TYPE channel_tier RENAME VALUE 'official' TO 'primary'`);
  await knex.raw(`ALTER TYPE channel_tier RENAME VALUE 'partner' TO 'secondary'`);
  // Cannot remove 'player' from enum without recreating the type
}
