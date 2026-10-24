import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

export function databaseConfig(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): TypeOrmModuleOptions {
  if (databaseUrl?.startsWith('postgres://')) {
    return {
      type: 'postgres',
      url: databaseUrl,
      autoLoadEntities: true,
      synchronize: true,
    };
  }
  return {
    type: 'better-sqlite3',
    database: 'db.sqlite',
    autoLoadEntities: true,
    synchronize: true,
  };
}
