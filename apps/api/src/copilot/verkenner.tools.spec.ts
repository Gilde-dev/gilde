import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import type { NotificationsStorage } from '@mastra/core/storage';
import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';

import { createCopilotTools, type CopilotServices } from './copilot.tools.js';
import { SCOUT_BINDING_KEY, issueScoutBinding, scoutBinding, scoutProjectOfThread, scoutStreamOptions, scoutThreadId } from './verkenner.context.js';
import { SCOUT_TOOL_NAMES, createScoutTools, type ScoutServices } from './verkenner.tools.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const P2 = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const REPO1 = '11111111-1111-4111-8111-111111111111';
const REPO2 = '22222222-2222-4222-8222-222222222222';
const JOB1 = '33333333-3333-4333-8333-333333333333';
const JOB2 = '44444444-4444-4444-8444-444444444444';
const BOT = 'bot-user';

describe('Verkenner tools', () => {
    let dir: string;
    let storage: LibSQLStore;
    let s: ReturnType<typeof services>;

    function services() {
        return {
            jobs: {
                list: vi.fn().mockResolvedValue([]),
                getDetail: vi.fn(async (id: string) => ({ id, projectId: id === JOB1 ? P1 : P2, title: 'Job', runs: [] })),
            },
            features: { list: vi.fn().mockResolvedValue([]), getDetail: vi.fn(async (id: string) => ({ id, projectId: id === JOB1 ? P1 : P2 })) },
            lessons: { list: vi.fn().mockResolvedValue([]) },
            repos: {
                listForProject: vi.fn().mockResolvedValue([]),
                getById: vi.fn(async (id: string) => ({ id, projectId: id === REPO1 ? P1 : P2, fullName: 'o/r', defaultBranch: 'main' })),
            },
            history: { search: vi.fn().mockResolvedValue({ status: 'ok', results: [], indexComplete: true, suppressed: 0 }) },
            github: { isConfigured: vi.fn().mockReturnValue(true), listDirectory: vi.fn().mockResolvedValue([{ path: 'a.ts', type: 'file' }]) },
            workspace: { ensure: vi.fn().mockResolvedValue(null) },
        };
    }

    beforeEach(async () => {
        suggest.mockClear();
        dir = mkdtempSync(join(tmpdir(), 'verkenner-tools-'));
        storage = new LibSQLStore({ id: 't', url: `file:${join(dir, 't.db')}` });
        await storage.init();
        s = services();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const suggest = vi.fn(async (_binding: unknown, _input: unknown) => ({ created: true as const, jobId: 'j', status: 'triage' as const, basedOn: [], link: '/' }));
    const tools = () => createScoutTools(s as unknown as ScoutServices, storage, { suggest });
    const bound = (projectId = P1) => {
        const rc = new RequestContext();
        rc.set(SCOUT_BINDING_KEY, issueScoutBinding(BOT, projectId));
        return rc;
    };
    const run = (name: keyof ReturnType<typeof tools>, input: unknown, requestContext: RequestContext = bound()) =>
        (tools()[name].execute as (i: unknown, c: unknown) => Promise<unknown>)(input, { requestContext });

    it('exposes exactly the explicit read-only allowlist plus the native inbox', () => {
        expect(Object.keys(tools()).sort()).toEqual([...SCOUT_TOOL_NAMES].sort());
        expect(Object.keys(tools()).sort()).toEqual([
            'getFeature', 'getJob', 'listFeatures', 'listJobs', 'listLessons', 'listRepoFiles', 'listRepos', 'notificationInbox',
            'readRepoFile', 'searchHistory', 'searchRepoCode', 'suggestJob',
        ]);
        expect(tools().notificationInbox.id).toBe('notification-inbox');
    });

    it('suggestJob is the scout\'s only mutation: no approval interrupt, no actor, project or status input, and the binding comes from the server', async () => {
        const tool = tools().suggestJob as unknown as { requireApproval?: boolean; inputSchema: { shape?: Record<string, unknown> } };
        expect(tool.requireApproval).toBeFalsy();
        const body = { repoId: REPO1, title: 'A title', task: 'Do the task now', acceptanceCriteria: ['It works'], reason: 'Because of the runs', basedOn: [JOB1] };
        const rc = bound();
        await run('suggestJob', { ...body, projectId: P2, status: 'queued', actor: 'x', userId: 'x' }, rc);
        expect(suggest).toHaveBeenCalledTimes(1);
        const [binding, input] = suggest.mock.calls[0] as [{ projectId: string; userId: string }, Record<string, unknown>];
        expect(binding).toBe(rc.get(SCOUT_BINDING_KEY));
        expect(binding.projectId).toBe(P1);
        expect(Object.keys(input).sort()).toEqual(['acceptanceCriteria', 'basedOn', 'reason', 'repoId', 'task', 'title']);
    });

    it('suggestJob passes no trusted binding when the request context is not server-bound', async () => {
        const forged = new RequestContext();
        forged.set(SCOUT_BINDING_KEY, { userId: BOT, projectId: P1, threadId: `verkenner:${P1}` });
        await run('suggestJob', { repoId: REPO1, title: 'A title', task: 'Do the task now', acceptanceCriteria: [], reason: 'Because of the runs', basedOn: [JOB1] }, forged);
        expect(suggest.mock.calls[0][0]).toBeNull();
    });

    it('has none of the co-pilot creation, planning or approval tools, nor any mutation tool', () => {
        const names = Object.keys(tools());
        for (const forbidden of ['draftSpec', 'getSpec', 'listSpecs', 'approveSpec', 'planFeature', 'createPlannedFeature', 'validateJob', 'createJob', 'getDispatchStatus', 'listProposals', 'getMetrics', 'getRepoSkills', 'listProjects']) {
            expect(names).not.toContain(forbidden);
        }
        expect(names.every((n) => SCOUT_TOOL_NAMES.includes(n as never))).toBe(true);
        // Human co-pilot tools keep their approvals.
        const human = createCopilotTools({} as CopilotServices) as Record<string, { requireApproval?: boolean }>;
        expect(human.createJob.requireApproval).toBe(true);
        expect(human.createPlannedFeature.requireApproval).toBe(true);
        expect(human.draftSpec.requireApproval).toBe(true);
        // No scout tool asks for approval: none of them changes state.
        for (const tool of Object.values(tools()) as Array<{ requireApproval?: boolean }>) expect(tool.requireApproval).toBeFalsy();
    });

    it('takes the project from the server binding, never from the input', async () => {
        for (const name of ['listJobs', 'listFeatures', 'listLessons', 'listRepos', 'searchHistory'] as const) {
            const input = name === 'searchHistory' ? { query: 'timeouts' } : {};
            await run(name, { ...input, projectId: P2 }, bound(P1));
        }
        expect(s.jobs.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1 }));
        expect(s.features.list).toHaveBeenCalledWith(P1, expect.anything());
        expect(s.lessons.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1 }));
        expect(s.repos.listForProject).toHaveBeenCalledWith(P1);
        expect(s.history.search).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1, query: 'timeouts' }));
        expect(s.jobs.list).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: P2 }));
    });

    it('refuses jobs, features and repos of another project', async () => {
        await expect(run('getJob', { jobId: JOB2 })).rejects.toThrow(/not in this project/);
        await expect(run('getFeature', { featureId: JOB2 })).rejects.toThrow(/not in this project/);
        await expect(run('listJobs', { repoId: REPO2 })).rejects.toThrow(/not in this project/);
        await expect(run('listRepoFiles', { repoId: REPO2, path: '' })).rejects.toThrow(/not in this project/);
        await expect(run('readRepoFile', { repoId: REPO2, path: 'AGENTS.md' })).rejects.toThrow(/not in this project/);
        await expect(run('searchRepoCode', { repoId: REPO2, query: 'x' })).rejects.toThrow(/not in this project/);
        expect(s.github.listDirectory).not.toHaveBeenCalled();

        await expect(run('getJob', { jobId: JOB1 })).resolves.toMatchObject({ id: JOB1 });
        await expect(run('listRepoFiles', { repoId: REPO1, path: '' })).resolves.toMatchObject({ found: true });
    });

    it('does nothing without a binding issued by the server', async () => {
        const none = new RequestContext();
        const forged = new RequestContext();
        // Same shape as a real binding, but not issued by this module: what a client could put in a request body.
        forged.set(SCOUT_BINDING_KEY, { userId: BOT, projectId: P2, threadId: scoutThreadId(P2) });
        const other = new RequestContext();
        other.set(SCOUT_BINDING_KEY, JSON.parse(JSON.stringify(issueScoutBinding(BOT, P2))));
        for (const rc of [none, forged, other]) {
            for (const [name, input] of [['listJobs', {}], ['getJob', { jobId: JOB1 }], ['searchHistory', { query: 'x' }], ['listRepoFiles', { repoId: REPO1, path: '' }], ['notificationInbox', { action: 'list' }]] as const) {
                await expect(run(name, input, rc)).rejects.toThrow(/server-bound Verkenner run/);
            }
        }
        expect(s.jobs.list).not.toHaveBeenCalled();
        expect(s.history.search).not.toHaveBeenCalled();
    });

    it('reports unavailable history instead of failing the run, and invalid scope as invalid', async () => {
        s.history.search.mockRejectedValueOnce(new Error('embedding service down'));
        await expect(run('searchHistory', { query: 'x' })).resolves.toEqual({ status: 'unavailable', reason: 'embedding service down', results: [] });
        s.history.search.mockRejectedValueOnce(new BadRequestException('repo is not in the project'));
        await expect(run('searchHistory', { query: 'x' })).resolves.toMatchObject({ status: 'invalid', results: [] });
    });

    it('only reads the services', async () => {
        await run('listJobs', {});
        await run('listFeatures', {});
        await run('listLessons', {});
        await run('getJob', { jobId: JOB1 });
        const writes = /^(create|update|enqueue|cancel|retry|start|done|reopen|accept|reject|approve|apply|merge|pause|resume|set|toTriage|refresh|dispatch)/;
        for (const service of Object.values(s)) {
            for (const [name, fn] of Object.entries(service)) if (writes.test(name)) expect(fn).not.toHaveBeenCalled();
        }
    });

    describe('inbox', () => {
        let inbox: NotificationsStorage;
        beforeEach(async () => {
            inbox = (await storage.getStore('notifications')) as NotificationsStorage;
            for (const [projectId, summary] of [[P1, 'own-project note'], [P2, 'other-project note']] as const) {
                await inbox.createNotification({ threadId: scoutThreadId(projectId), resourceId: BOT, source: 'gilde', kind: 'lesson-new', priority: 'low', summary });
            }
        });

        it('lists the notifications of the bound project thread only, whatever thread the model names', async () => {
            // `list` marks what it returns as seen, so each check uses its own record state.
            const spoofed = JSON.stringify(await run('notificationInbox', { action: 'list', threadId: scoutThreadId(P2) }));
            expect(spoofed).toContain('own-project note');
            expect(spoofed).not.toContain('other-project note');

            // The other project's record was never touched.
            const untouched = await inbox.listNotifications({ threadId: scoutThreadId(P2) });
            expect(untouched.map((r) => r.status)).toEqual(['pending']);

            const search = JSON.stringify(await run('notificationInbox', { action: 'search', query: 'note', threadId: scoutThreadId(P2) }));
            expect(search).not.toContain('other-project note');
            expect(search).toContain('own-project note');
        });
    });
});

