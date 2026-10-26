import { fileURLToPath } from 'node:url';

import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

export function isPostgresUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//.test(url);
}

/** Compiled migrations; resolved relative to this module so it works from dist/. */
export const MIGRATIONS_GLOB = fileURLToPath(
  new URL('./migrations/*.js', import.meta.url),
);

export function databaseConfig(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): TypeOrmModuleOptions {
  if (isPostgresUrl(databaseUrl)) {
    return {
      type: 'postgres',
      url: databaseUrl,
      autoLoadEntities: true,
      synchronize: false,
      migrationsRun: true,
      migrations: [MIGRATIONS_GLOB],
    };
  }
  return {
    type: 'better-sqlite3',
    database: 'db.sqlite',
    autoLoadEntities: true,
    synchronize: true,
  };
}
