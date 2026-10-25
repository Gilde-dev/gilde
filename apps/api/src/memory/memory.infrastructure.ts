import { Logger, type OnModuleDestroy } from '@nestjs/common';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { MastraVector } from '@mastra/core/vector';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { PgVector, PostgresStore } from '@mastra/pg';

import { HISTORY_VECTOR_ID, PERSONAL_VECTOR_ID, type MemoryConfig } from './memory.config.js';

/** An embedder as Mastra Memory accepts it: a model router id (`openai/text-embedding-3-small`) or an AI SDK model. */
export type MemoryEmbedder = NonNullable<ConstructorParameters<typeof import('@mastra/memory').Memory>[0]>['embedder'];

/** Replaceable pieces, so tests can run on in-memory LibSQL with a deterministic embedder and no network. */
export interface MemoryInfrastructureOverrides {
    storage?: MastraCompositeStore;
    personalVector?: MastraVector;
    historyVector?: MastraVector;
    embedder?: MemoryEmbedder;
}

/**
 * Shared Mastra storage, vector stores and embedder. Lives below the co-pilot and the dispatcher so both can use it
 * without depending on each other. Everything is created lazily and nothing here calls an external service by itself:
 * the embedder is only used when something embeds.
 *
 * - `storage`: threads, messages and working memory (Postgres, or LibSQL file locally).
 * - `personalVector`: semantic recall of the co-pilot's conversations (index names chosen by Mastra Memory).
 * - `historyVector` + `historyIndexName`: the shared factory history, a separate store and index so the two never mix.
 */
export class MemoryInfrastructure implements OnModuleDestroy {
    private readonly logger = new Logger('Memory');
    private storageInstance?: MastraCompositeStore;
    private personalInstance?: MastraVector;
    private historyInstance?: MastraVector;
    private historyIndex?: Promise<void>;

    constructor(
        readonly config: MemoryConfig,
        private readonly overrides: MemoryInfrastructureOverrides = {},
    ) { }

    /** True when an embedder is configured; false means conversation history works but vector features are off. */
    get embeddingsEnabled(): boolean {
        return this.overrides.embedder !== undefined || this.config.embeddings;
    }

    get embeddingDimension(): number | undefined {
        return this.config.embeddings ? this.config.dimension : undefined;
    }

    /** Why vector features are off, or null. */
    get degradedReason(): string | null {
        return this.embeddingsEnabled ? null : (this.config as { reason: string }).reason;
    }

    get embedder(): MemoryEmbedder | undefined {
        if (this.overrides.embedder !== undefined) return this.overrides.embedder;
        return this.config.embeddings ? this.config.model : undefined;
    }

    get storage(): MastraCompositeStore {
        return (this.storageInstance ??= this.overrides.storage ?? this.createStorage());
    }

    get personalVector(): MastraVector {
        return (this.personalInstance ??= this.overrides.personalVector ?? this.createVector(PERSONAL_VECTOR_ID));
    }

    get historyVector(): MastraVector {
        return (this.historyInstance ??= this.overrides.historyVector ?? this.createVector(HISTORY_VECTOR_ID));
    }

    /** The index of the shared factory history. The dimension is in the name so a changed model gets a fresh index. */
    get historyIndexName(): string {
        return `gilde_history_${this.embeddingDimension ?? 'off'}`;
    }

    /**
     * Creates the history index (and, on Postgres, the pgvector extension) when it is missing. Idempotent and memoized;
     * a failure is not remembered, so the next call retries. Throws when embeddings are off or the store is unavailable.
     */
    ensureHistoryIndex(): Promise<void> {
        const dimension = this.embeddingDimension;
        if (!dimension) return Promise.reject(new Error(`History index unavailable: ${this.degradedReason ?? 'no embedding dimension'}`));
        this.historyIndex ??= this.historyVector.createIndex({ indexName: this.historyIndexName, dimension, metric: 'cosine' }).catch((error: unknown) => {
            this.historyIndex = undefined;
            this.logger.warn(`Creating the history vector index failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        });
        return this.historyIndex;
    }

    async onModuleDestroy(): Promise<void> {
        for (const vector of [this.personalInstance, this.historyInstance]) {
            const closable = vector as { close?: () => Promise<void>; disconnect?: () => Promise<void> } | undefined;
            try { await (closable?.disconnect?.() ?? closable?.close?.()); } catch { /* shutting down */ }
        }
    }

    private createStorage(): MastraCompositeStore {
        return this.config.databaseUrl
            ? new PostgresStore({ id: 'gilde-copilot', connectionString: this.config.databaseUrl })
            : new LibSQLStore({ id: 'gilde-copilot', url: this.config.libsqlUrl });
    }

    private createVector(id: string): MastraVector {
        return this.config.databaseUrl
            ? new PgVector({ id, connectionString: this.config.databaseUrl })
            : new LibSQLVector({ id, url: this.config.libsqlUrl });
    }
}
