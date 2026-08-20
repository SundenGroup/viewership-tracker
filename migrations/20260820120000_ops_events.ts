import type { Knex } from 'knex';

/**
 * ops_events — persistent log of every operator notification the system
 * emits (the same events Web Push delivers: data anomalies, polling
 * stalls, quota exhaustion, discovery candidates, broadcast lifecycle).
 *
 * Push notifications are ephemeral: dismissed, throttled, or simply
 * missed. This table is the reviewable history behind them — written on
 * every notify() call even when zero devices are subscribed.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('SET LOCAL statement_timeout = 0');
  await knex.schema.createTable('ops_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('event_type').notNullable();
    t.text('title').notNullable();
    t.text('body').notNullable().defaultTo('');
    t.text('url');
    t.boolean('urgent').notNullable().defaultTo(false);
    // Fan-out result — how many push subscribers actually received it.
    t.integer('sent').notNullable().defaultTo(0);
    t.integer('failed').notNullable().defaultTo(0);
    t.integer('pruned').notNullable().defaultTo(0);
  });
  await knex.raw('CREATE INDEX idx_ops_events_created ON ops_events (created_at DESC)');
  await knex.raw('CREATE INDEX idx_ops_events_type ON ops_events (event_type, created_at DESC)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ops_events');
}
