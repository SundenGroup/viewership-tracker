import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw("ALTER TYPE platform_type ADD VALUE IF NOT EXISTS 'nimotv'");
}

export async function down(_knex: Knex): Promise<void> {
  // PostgreSQL doesn't support removing enum values
  // The value will remain but be unused
}
