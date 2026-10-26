import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { DataSource } from 'typeorm';

import dataSource from '../data-source.js';

import { columnKind, sortByForeignKeys, toPostgresValue } from './sqlite-copy.js';

const BATCH_SIZE = 200;

function sqlitePath(): string {
    const flag = process.argv.indexOf('--sqlite');
    const path = (flag >= 0 ? process.argv[flag + 1] : undefined) ?? process.env.SQLITE_PATH ?? 'db.sqlite';
    return resolve(path);
}

function quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

async function main() {
    const path = sqlitePath();
    if (!existsSync(path)) throw new Error(`SQLite file not found: ${path} (use --sqlite <path> or SQLITE_PATH)`);
    const source = new DataSource({ type: 'better-sqlite3', database: path, readonly: true, synchronize: false, entities: [] });
    await source.initialize();
    await dataSource.initialize();
    try {
        const pending = await dataSource.showMigrations();
        if (pending) throw new Error('The target has pending migrations; run `pnpm --filter @gilde/api migration:run` first');

        const tables = sortByForeignKeys(dataSource.entityMetadatas);
        for (const meta of tables) {
            const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM ${quote(meta.tableName)}`);
            if (count > 0) {
                throw new Error(`Target table ${meta.tableName} already has ${count} rows; the copy only runs into an empty database`);
            }
        }

        const sourceTables = new Set(
            (await source.query("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]).map((t) => t.name),
        );
        const counts: Record<string, number> = {};
        await dataSource.transaction(async (manager) => {
            for (const meta of tables) {
                counts[meta.tableName] = 0;
                if (!sourceTables.has(meta.tableName)) continue;
                const columns = meta.columns.map((column) => ({
                    name: column.databaseName,
                    // SQLite files created before the snake_case rename have the property name as column name
                    legacyName: column.propertyName,
                    kind: columnKind(column.type),
                }));
                const rows: Record<string, unknown>[] = await source.query(`SELECT * FROM ${quote(meta.tableName)}`);
                const perBatch = Math.max(1, Math.min(BATCH_SIZE, Math.floor(60000 / columns.length)));
                for (let i = 0; i < rows.length; i += perBatch) {
                    const batch = rows.slice(i, i + perBatch);
                    const params: unknown[] = [];
                    const tuples = batch.map((row) => {
                        const placeholders = columns.map((column) => {
                            const raw = column.name in row ? row[column.name] : row[column.legacyName];
                            params.push(toPostgresValue(raw, column.kind));
                            return `$${params.length}`;
                        });
                        return `(${placeholders.join(', ')})`;
                    });
                    await manager.query(
                        `INSERT INTO ${quote(meta.tableName)} (${columns.map((c) => quote(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`,
                        params,
                    );
                }
                counts[meta.tableName] = rows.length;
            }
        });

        console.log(`Copied ${path} into Postgres:`);
        for (const [table, count] of Object.entries(counts)) console.log(`  ${table}: ${count}`);
        console.log('Mastra data (mastra.db) is not copied; co-pilot conversations start fresh. Rebuild the history index with POST /api/v1/history/rebuild.');
    } finally {
        await source.destroy();
        await dataSource.destroy();
    }
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
