import { memoryConfig } from './memory.config.js';

describe('memoryConfig', () => {
    it('is off without OPENAI_API_KEY, independent of COPILOT_MODEL', () => {
        expect(memoryConfig({ COPILOT_MODEL: 'openai/x' })).toMatchObject({ embeddings: false, reason: expect.stringContaining('OPENAI_API_KEY') });
    });

    it('defaults to text-embedding-3-small with 1536 dimensions and a local LibSQL file', () => {
        expect(memoryConfig({ OPENAI_API_KEY: 'k' })).toEqual({ embeddings: true, model: 'openai/text-embedding-3-small', dimension: 1536, databaseUrl: undefined, libsqlUrl: 'file:mastra.db' });
    });

    it('takes model, dimension and Postgres from the environment', () => {
        const config = memoryConfig({ OPENAI_API_KEY: 'k', MEMORY_EMBEDDING_MODEL: 'openai/text-embedding-3-large', MEMORY_EMBEDDING_DIMENSION: '3072', DATABASE_URL: 'postgres://u:p@h/db' });
        expect(config).toMatchObject({ embeddings: true, model: 'openai/text-embedding-3-large', dimension: 3072, databaseUrl: 'postgres://u:p@h/db' });
    });

    it.each([['0'], ['-3'], ['1.5'], ['abc']])('rejects dimension %s', (dimension) => {
        expect(memoryConfig({ OPENAI_API_KEY: 'k', MEMORY_EMBEDDING_DIMENSION: dimension })).toMatchObject({ embeddings: false });
    });

    it('rejects a non-OpenAI embedding model', () => {
        expect(memoryConfig({ OPENAI_API_KEY: 'k', MEMORY_EMBEDDING_MODEL: 'other/x' })).toMatchObject({ embeddings: false });
    });
});
