import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';

import { createMastra, createMemoryStorage, copilotDefaultOptions, COPILOT_AGENT_ID } from './copilot.mastra.js';

describe('createMemoryStorage', () => {
    it('uses Postgres for a postgres URL', () => {
        expect(createMemoryStorage('postgres://gilde:gilde@localhost:5432/gilde')).toBeInstanceOf(PostgresStore);
    });

    it('uses a LibSQL file otherwise', () => {
        expect(createMemoryStorage(undefined)).toBeInstanceOf(LibSQLStore);
        expect(createMemoryStorage('')).toBeInstanceOf(LibSQLStore);
    });
});

describe('createMastra', () => {
    it('has no agent when the co-pilot is disabled', () => {
        const mastra = createMastra({ enabled: false, model: null, reason: 'x' }, {} as never);
        expect(Object.keys(mastra.listAgents())).toEqual([]);
    });

    it('registers the gilde agent with its tools and the route inside the mastra prefix', async () => {
        const mastra = createMastra({ enabled: true, model: 'openai/test-model' }, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }));
        const agent = mastra.getAgent(COPILOT_AGENT_ID);
        expect(Object.keys(await agent.listTools()).length).toBe(16);
        expect(mastra.getServer()?.apiRoutes?.map((r) => r.path)).toEqual(['/api/v1/mastra/copilotkit']);
    });
});

describe('copilot step limit', () => {
    it('puts the configured step limit in the agent default options (default and from env)', async () => {
        const store = () => new LibSQLStore({ id: 't', url: 'file::memory:' });
        const custom = createMastra({ enabled: true, model: 'openai/test-model', maxSteps: 12 }, {} as never, store());
        expect((await custom.getAgent(COPILOT_AGENT_ID).getDefaultOptions()).maxSteps).toBe(12);
        const fallback = createMastra({ enabled: true, model: 'openai/test-model' }, {} as never, store());
        expect((await fallback.getAgent(COPILOT_AGENT_ID).getDefaultOptions()).maxSteps).toBe(30);
    });

    it('forces a final text answer and warns when the last step is reached', () => {
        const warn = vi.fn();
        const { prepareStep } = copilotDefaultOptions(3, { warn });
        expect(prepareStep({ stepNumber: 1 })).toBeUndefined();
        const result = prepareStep({ stepNumber: 2, systemMessages: [], requestContext: { get: () => 'thread-1' } });
        expect(result?.toolChoice).toBe('none');
        expect(result?.systemMessages[0].content).toContain('out of steps');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('thread-1'));
    });
});
