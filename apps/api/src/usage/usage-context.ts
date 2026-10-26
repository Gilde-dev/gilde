import { AsyncLocalStorage } from 'node:async_hooks';

import type { UsageService } from './usage.service.js';

/** The acting user of the current co-pilot request, so embedding calls made deep inside Mastra Memory can be attributed. */
export const usageUser = new AsyncLocalStorage<{ userId: string }>();

interface EmbeddingModel {
    doEmbed(args: never): Promise<{ usage?: { tokens?: number } }>;
}

/**
 * Wraps an AI SDK embedding model so every doEmbed call (one batch) stores a usage row of kind embedding. The wrapper
 * is transparent: the result is returned untouched and recording is best effort and not awaited.
 */
export function withEmbeddingUsage<T extends object>(model: T, modelName: string, usage: Pick<UsageService, 'record'>): T {
    return new Proxy(model, {
        get(target, prop, receiver) {
            if (prop !== 'doEmbed') return Reflect.get(target, prop, receiver);
            return async (args: never) => {
                const result = await (target as unknown as EmbeddingModel).doEmbed(args);
                void usage.record({ kind: 'embedding', model: modelName, userId: usageUser.getStore()?.userId ?? null, inputTokens: result.usage?.tokens ?? 0 });
                return result;
            };
        },
    });
}
