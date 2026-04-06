import knex from 'knex';
import { config } from './config';

const db = knex({
  client: 'pg',
  connection: config.database.url,
  pool: {
    min: parseInt(process.env.DB_POOL_MIN || '2', 10),
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  },
});

export default db;
