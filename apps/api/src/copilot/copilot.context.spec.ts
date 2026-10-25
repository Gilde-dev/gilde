import { copilotResourceId, memoryReferences } from './copilot.context.js';

describe('copilotResourceId', () => {
    it('is the user id and never a shared fallback', () => {
        expect(copilotResourceId({ id: 'u1' })).toBe('u1');
        expect(() => copilotResourceId(null)).toThrow();
    });
});

describe('memoryReferences', () => {
    it('finds thread ids in the path and resource/thread/message ids in query and nested body', () => {
        const refs = memoryReferences('/api/v1/mastra/memory/threads/t1/messages', { resourceId: 'r1' }, {
            threadId: 't2', memory: { resource: 'r2', thread: { id: 't3' } }, messages: [{ threadId: 't4', resourceId: 'r3' }], messageIds: ['m1', { id: 'm2' }],
        });
        expect(refs).toEqual({ resourceIds: ['r1', 'r2', 'r3'], threadIds: ['t1', 't2', 't3', 't4'], messageIds: ['m1', 'm2'] });
    });

    it('is empty for a request without memory references', () => {
        expect(memoryReferences('/api/v1/mastra/agents', {}, undefined)).toEqual({ resourceIds: [], threadIds: [], messageIds: [] });
    });
});
