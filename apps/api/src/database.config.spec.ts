import { databaseConfig } from './database.config.js';

describe('databaseConfig', () => {
  it('uses postgres with the url for a postgres:// DATABASE_URL', () => {
    const url = 'postgres://gilde:gilde@localhost:5432/gilde';
    expect(databaseConfig(url)).toMatchObject({ type: 'postgres', url });
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
