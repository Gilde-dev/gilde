import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLStore } from '@mastra/libsql';
import { RequestContext } from '@mastra/core/request-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COPILOT_PROJECT_KEY } from '../copilot/copilot.context.js';
import { copilotInstructions, COPILOT_INSTRUCTIONS } from '../copilot/copilot.instructions.js';
import { COPILOT_AGENT_ID, createMastra } from '../copilot/copilot.mastra.js';
import { refineConfig } from '../copilot/verfijner.config.js';
import { VERFIJNER_INSTRUCTIONS } from '../copilot/verfijner.instructions.js';
import { scoutConfig } from '../copilot/verkenner.config.js';
import { VERKENNER_INSTRUCTIONS } from '../copilot/verkenner.instructions.js';
import { planConfig } from '../copilot/werkmeester.config.js';
import { WERKMEESTER_INSTRUCTIONS } from '../copilot/werkmeester.instructions.js';
import { AgentInstructionsService } from '../execution/agent-instructions.service.js';
import { describePromptAssembly, PROMPT_LIMIT } from '../execution/job-prompt.js';
import { settleTestMemory, testMemoryInfrastructure } from '../memory/memory.testing.js';

import { AgentPromptService, COMMIT_ENV_VARS } from './agent-prompt.service.js';

const BOT = { id: '0b0b0b0b-1c5d-4e7a-9b60-0d1e2f3a4b5c', name: 'Bot', email: 'bot@example.com' };
const ENV = { OPENAI_API_KEY: 'k', COPILOT_MODEL: 'openai/m', SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: BOT.email, REFINE_ENABLED: 'true', REFINE_USER_EMAIL: BOT.email, PLAN_ENABLED: 'true', PLAN_USER_EMAIL: BOT.email };

const saved = { ...process.env };
const clearCommit = () => { for (const n of COMMIT_ENV_VARS) delete process.env[n]; delete process.env.GILDE_SOURCE_REPO; delete process.env.AGENT_INSTRUCTIONS_PATH; };

function service(reference = '') {
    const settings = { get: vi.fn().mockResolvedValue({ settings: { maxSteps: 30 } }) };
    const repoContext = { build: vi.fn().mockResolvedValue(reference) };
    const projects = { list: vi.fn().mockResolvedValue([{ id: 'project-1' }]) };
    return { svc: new AgentPromptService(settings as never, projects as never, new AgentInstructionsService(), repoContext as never), repoContext, projects };
}

