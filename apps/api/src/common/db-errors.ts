// src/common/db-errors.ts
import { QueryFailedError } from 'typeorm';

/** Driver error codes, for Postgres (pg) and SQLite (better-sqlite3). */
const UNIQUE_VIOLATION = new Set(['23505', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);
const FOREIGN_KEY_VIOLATION = new Set(['23503', 'SQLITE_CONSTRAINT_FOREIGNKEY']);

function driverCode(e: unknown): string | undefined {
    if (!(e instanceof QueryFailedError)) return undefined;
    return (e.driverError as { code?: string } | undefined)?.code;
}

/** Insert or update hit a unique index, e.g. a duplicate slug or repo name. */
export function isUniqueViolation(e: unknown): boolean {
    const code = driverCode(e);
    return code !== undefined && UNIQUE_VIOLATION.has(code);
}

/** Insert or update referenced a row that doesn't exist, e.g. an unknown projectId. */
export function isForeignKeyViolation(e: unknown): boolean {
    const code = driverCode(e);
    return code !== undefined && FOREIGN_KEY_VIOLATION.has(code);
}