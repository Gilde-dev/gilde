import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@nestjs/common';
import { LibSQLStore } from '@mastra/libsql';

import { settleTestMemory, testMemoryInfrastructure } from '../memory/memory.testing.js';

import { COPILOT_AGENT_ID, createMastra, withoutScout, type ScoutSetup } from './copilot.mastra.js';
import { COPILOTKIT_PATH } from './copilot.mastra.js';
import { SCOUT_AGENT_ID, scoutConfig } from './verkenner.config.js';
import { SCOUT_TOOL_NAMES } from './verkenner.tools.js';
import { ScoutThreads } from './verkenner.threads.js';
import { VERKENNER_INSTRUCTIONS } from './verkenner.instructions.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const P2 = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const BOT = { id: 'bot-user', name: 'Verkenner', email: 'verkenner@example.com' };

const env = { SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: BOT.email, SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'k' };
const scoutOn = (extra: Partial<ScoutSetup> = {}): ScoutSetup => {
    const config = scoutConfig(env);
    if (!config.enabled) throw new Error('test setup');
    return { config, user: BOT, ...extra };
};
const copilotOn = { enabled: true as const, model: 'openai/test-model' };
const copilotOff = { enabled: false as const, model: null, reason: 'x' };

interface Part { type: string; text?: string }
interface Message { role: string; content: string | Part[] }

/** Deterministic model: on its first call it calls `listRepos`, then it answers with text. Records the prompts. */
function stubModel(options: { toolName?: string } = {}) {
    const prompts: Message[][] = [];
    const model = {
        specificationVersion: 'v2' as const, provider: 'stub', modelId: 'stub', supportedUrls: {},
        doGenerate: async () => { throw new Error('stub model only streams'); },
        doStream: async (call: { prompt: Message[] }) => {
            prompts.push(call.prompt);
            const hasResult = call.prompt.some((m) => m.role === 'tool');
            return {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] });
                        if (options.toolName && !hasResult) {
                            controller.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: options.toolName, input: '{}' });
                            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
                        } else {
                            controller.enqueue({ type: 'text-start', id: 't' });
                            controller.enqueue({ type: 'text-delta', id: 't', delta: 'nothing worth suggesting' });
                            controller.enqueue({ type: 'text-end', id: 't' });
                            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
                        }
                        controller.close();
                    },
                }),
            };
        },
    };
    return { model, prompts };
}

const until = async (check: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 25));
    }
};

describe('createMastra with the scout', () => {
    it('registers verkenner next to gilde in the same instance, on the same storage', async () => {
        const infra = testMemoryInfrastructure({ url: `file:${join(mkdtempSync(join(tmpdir(), 'verkenner-shared-')), 's.db')}` });
        const mastra = createMastra(copilotOn, {} as never, undefined, undefined, infra, undefined, scoutOn());
        expect(Object.keys(mastra.listAgents()).sort()).toEqual([COPILOT_AGENT_ID, SCOUT_AGENT_ID].sort());
        expect(mastra.getStorage()).toBeDefined();
        const gilde = mastra.getAgent(COPILOT_AGENT_ID);
        const verkenner = mastra.getAgent(SCOUT_AGENT_ID);
        // One store: a thread written through the co-pilot's memory is visible through the scout's.
        await (await gilde.getMemory())!.createThread({ threadId: 'shared-store-probe', resourceId: 'probe' });
        expect(await (await verkenner.getMemory())!.getThreadById({ threadId: 'shared-store-probe' })).toMatchObject({ resourceId: 'probe' });
        expect(verkenner.id).toBe('verkenner');
        expect(verkenner.name).toBe('verkenner');
    });

    it('leaves the human co-pilot as it was: same tools, same single CopilotKit route', async () => {
        const mastra = createMastra(copilotOn, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }), undefined, undefined, undefined, scoutOn());
        const tools = Object.keys(await mastra.getAgent(COPILOT_AGENT_ID).listTools());
        expect(tools).toHaveLength(24);
        expect(tools).toEqual(expect.arrayContaining(['createJob', 'createPlannedFeature']));
        expect(tools).not.toContain('suggestJob');
        expect(mastra.getServer()?.apiRoutes?.map((r) => r.path)).toEqual([COPILOTKIT_PATH]);
    });

    it('gives the scout the native inbox and only the allowlist, with the scout instructions', async () => {
        const mastra = createMastra(copilotOn, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }), undefined, undefined, undefined, scoutOn());
        const scout = mastra.getAgent(SCOUT_AGENT_ID);
        expect(Object.keys(await scout.listTools()).sort()).toEqual([...SCOUT_TOOL_NAMES].sort());
        expect(await scout.getInstructions()).toBe(VERKENNER_INSTRUCTIONS);
        expect((await scout.getDefaultOptions()).maxSteps).toBe(30);
    });

    it('runs the scout alone when the human co-pilot is off, without the CopilotKit route', async () => {
        const mastra = createMastra(copilotOff, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }), undefined, undefined, undefined, scoutOn());
        expect(Object.keys(mastra.listAgents())).toEqual([SCOUT_AGENT_ID]);
        expect(mastra.getServer()?.apiRoutes ?? []).toEqual([]);
    });

    it('has no scout when it is off, with or without the co-pilot', () => {
        const withCopilot = createMastra(copilotOn, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }), undefined, undefined, undefined, null);
        expect(Object.keys(withCopilot.listAgents())).toEqual([COPILOT_AGENT_ID]);
        expect(Object.keys(createMastra(copilotOff, {} as never, undefined, undefined, undefined, undefined, null).listAgents())).toEqual([]);
    });

    it('hides the scout from the CopilotKit route, while it stays registered', () => {
        const mastra = createMastra(copilotOn, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }), undefined, undefined, undefined, scoutOn());
        expect(Object.keys(withoutScout(mastra).listAgents())).toEqual([COPILOT_AGENT_ID]);
        expect(Object.keys(mastra.listAgents())).toContain(SCOUT_AGENT_ID);
        expect(withoutScout(mastra).getAgent(SCOUT_AGENT_ID)).toBeDefined();
    });
});

