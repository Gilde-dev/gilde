import { databaseConfig } from './database.config.js';

describe('databaseConfig', () => {
  it('uses postgres with the url for a postgres:// DATABASE_URL', () => {
    const url = 'postgres://gilde:gilde@localhost:5432/gilde';
    expect(databaseConfig(url)).toMatchObject({
      type: 'postgres',
      url,
      synchronize: false,
      migrationsRun: true,
    });
  });

  it('accepts postgresql:// URLs and loads the compiled migrations', () => {
    const config = databaseConfig('postgresql://gilde:gilde@localhost:5432/gilde');
    expect(config).toMatchObject({ type: 'postgres', synchronize: false });
    expect((config as { migrations: string[] }).migrations[0]).toMatch(/migrations[\\/]\*\.js$/);
  });

  it('falls back to better-sqlite3 when DATABASE_URL is unset', () => {
    expect(databaseConfig(undefined)).toMatchObject({
      type: 'better-sqlite3',
      database: 'db.sqlite',
      autoLoadEntities: true,
      synchronize: true,
    });
  });
});
