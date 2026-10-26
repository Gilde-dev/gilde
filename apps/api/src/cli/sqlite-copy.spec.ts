import { columnKind, toPostgresValue } from './sqlite-copy.js';

describe('toPostgresValue', () => {
    it('keeps SQLite UTC datetimes as the same wall-clock timestamp', () => {
        expect(toPostgresValue('2026-01-02 03:04:05', 'datetime')).toBe('2026-01-02 03:04:05');
        expect(toPostgresValue('2026-01-02 03:04:05.678', 'datetime')).toBe('2026-01-02 03:04:05.678');
        expect(toPostgresValue('2026-01-02T03:04:05.678', 'datetime')).toBe('2026-01-02 03:04:05.678');
    });

    it('converts epoch milliseconds to UTC', () => {
        expect(toPostgresValue(Date.UTC(2026, 0, 2, 3, 4, 5), 'datetime')).toBe('2026-01-02 03:04:05.000');
    });

    it('converts 0/1 to booleans and passes null through', () => {
        expect(toPostgresValue(1, 'boolean')).toBe(true);
        expect(toPostgresValue(0, 'boolean')).toBe(false);
        expect(toPostgresValue(null, 'boolean')).toBeNull();
        expect(toPostgresValue('{"a":1}', 'other')).toBe('{"a":1}');
    });
});

describe('columnKind', () => {
    it('classifies column types', () => {
        expect(columnKind(Date)).toBe('datetime');
        expect(columnKind('timestamp')).toBe('datetime');
        expect(columnKind(Boolean)).toBe('boolean');
        expect(columnKind('varchar')).toBe('other');
    });
});
