/** A repository stand-in that understands the where-clauses and ordering the MCP tools service uses (equality and In). */
export function memoryRepo<T extends object>(rows: T[]) {
    const matches = (row: T, where: Record<string, unknown>) =>
        Object.entries(where).every(([k, v]) => {
            const value = (row as Record<string, unknown>)[k];
            return v && typeof v === 'object' && 'type' in v ? (v as { value: unknown[] }).value.includes(value) : value === v;
        });
    return {
        find: async ({ where, order }: { where: Record<string, unknown>; order?: Record<string, string> }) => {
            const found = rows.filter((r) => matches(r, where));
            const key = order && Object.keys(order)[0];
            return key ? [...found].sort((a, b) => String((a as never)[key]).localeCompare(String((b as never)[key]))) : found;
        },
    };
}
