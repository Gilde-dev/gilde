import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestContext } from '@mastra/core/request-context';

import { COPILOT_AGENT_ID, createMastra, type ScoutSetup } from '../copilot/copilot.mastra.js';
import { COPILOT_PROJECT_KEY, COPILOT_USER_KEY } from '../copilot/copilot.context.js';
import { scoutConfig } from '../copilot/verkenner.config.js';
import { scoutStreamOptions } from '../copilot/verkenner.context.js';
import { ScoutThreads } from '../copilot/verkenner.threads.js';
import { settleTestMemory, testMemoryInfrastructure } from '../memory/memory.testing.js';

import { runLogDb } from './agent-run.testing.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const BOT = { id: '0b0b0b0b-1c5d-4e7a-9b60-0d1e2f3a4b5c', name: 'Verkenner', email: 'verkenner@example.com' };
const HUMAN = { id: '9a9a9a9a-1c5d-4e7a-9b60-0d1e2f3a4b5c', name: 'Ann', email: 'ann@example.com' };

interface Message { role: string }

/** Calls `toolName` once, then answers with text. */
function stubModel(toolName: string) {
    let calls = 0;
    return {
        specificationVersion: 'v2' as const, provider: 'stub', modelId: 'stub', supportedUrls: {},
        doGenerate: async () => { throw new Error('stub model only streams'); },
        doStream: async (call: { prompt: Message[] }) => {
            calls++;
            const hasResult = call.prompt.some((m) => m.role === 'tool');
            return {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] });
                        if (!hasResult) {
                            controller.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName, input: '{}' });
                            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } });
                        } else {
                            controller.enqueue({ type: 'text-start', id: 't' });
                            controller.enqueue({ type: 'text-delta', id: 't', delta: 'done' });
                            controller.enqueue({ type: 'text-end', id: 't' });
                            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 60, outputTokens: 3, totalTokens: 63 } });
                        }
                        controller.close();
                    },
                }),
            };
        },
        get calls() { return calls; },
    };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > ms) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 25));
    }
};

describe('runs of real Mastra agents are recorded with their tool calls', () => {
    let dir: string;
    let db: Awaited<ReturnType<typeof runLogDb>>;
    beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'agent-run-')); db = await runLogDb(); });
    afterEach(async () => { await settleTestMemory(); await db.ds.destroy(); rmSync(dir, { recursive: true, force: true }); });

    const scout = (model: unknown): ScoutSetup => {
        const config = scoutConfig({ SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: BOT.email, SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'k' });
        if (!config.enabled) throw new Error('test setup');
        return { config, user: BOT, model };
    };

    it('records a scout wake as a signal run of the project, with its tool call', async () => {
        const listForProject = vi.fn().mockResolvedValue([{ id: 'repo-1' }]);
        const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
        const mastra = createMastra({ enabled: false, model: null, reason: 'x' }, { repos: { listForProject } } as never, undefined, undefined, infra, undefined, scout(stubModel('listRepos')), null, null, db.recorder);
        const threads = new ScoutThreads(mastra, BOT, { getById: async (id: string) => ({ id }) } as never);
        const target = await threads.ensureThread(P1);

        await mastra.getAgent('verkenner').sendNotificationSignal({ source: 'gilde', kind: 'run-blocked', priority: 'high', summary: 'Run r1 is blocked', dedupeKey: 'run-blocked:r1' }, target);
        await until(async () => { await db.recorder.flush(); return (await db.runs.findOneBy({ agentId: 'verkenner' }))?.outcome === 'ok'; });

        const run = await db.runs.findOneByOrFail({ agentId: 'verkenner' });
        expect(run).toMatchObject({ triggerKind: 'signal', actorUserId: BOT.id, projectId: P1, triggerRefType: 'project', triggerRefId: P1, model: 'openai/scout-model' });
        expect(run.inputTokens).toBe(100);
        const [call] = await db.toolCalls.find({ where: { runId: run.id } });
        expect(call).toMatchObject({ toolName: 'listRepos', error: null });
        expect(call.input).toBe('{}'); // the project is bound by the server; the model's extra fields are not part of the call
        expect(call.output).toContain('repo-1');
        expect(await db.runs.count()).toBe(1);
    });

    it('records a co-pilot request as a chat run of the user in the selected project', async () => {
        const list = vi.fn().mockResolvedValue([{ id: 'project-2' }]);
        const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'c.db')}` });
        const mastra = createMastra({ enabled: true, model: 'openai/test-model' }, { projects: { list } } as never, undefined, undefined, infra, undefined, null, null, null, db.recorder);
        const agent = mastra.getAgent(COPILOT_AGENT_ID);
        (agent as unknown as { model: unknown }).model = stubModel('listProjects');
        const requestContext = new RequestContext();
        requestContext.set(COPILOT_USER_KEY, HUMAN);
        requestContext.set(COPILOT_PROJECT_KEY, P1);

        const output = await agent.stream('which repos?', { requestContext, memory: { resource: HUMAN.id, thread: 'thread-1' } } as never);
        await (output as unknown as { consumeStream(): Promise<void> }).consumeStream();
        await until(async () => { await db.recorder.flush(); return (await db.runs.findOneBy({ agentId: 'gilde' }))?.outcome === 'ok'; });

        const run = await db.runs.findOneByOrFail({ agentId: 'gilde' });
        expect(run).toMatchObject({ triggerKind: 'chat', actorUserId: HUMAN.id, projectId: P1 });
        expect((await db.toolCalls.find({ where: { runId: run.id } })).map((c) => c.toolName)).toEqual(['listProjects']);
    });

    it('records nothing and breaks nothing when the recorder is not wired', async () => {
        const listForProject = vi.fn().mockResolvedValue([]);
        const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'n.db')}` });
        const mastra = createMastra({ enabled: false, model: null, reason: 'x' }, { repos: { listForProject } } as never, undefined, undefined, infra, undefined, scout(stubModel('listRepos')));
        const options = scoutStreamOptions(BOT, P1);
        const output = await mastra.getAgent('verkenner').stream('hi', options as never);
        await (output as unknown as { consumeStream(): Promise<void> }).consumeStream();
        expect(listForProject).toHaveBeenCalledWith(P1);
        expect(await db.runs.count()).toBe(0);
    });
});
