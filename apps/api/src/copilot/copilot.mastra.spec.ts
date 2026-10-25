import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';

import { createMastra, createMemoryStorage, COPILOT_AGENT_ID } from './copilot.mastra.js';

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

    it('registers the gilde agent with the read-only tools and the route inside the mastra prefix', async () => {
        const mastra = createMastra({ enabled: true, model: 'openai/test-model' }, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }));
        const agent = mastra.getAgent(COPILOT_AGENT_ID);
        expect(Object.keys(await agent.listTools()).length).toBe(11);
        expect(mastra.getServer()?.apiRoutes?.map((r) => r.path)).toEqual(['/api/v1/mastra/copilotkit']);
    });
});
