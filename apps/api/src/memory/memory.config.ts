export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSION = 1536;
export const DEFAULT_LIBSQL_URL = 'file:mastra.db';

/** Index/namespace names. Personal recall indexes are named by Mastra Memory itself (`memory_messages_<dimension>`). */
export const PERSONAL_VECTOR_ID = 'gilde-personal';
export const HISTORY_VECTOR_ID = 'gilde-history';

export type MemoryConfig = {
    /** Postgres connection string, or undefined for a local LibSQL file. */
    databaseUrl?: string;
    libsqlUrl: string;
} & (
    | { embeddings: true; model: string; dimension: number }
    | { embeddings: false; reason: string }
);

/**
 * Embeddings need OPENAI_API_KEY (server-side, independent of COPILOT_MODEL). The model is an OpenAI model id in the
 * Mastra model router format and the dimension must be what that model returns. Without a key everything still starts:
 * storage and conversation history work, only the vector features are off.
 */
export function memoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
    const databaseUrl = isPostgresUrl(env.DATABASE_URL) ? env.DATABASE_URL : undefined;
    const base = { databaseUrl, libsqlUrl: env.MASTRA_DB_URL?.trim() || DEFAULT_LIBSQL_URL };
    const model = env.MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
    if (!env.OPENAI_API_KEY?.trim()) return { ...base, embeddings: false, reason: 'OPENAI_API_KEY is not set' };
    if (!model.startsWith('openai/') || model === 'openai/') {
        return { ...base, embeddings: false, reason: 'MEMORY_EMBEDDING_MODEL must be an OpenAI model id in the form openai/<model>' };
    }
    const raw = env.MEMORY_EMBEDDING_DIMENSION?.trim();
    const dimension = raw ? Number(raw) : DEFAULT_EMBEDDING_DIMENSION;
    if (!Number.isInteger(dimension) || dimension <= 0) {
        return { ...base, embeddings: false, reason: 'MEMORY_EMBEDDING_DIMENSION must be a positive integer' };
    }
    return { ...base, embeddings: true, model, dimension };
}

export function isPostgresUrl(url: string | undefined): url is string {
    return !!url && (url.startsWith('postgres://') || url.startsWith('postgresql://'));
}
