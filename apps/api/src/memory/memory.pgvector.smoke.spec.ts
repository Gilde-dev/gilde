import { PgVector } from '@mastra/pg';

import { fakeEmbedder } from './memory.testing.js';

/** Opt-in smoke check against a real Postgres with pgvector: set PGVECTOR_SMOKE_URL (see README). */
describe.skipIf(!process.env.PGVECTOR_SMOKE_URL)('Postgres + pgvector smoke', () => {
    const indexName = `gilde_smoke_${Date.now()}`;
    let vector: PgVector;

    beforeAll(() => { vector = new PgVector({ id: 'smoke', connectionString: process.env.PGVECTOR_SMOKE_URL! }); });
    afterAll(async () => {
        await vector.deleteIndex({ indexName });
        await vector.disconnect();
    });

    it('creates the extension and index idempotently, then stores and finds a vector', async () => {
        const embedder = fakeEmbedder(16);
        await vector.createIndex({ indexName, dimension: 16 });
        await vector.createIndex({ indexName, dimension: 16 });
        const { embeddings } = await embedder.doEmbed({ values: ['invoice export timeout', 'lunch plans'] });
        await vector.upsert({ indexName, vectors: embeddings, metadata: [{ text: 'a' }, { text: 'b' }], ids: ['a', 'b'] });
        const [{ embeddings: [query] }] = [await embedder.doEmbed({ values: ['invoice export'] })];
        const hits = await vector.query({ indexName, queryVector: query, topK: 1 });
        expect(hits[0].id).toBe('a');
    });
});