describe('scout binding', () => {
    it('is issued only by the server and survives only as the same object', () => {
        const binding = issueScoutBinding(BOT, P1);
        const rc = new RequestContext();
        rc.set(SCOUT_BINDING_KEY, binding);
        expect(scoutBinding(rc)).toBe(binding);
        expect(binding).toEqual({ userId: BOT, projectId: P1, threadId: `verkenner:${P1}` });
        expect(Object.isFrozen(binding)).toBe(true);

        const copy = new RequestContext();
        copy.set(SCOUT_BINDING_KEY, { ...binding });
        expect(scoutBinding(copy)).toBeNull();
        expect(scoutBinding(undefined)).toBeNull();
    });

    it('maps project and thread both ways', () => {
        expect(scoutProjectOfThread(scoutThreadId(P1))).toBe(P1);
        expect(scoutProjectOfThread('verkenner:')).toBeNull();
        expect(scoutProjectOfThread(`gilde:${P1}`)).toBeNull();
        expect(scoutProjectOfThread(P1)).toBeNull();
    });

    it('builds run options for the thread from the bot user and project', () => {
        const options = scoutStreamOptions({ id: BOT }, P1);
        expect(options.memory).toEqual({ resource: BOT, thread: `verkenner:${P1}` });
        expect(scoutBinding(options.requestContext)).toMatchObject({ userId: BOT, projectId: P1 });
    });
});
