import { describe, expect, it, vi } from 'vitest';

import { HistoryEmbedder } from './history-embedder.js';

const infra = (embedder: unknown) => ({ embedder, embeddingDimension: undefined, config: { embeddings: true, model: 'openai/emb', dimension: 1 } }) as never;
const options = { embedAttempts: 1, retryDelayMs: 0 };

describe('HistoryEmbedder usage', () => {
    it('records one embedding row per batch, without a user', async () => {
        const record = vi.fn();
        const model = { doEmbed: vi.fn(async () => ({ embeddings: [[1], [2]], usage: { tokens: 7 } })) };
        await new HistoryEmbedder(infra(model), options, { record }).embed(['a', 'b']);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith({ kind: 'embedding', model: 'openai/emb', userId: null, inputTokens: 7 });
    });

    it('does not fail indexing when recording is not possible', async () => {
        const model = { doEmbed: vi.fn(async () => ({ embeddings: [[1]] })) };
        await expect(new HistoryEmbedder(infra(model), options).embed(['a'])).resolves.toEqual([[1]]);
    });
});
