import { fileURLToPath } from 'node:url';

import { DataSource } from 'typeorm';

import { isPostgresUrl, MIGRATIONS_GLOB } from './database.config.js';

const url = process.env.DATABASE_URL;
if (!isPostgresUrl(url)) {
  throw new Error(
    'DATABASE_URL must be a Postgres URL (postgres://user:pass@host:5432/db) to use the migration CLI',
  );
}

/** DataSource for the TypeORM CLI (migration:*) and the SQLite copy; entities and migrations are the compiled files. */
export default new DataSource({
  type: 'postgres',
  url,
  entities: [fileURLToPath(new URL('./**/*.entity.js', import.meta.url))],
  migrations: [MIGRATIONS_GLOB],
  synchronize: false,
});
