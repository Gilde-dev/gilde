import { Global, Logger, Module } from '@nestjs/common';

import { memoryConfig, type MemoryConfig } from './memory.config.js';
import { MemoryInfrastructure } from './memory.infrastructure.js';
import { MEMORY_CONFIG, MEMORY_INFRASTRUCTURE } from './memory.tokens.js';

/**
 * Mastra storage, vector stores and the embedder, shared by the co-pilot and (later) the history index and the
 * dispatcher. It imports no other Gilde module, so nothing can form a cycle with it. Without OPENAI_API_KEY the
 * API still starts: vector features are off and no embedding request is made.
 */
@Global()
@Module({
    providers: [
        {
            provide: MEMORY_CONFIG,
            useFactory: (): MemoryConfig => {
                const config = memoryConfig();
                if (!config.embeddings) new Logger('Memory').warn(`Embeddings off: ${config.reason}. Semantic recall and history search are unavailable.`);
                return config;
            },
        },
        { provide: MEMORY_INFRASTRUCTURE, useFactory: (config: MemoryConfig) => new MemoryInfrastructure(config), inject: [MEMORY_CONFIG] },
    ],
    exports: [MEMORY_CONFIG, MEMORY_INFRASTRUCTURE],
})
export class MemoryModule { }
