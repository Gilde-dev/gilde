import { ModelRouterEmbeddingModel } from '@mastra/core/llm';

import type { MemoryInfrastructure } from '../memory.infrastructure.js';
import type { HistoryOptions } from './history.types.js';

interface Embedding {
    doEmbed(args: { values: string[]; providerOptions?: Record<string, Record<string, unknown>> }): Promise<{ embeddings: number[][] }>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The shared OpenAI embedder (the one Memory uses, from MemoryInfrastructure) for history text. Retries a request a few
 * times with backoff and checks the dimension, so a misconfigured model fails loudly instead of corrupting the index.
 */
export class HistoryEmbedder {
    private routed?: Embedding;

    constructor(
        private readonly infra: MemoryInfrastructure,
        private readonly options: Pick<HistoryOptions, 'embedAttempts' | 'retryDelayMs'>,
    ) { }

    private get model(): Embedding {
        const embedder = this.infra.embedder;
        if (!embedder) throw new Error(`Embeddings are off: ${this.infra.degradedReason ?? 'no embedder configured'}`);
        if (typeof embedder !== 'string') return embedder as unknown as Embedding;
        return (this.routed ??= new ModelRouterEmbeddingModel(embedder) as unknown as Embedding);
    }

    async embed(values: string[]): Promise<number[][]> {
        if (!values.length) return [];
        const dimension = this.infra.embeddingDimension;
        const providerOptions = typeof this.infra.embedder === 'string' && this.infra.embedder.includes('text-embedding-3') && dimension
            ? { openai: { dimensions: dimension } }
            : undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.options.embedAttempts; attempt++) {
            try {
                const { embeddings } = await this.model.doEmbed({ values, providerOptions });
                if (embeddings.length !== values.length) throw new Error(`Embedder returned ${embeddings.length} vectors for ${values.length} inputs`);
                const bad = embeddings.find((e) => dimension !== undefined && e.length !== dimension);
                if (bad) throw new Error(`Embedder returned ${bad.length} dimensions, expected ${dimension}; fix MEMORY_EMBEDDING_DIMENSION and rebuild the history index`);
                return embeddings;
            } catch (error) {
                lastError = error;
                if (attempt < this.options.embedAttempts) await sleep(this.options.retryDelayMs * 2 ** (attempt - 1));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
}
