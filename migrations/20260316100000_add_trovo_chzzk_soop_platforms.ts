import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TYPE "platform_type" ADD VALUE IF NOT EXISTS 'trovo'`);
  await knex.raw(`ALTER TYPE "platform_type" ADD VALUE IF NOT EXISTS 'chzzk'`);
  await knex.raw(`ALTER TYPE "platform_type" ADD VALUE IF NOT EXISTS 'soop'`);
}

export async function down(_knex: Knex): Promise<void> {
  // PostgreSQL does not support removing enum values directly.
  // To reverse: delete all trovo/chzzk/soop channels, then rebuild the enum.
}
