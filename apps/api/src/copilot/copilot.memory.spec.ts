import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';

import { memoryConfig } from '../memory/memory.config.js';
import { MemoryInfrastructure } from '../memory/memory.infrastructure.js';
import { fakeEmbedder, testMemoryInfrastructure } from '../memory/memory.testing.js';

import { createCopilotMemory, WORKING_MEMORY_TEMPLATE } from './copilot.mastra.js';

/** Real LibSQL storage and vector files in a temp dir, a deterministic embedder and a mock model: no network. */
describe('co-pilot memory (local Mastra persistence)', () => {
    let dir: string;
    const embedder = fakeEmbedder(64);
    const open = () => testMemoryInfrastructure({ url: `file:${join(dir, 'mastra.db')}`, dimension: 64, embedder: embedder as never });

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gilde-memory-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    async function say(infra: MemoryInfrastructure, userId: string, threadId: string, text: string) {
        const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model: createMockModel({ mockText: 'ok', version: 'v2' }) as never, memory: createCopilotMemory(infra) });
        const requestContext = new RequestContext();
        requestContext.set(MASTRA_RESOURCE_ID_KEY, userId);
        requestContext.set(MASTRA_THREAD_ID_KEY, threadId);
        await agent.generate(text, { memory: { resource: userId, thread: threadId }, requestContext });
    }

    it('keeps working memory per user across threads and a recreated instance, and updates it', async () => {
        const first = createCopilotMemory(open());
        await first.createThread({ threadId: 't1', resourceId: 'alice' });
        await first.createThread({ threadId: 't2', resourceId: 'alice' });
        await first.updateWorkingMemory({ threadId: 't1', resourceId: 'alice', workingMemory: '# User preferences\n- Preferred language: Dutch\n' });

        const restarted = createCopilotMemory(open());
        expect(await restarted.getWorkingMemory({ threadId: 't2', resourceId: 'alice' })).toContain('Dutch');
        await restarted.updateWorkingMemory({ threadId: 't2', resourceId: 'alice', workingMemory: '# User preferences\n- Preferred language: English\n' });
        const again = await createCopilotMemory(open()).getWorkingMemory({ threadId: 't1', resourceId: 'alice' });
        expect(again).toContain('English');
        expect(again).not.toContain('Dutch');
        expect(WORKING_MEMORY_TEMPLATE.length).toBeLessThan(300);
    });

    it('recalls an old conversation by meaning, outside the last 20 messages, only for its owner', async () => {
        const infra = open();
        await say(infra, 'alice', 'old', 'the nightly invoice export fails with a timeout on the billing database');
        for (let i = 0; i < 12; i++) await say(infra, 'alice', 'busy', `unrelated chatter number ${i} about lunch`);
        await say(infra, 'bob', 'bobs', 'bob secret: the quarterly zeppelin budget is approved');

        const restarted = createCopilotMemory(open());
        const alice = await restarted.recall({
            threadId: 'new', resourceId: 'alice', vectorSearchString: 'invoice export timeout billing database',
            threadConfig: { lastMessages: 20, semanticRecall: { topK: 3, messageRange: 1, scope: 'resource' } },
        });
        const aliceText = JSON.stringify(alice.messages);
        expect(aliceText).toContain('invoice export');
        expect(aliceText).not.toContain('zeppelin');

        const bob = await restarted.recall({
            threadId: 'new-bob', resourceId: 'bob', vectorSearchString: 'invoice export timeout billing database',
            threadConfig: { lastMessages: 20, semanticRecall: { topK: 3, messageRange: 1, scope: 'resource' } },
        });
        expect(JSON.stringify(bob.messages)).not.toContain('invoice export');
    });

    it('isolates working memory and threads of two users', async () => {
        const memory = createCopilotMemory(open());
        await memory.createThread({ threadId: 'a1', resourceId: 'alice' });
        await memory.updateWorkingMemory({ threadId: 'a1', resourceId: 'alice', workingMemory: '- Preferred language: Dutch' });
        expect(JSON.stringify(await memory.getWorkingMemory({ threadId: 'b1', resourceId: 'bob' }))).not.toContain('Dutch');
        expect((await memory.listThreads({ filter: { resourceId: 'bob' } })).threads).toEqual([]);
    });

    it('works without embeddings: no vector store, no embedding calls, working memory still stored', async () => {
        const infra = new MemoryInfrastructure(memoryConfig({}), { storage: open().storage });
        expect(infra.embeddingsEnabled).toBe(false);
        expect(infra.degradedReason).toContain('OPENAI_API_KEY');
        const memory = createCopilotMemory(infra);
        await memory.createThread({ threadId: 't', resourceId: 'alice' });
        await memory.updateWorkingMemory({ threadId: 't', resourceId: 'alice', workingMemory: '- x: y' });
        expect(await memory.getWorkingMemory({ threadId: 't', resourceId: 'alice' })).toContain('x: y');
        await expect(infra.ensureHistoryIndex()).rejects.toThrow(/unavailable/);
    });

    it('creates the history index idempotently, separate from personal recall', async () => {
        const infra = open();
        await infra.ensureHistoryIndex();
        await infra.ensureHistoryIndex();
        await open().ensureHistoryIndex();
        expect(await infra.historyVector.listIndexes()).toContain('gilde_history_64');
        expect(infra.historyIndexName).toBe('gilde_history_64');
    });
});
