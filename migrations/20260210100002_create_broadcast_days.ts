import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('broadcast_days', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('stage_id')
      .notNullable()
      .references('id')
      .inTable('stages')
      .onDelete('CASCADE');
    table
      .uuid('series_id')
      .notNullable()
      .references('id')
      .inTable('tournament_series')
      .onDelete('CASCADE');
    table.string('label').notNullable();
    table.date('date').notNullable();
    table.timestamp('broadcast_start', { useTz: true });
    table.timestamp('broadcast_end', { useTz: true });
    table
      .enum('status', ['scheduled', 'live', 'completed'], {
        useNative: true,
        enumName: 'broadcast_status',
      })
      .defaultTo('scheduled');
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index('stage_id');
    table.index('series_id');
    table.index('date');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('broadcast_days');
  await knex.raw('DROP TYPE IF EXISTS "broadcast_status"');
}