describe('scout threads and runs', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verkenner-mastra-')); });
    afterEach(async () => {
        await settleTestMemory();
        rmSync(dir, { recursive: true, force: true });
    });

    function build(toolName?: string, services: Record<string, unknown> = {}) {
        const stub = stubModel({ toolName });
        const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
        const mastra = createMastra(copilotOff, services as never, undefined, undefined, infra, undefined, scoutOn({ model: stub.model }));
        const projects = { getById: vi.fn(async (id: string) => { if (id === 'missing') throw new NotFoundException(); return { id }; }) };
        return { mastra, stub, threads: new ScoutThreads(mastra, BOT, projects), projects };
    }

    it('creates one thread per project under the bot user, idempotently', async () => {
        const { mastra, threads } = build();
        expect(await threads.ensureThread(P1)).toEqual({ resourceId: BOT.id, threadId: `verkenner:${P1}` });
        await threads.ensureThread(P1);
        await Promise.all([threads.ensureThread(P2), threads.ensureThread(P2)]);

        const memory = (await mastra.getAgent(SCOUT_AGENT_ID).getMemory())!;
        const t1 = await memory.getThreadById({ threadId: `verkenner:${P1}` });
        const t2 = await memory.getThreadById({ threadId: `verkenner:${P2}` });
        expect(t1).toMatchObject({ resourceId: BOT.id, metadata: { projectId: P1 } });
        expect(t2).toMatchObject({ resourceId: BOT.id, metadata: { projectId: P2 } });
        expect(t1!.id).not.toBe(t2!.id);
        const all = await memory.listThreads({ filter: { resourceId: BOT.id } });
        expect(all.threads.map((t) => t.id).sort()).toEqual([`verkenner:${P1}`, `verkenner:${P2}`].sort());
    });

    it('refuses an unknown project and a thread owned by someone else', async () => {
        const { mastra, threads } = build();
        await expect(threads.ensureThread('missing')).rejects.toThrow(NotFoundException);

        const memory = (await mastra.getAgent(SCOUT_AGENT_ID).getMemory())!;
        await memory.createThread({ threadId: `verkenner:${P1}`, resourceId: 'someone-else' });
        await expect(threads.ensureThread(P1)).rejects.toThrow(/another resource/);
    });

    it('wakes on a high notification with the server-bound project context: tools see the thread\'s project', async () => {
        const listForProject = vi.fn().mockResolvedValue([{ id: 'repo-1' }]);
        const { mastra, stub, threads } = build('listRepos', { repos: { listForProject } });
        const target = await threads.ensureThread(P1);

        const result = await mastra.getAgent(SCOUT_AGENT_ID).sendNotificationSignal(
            { source: 'gilde', kind: 'run-blocked', priority: 'high', summary: 'Run r1 of job j1 is blocked', dedupeKey: 'run-blocked:r1' },
            target,
        );
        expect(result.decision.action).toBe('deliver');
        await until(() => listForProject.mock.calls.length > 0 && stub.prompts.length >= 2);
        expect(listForProject).toHaveBeenCalledWith(P1);
        expect(listForProject).not.toHaveBeenCalledWith(P2);
    });

    it('a wake without the server context (the project cannot be taken from the thread) gets no tool access', async () => {
        const listForProject = vi.fn().mockResolvedValue([]);
        const { mastra, stub } = build('listRepos', { repos: { listForProject } });
        // A thread that is not a project thread: the delivery policy cannot bind a project.
        await mastra.getAgent(SCOUT_AGENT_ID).sendNotificationSignal(
            { source: 'gilde', kind: 'run-blocked', priority: 'high', summary: 'x', dedupeKey: 'k' },
            { resourceId: BOT.id, threadId: 'free-form-thread' },
        );
        await until(() => stub.prompts.length >= 2);
        expect(listForProject).not.toHaveBeenCalled();
    });
});
