import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TYPE "user_role" AS ENUM ('admin', 'editor', 'viewer')`);

  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email').notNullable().unique();
    table.string('password_hash').notNullable();
    table.string('display_name').notNullable();
    table.specificType('role', 'user_role').notNullable().defaultTo('viewer');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('last_login_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index('email');
    table.index('role');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
  await knex.raw('DROP TYPE IF EXISTS "user_role"');
}
