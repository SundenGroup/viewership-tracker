import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('stages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('series_id')
      .notNullable()
      .references('id')
      .inTable('tournament_series')
      .onDelete('CASCADE');
    table.string('name').notNullable();
    table.integer('order').notNullable();
    table.date('start_date');
    table.date('end_date');
    table
      .enum('status', ['draft', 'active', 'completed'], {
        useNative: true,
        existingType: true,
        enumName: 'tournament_status',
      })
      .defaultTo('draft');
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index('series_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stages');
}
