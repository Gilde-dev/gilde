import type { EntityMetadata } from 'typeorm';

/** Tables in foreign-key order: a table comes after every table it references. */
export function sortByForeignKeys(metadatas: EntityMetadata[]): EntityMetadata[] {
    const sorted: EntityMetadata[] = [];
    const visited = new Set<EntityMetadata>();
    const visit = (meta: EntityMetadata) => {
        if (visited.has(meta)) return;
        visited.add(meta);
        for (const fk of meta.foreignKeys) {
            if (fk.referencedEntityMetadata !== meta) visit(fk.referencedEntityMetadata);
        }
        sorted.push(meta);
    };
    [...metadatas].sort((a, b) => a.tableName.localeCompare(b.tableName)).forEach(visit);
    return sorted;
}

const SQLITE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/** SQLite stores UTC datetimes as text ("2026-01-02 03:04:05.678"); Postgres `timestamp` columns take the same wall-clock value. */
export function toPostgresValue(value: unknown, kind: 'boolean' | 'datetime' | 'other'): unknown {
    if (value === null || value === undefined) return null;
    if (kind === 'boolean') return value === true || value === 1 || value === '1' || value === 'true';
    if (kind === 'datetime') {
        if (typeof value === 'number') return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
        const match = SQLITE_DATETIME.exec(String(value));
        return match ? `${match[1]} ${match[2]}${match[3] ?? ''}` : value;
    }
    return value;
}

export function columnKind(type: unknown): 'boolean' | 'datetime' | 'other' {
    if (type === Boolean || type === 'boolean') return 'boolean';
    if (type === Date || /timestamp|datetime/.test(String(type))) return 'datetime';
    return 'other';
}
