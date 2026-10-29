import { createHash } from 'node:crypto';

import { LibSQLStore, LibSQLVector } from '@mastra/libsql';

import { memoryConfig } from './memory.config.js';
import { MemoryInfrastructure, type MemoryInfrastructureOverrides } from './memory.infrastructure.js';

/**
 * Deterministic AI SDK embedding model for tests: a hashed bag of words, L2-normalized, so texts that share words are
 * close. No network. Records every call in `calls`.
 */
export function fakeEmbedder(dimension = 1536) {
    const calls: string[][] = [];
    const embedOne = (text: string): number[] => {
        const vector = new Array<number>(dimension).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
            vector[createHash('sha256').update(word).digest().readUInt32BE(0) % dimension] += 1;
        }
        const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
        return vector.map((x) => x / norm);
    };
    return {
        specificationVersion: 'v2' as const,
        provider: 'fake',
        modelId: 'fake-embedding',
        maxEmbeddingsPerCall: 100,
        supportsParallelCalls: true,
        calls,
        doEmbed: async ({ values }: { values: string[] }) => {
            calls.push(values);
            return { embeddings: values.map(embedOne), usage: { tokens: values.length }, warnings: [] };
        },
    };
}

/** Vectors created by testMemoryInfrastructure that settleTestMemory has not awaited yet. */
const pendingVectors: LibSQLVector[] = [];

/** Infrastructure on a LibSQL file (default: in memory) with the fake embedder; embeddings count as configured. */
export function testMemoryInfrastructure(options: { url?: string; dimension?: number } & MemoryInfrastructureOverrides = {}): MemoryInfrastructure {
    const url = options.url ?? 'file::memory:?cache=shared';
    const dimension = options.dimension ?? 64;
    const config = { ...memoryConfig({ OPENAI_API_KEY: 'test', MEMORY_EMBEDDING_DIMENSION: String(dimension) }), libsqlUrl: url };
    const personalVector = new LibSQLVector({ id: `test-personal-${url}`, url });
    const historyVector = new LibSQLVector({ id: `test-history-${url}`, url });
    pendingVectors.push(personalVector, historyVector);
    return new MemoryInfrastructure(config, {
        storage: new LibSQLStore({ id: `test-store-${url}`, url }),
        personalVector,
        historyVector,
        embedder: fakeEmbedder(dimension) as never,
        ...options,
    });
}

/**
 * Waits until every LibSQLVector made by testMemoryInfrastructure has finished initializing. LibSQLVector starts
 * initializing (a realpath of its file) in the constructor without anyone awaiting it, so deleting a temp dir right
 * after a test can make that realpath fail later as an unhandled rejection, which fails the whole vitest run (seen on
 * CI). Call this before removing a directory a test infrastructure lives in. Initialization errors are ignored here.
 */
export async function settleTestMemory(): Promise<void> {
    const vectors = pendingVectors.splice(0);
    // listIndexes is public and awaits the vector's initialization first.
    await Promise.allSettled(vectors.map((v) => v.listIndexes()));
}
