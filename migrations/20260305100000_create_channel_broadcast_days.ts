import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('channel_broadcast_days', (table) => {
    table
      .uuid('id')
      .primary()
      .defaultTo(knex.raw('gen_random_uuid()'));

    table
      .uuid('channel_id')
      .notNullable()
      .references('id')
      .inTable('channels')
      .onDelete('CASCADE');

    table
      .uuid('broadcast_day_id')
      .notNullable()
      .references('id')
      .inTable('broadcast_days')
      .onDelete('CASCADE');

    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.unique(['channel_id', 'broadcast_day_id']);
    table.index('channel_id');
    table.index('broadcast_day_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('channel_broadcast_days');
}