describe('AgentPromptService', () => {
    beforeEach(clearCommit);
    afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

    it('renders every agent with the text the real agents are built with', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'prompt-'));
        try {
            const scout = scoutConfig(ENV); const refine = refineConfig(ENV); const plan = planConfig(ENV);
            if (!scout.enabled || !refine.enabled || !plan.enabled) throw new Error('test setup');
            const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'm.db')}` });
            const mastra = createMastra(
                { enabled: true, model: 'openai/m' }, {} as never, new LibSQLStore({ id: 't', url: 'file::memory:' }), { build: async () => 'REFERENCE' } as never, infra, undefined,
                { config: scout, user: BOT }, { config: refine, user: BOT }, { config: plan, user: BOT },
            );
            const { svc } = service('REFERENCE');
            const received = async (id: string, requestContext?: RequestContext) => String(await mastra.getAgent(id as never).getInstructions({ requestContext } as never));
            const shown = async (id: string) => (await svc.get(id)).instructions?.text;

            expect(await shown('gilde')).toBe(await received(COPILOT_AGENT_ID, new RequestContext([[COPILOT_PROJECT_KEY, 'project-1']])));
            expect(await shown('verkenner')).toBe(await received('verkenner'));
            expect(await shown('verfijner')).toBe(await received('verfijner'));
            expect(await shown('werkmeester')).toBe(await received('werkmeester'));
            expect(await shown('verkenner')).toBe(VERKENNER_INSTRUCTIONS);
            expect(await shown('verfijner')).toBe(VERFIJNER_INSTRUCTIONS);
            expect(await shown('werkmeester')).toBe(WERKMEESTER_INSTRUCTIONS);
        } finally {
            await settleTestMemory();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('appends the repo reference of the example project to the co-pilot instructions, labelled', async () => {
        const { svc, repoContext } = service('## Repo reference material\nX');
        const prompt = await svc.get('gilde');
        expect(prompt.instructions?.text).toBe(copilotInstructions('## Repo reference material\nX'));
        expect(prompt.instructions?.text.startsWith(COPILOT_INSTRUCTIONS)).toBe(true);
        expect(prompt.exampleBinding).toMatch(/first project/);
        expect(repoContext.build).toHaveBeenCalledWith('project-1');
        await svc.get('gilde', 'p-2');
        expect(repoContext.build).toHaveBeenLastCalledWith('p-2');
        expect((await service('').svc.get('gilde')).instructions?.text).toBe(COPILOT_INSTRUCTIONS);
    });

    it('has a stable version hash that follows the text', async () => {
        const { svc } = service();
        const a = (await svc.get('verfijner')).instructions!;
        const b = (await svc.get('verfijner')).instructions!;
        expect(a.version).toMatch(/^[0-9a-f]{12}$/);
        expect(a.version).toBe(b.version);
        expect(a.length).toBe(a.text.length);
        expect((await svc.get('werkmeester')).instructions!.version).not.toBe(a.version);
    });

    it('fills the run prompt of Verfijner and Werkmeester with a labelled example binding', async () => {
        const { svc } = service();
        const refine = await svc.get('verfijner');
        expect(refine.exampleBinding).toMatch(/Example binding/);
        expect(refine.runPrompt?.text).toContain('Refine GitHub issue #123 of example-org/example-repo');
        const plan = await svc.get('werkmeester');
        expect(plan.exampleBinding).toMatch(/Example binding/);
        expect(plan.runPrompt?.text).toContain('Plan version 1 of the approved spec "Example spec"');
        expect(plan.settings).toEqual({ maxSteps: 30 });
    });

    it('links the source file at the commit of the build, or at main when it is unknown', async () => {
        const { svc } = service();
        const unknown = (await svc.get('gilde')).file!;
        expect(unknown).toMatchObject({ path: 'apps/api/src/copilot/copilot.instructions.ts', ref: 'main', refKind: 'branch', url: 'https://github.com/Gilde-dev/gilde/blob/main/apps/api/src/copilot/copilot.instructions.ts' });
        expect(unknown.refSource).toContain('GILDE_COMMIT_SHA');

        process.env.GILDE_COMMIT_SHA = 'ABCDEF1234567890abcdef1234567890abcdef12';
        const known = (await svc.get('verkenner')).file!;
        expect(known).toMatchObject({ ref: 'ABCDEF1234567890abcdef1234567890abcdef12', refKind: 'commit', url: 'https://github.com/Gilde-dev/gilde/blob/ABCDEF1234567890abcdef1234567890abcdef12/apps/api/src/copilot/verkenner.instructions.ts' });
        expect(known.refSource).toContain('GILDE_COMMIT_SHA');

        process.env.GILDE_COMMIT_SHA = 'not a sha; ../..';
        expect((await svc.get('verkenner')).file!.refKind).toBe('branch');
    });

    it('shows the coding agents\' instructions file as loaded, and how the payload is assembled', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'prompt-'));
        try {
            const path = join(dir, 'docs', 'agent-instructions.md');
            process.env.AGENT_INSTRUCTIONS_PATH = path;
            const { svc } = service();
            expect((await svc.get('coding')).coding?.loadError).toMatch(/missing or unreadable/);

            const { mkdirSync } = await import('node:fs');
            mkdirSync(join(dir, 'docs'));
            writeFileSync(path, '# Instructions\nDo the job.\n');
            const prompt = await svc.get('coding');
            expect(prompt.instructions).toMatchObject({ text: '# Instructions\nDo the job.\n', length: 27 });
            expect(prompt.instructions?.version).toBe(new AgentInstructionsService().get().version);
            expect(prompt.file).toMatchObject({ path: 'docs/agent-instructions.md' });
            expect(prompt.coding).toMatchObject({ instructionsPath: path, loadError: null, limit: PROMPT_LIMIT, ...describePromptAssembly() });
            expect(prompt.coding?.payloadKeys).toEqual(expect.arrayContaining(['jobId', 'task', 'acceptanceCriteria', 'feature', 'downstream', 'lessons']));
            expect(prompt.coding?.trimmingOrder[0]).toMatch(/Knowledge snippets/);
            expect(prompt.coding?.trimmingOrder.at(-1)).toMatch(/Never shortened/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('has no prompt for the MCP server and the Slack bot, and rejects unknown agents', async () => {
        const { svc } = service();
        for (const id of ['mcp', 'slack']) {
            expect(await svc.get(id)).toMatchObject({ kind: 'none', instructions: null, runPrompt: null, file: null });
        }
        await expect(svc.get('nobody')).rejects.toThrow(/Unknown agent/);
    });
});
