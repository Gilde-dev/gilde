import { ConflictException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { AuthUser } from '../auth/auth.dto.js';
import { UserService } from '../user/user.service.js';
import type { UserIdentityDto } from '../user/user.dto.js';
import { McpQuotaExceededError } from './mcp.errors.js';
import { McpService } from './mcp.service.js';
import { MCP_BOUNDARY, MCP_TOOL_NAMES } from './mcp.tools.js';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REPO = '33333333-3333-4333-8333-333333333333';
const SPEC = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';

const identity = (id: string, over: Partial<UserIdentityDto> = {}): UserIdentityDto => ({ id, email: `${id}@example.com`, isBot: false, ...over });

interface Stubs {
    identities: Map<string, UserIdentityDto>;
    jobs: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    specs: { saveVersion: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; approve: ReturnType<typeof vi.fn> };
    plans: { create: ReturnType<typeof vi.fn> };
    quota: { withReservation: ReturnType<typeof vi.fn>; reserve: ReturnType<typeof vi.fn>; serialized: ReturnType<typeof vi.fn> };
}

function setup() {
    const identities = new Map<string, UserIdentityDto>([[ME, identity(ME)], [OTHER, identity(OTHER)]]);
    const users = new UserService({ findOneBy: async ({ id }: { id: string }) => identities.get(id) ?? null } as never, { toIdentityDTO: (u: UserIdentityDto) => u } as never);
    const jobs = {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'job-1' }),
        getById: vi.fn(),
    };
    const specs = { saveVersion: vi.fn(), create: vi.fn(), approve: vi.fn(), list: vi.fn().mockResolvedValue([]) };
    const plans = { create: vi.fn(), validate: vi.fn() };
    const quota = {
        withReservation: vi.fn(async (_u: string, _c: unknown, work: (m: unknown) => unknown) => work({})),
        reserve: vi.fn(),
        serialized: vi.fn((fn: () => unknown) => fn()),
    };
    const projects = { list: vi.fn().mockResolvedValue([{ id: PROJECT }]) };
    const repos = { getById: vi.fn().mockResolvedValue({ id: REPO, projectId: PROJECT, fullName: 'o/r' }), listForProject: vi.fn() };
    const skills = { impact: vi.fn().mockResolvedValue({ days: 30, minRuns: 10, skills: [] }) };
    const noop = {} as never;
    const service = new McpService(users, quota as never, jobs as never, { getById: vi.fn() } as never, noop, noop, noop, noop, noop, skills as never, projects as never, repos as never, noop, specs as never, plans as never, noop, noop);
    const connect = async (user: AuthUser | undefined) => {
        const server = service.buildServer(user);
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        const client = new Client({ name: 'test', version: '1' });
        await client.connect(a);
        return client;
    };
    const as = (id: string, credential: AuthUser['credential'] = 'api_key'): AuthUser => ({ id, name: 'N', email: `${id}@example.com`, credential });
    return { service, identities, skills, jobs, specs, plans, quota, projects, repos, connect, as } satisfies Record<string, unknown> & { identities: Stubs['identities'] };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe('MCP tool registry', () => {
    it('exposes exactly the 23 allowlisted tools', async () => {
        const { connect, as } = setup();
        const client = await connect(as(ME));
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
        expect(tools).toHaveLength(24);
        expect(tools.map((t) => t.name)).toContain('getSkillImpact');
    });

    it('getSkillImpact is read-only, takes a project and a bounded window, and returns the summary', async () => {
        const { connect, as, skills } = setup();
        const client = await connect(as(ME));
        const tool = (await client.listTools()).tools.find((t) => t.name === 'getSkillImpact')!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
        expect(tool.description).toMatch(/not effects/);
        const ok = await client.callTool({ name: 'getSkillImpact', arguments: { projectId: PROJECT, days: 7 } });
        expect(isError(ok)).toBe(false);
        expect(JSON.parse(text(ok))).toEqual({ days: 30, minRuns: 10, skills: [] });
        expect(skills.impact).toHaveBeenCalledWith(PROJECT, 7);
        expect(isError(await client.callTool({ name: 'getSkillImpact', arguments: { projectId: PROJECT, days: 181 } }))).toBe(true);
    });

    it('never exposes queueing, dispatching, cancelling, retrying, merging, approval, settings, identity or notification tools', async () => {
        const { connect, as } = setup();
        const names = (await (await connect(as(ME))).listTools()).tools.map((t) => t.name);
        for (const forbidden of ['enqueueJob', 'queueJob', 'dispatch', 'runDispatch', 'cancelJob', 'retryJob', 'mergeJob', 'approveSpec', 'updateSettings', 'updateProject', 'createUser', 'createApiKey', 'listNotifications', 'readNotifications', 'updateWorkingMemory', 'suggestJob']) {
            expect(names).not.toContain(forbidden);
        }
        expect(names.filter((n) => /approve|queue|dispatch|cancel|retry|merge|notif|apikey|user|memory|setting/i.test(n) && n !== 'getDispatchStatus')).toEqual([]);
    });

    it('states the triage/draft-only boundary in every description and never claims a sidebar confirmation', async () => {
        const { connect, as } = setup();
        for (const t of (await (await connect(as(ME))).listTools()).tools) {
            expect(t.description, t.name).toContain(MCP_BOUNDARY);
            expect(t.description, t.name).not.toMatch(/asked to (approve|confirm)|in the UI first|if they cancel/i);
        }
    });

    it('annotates reads and validations as read-only and writes as non-destructive', async () => {
        const { connect, as } = setup();
        const tools = new Map((await (await connect(as(ME))).listTools()).tools.map((t) => [t.name, t]));
        const writes = new Set(['createJob', 'createPlannedFeature', 'draftSpec']);
        for (const [name, t] of tools) {
            if (writes.has(name)) expect(t.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
            else expect(t.annotations, name).toMatchObject({ readOnlyHint: true });
        }
        expect(tools.get('validateJob')?.annotations?.readOnlyHint).toBe(true);
        expect(tools.get('planFeature')?.annotations?.readOnlyHint).toBe(true);
    });

    it('has no tool whose schema takes an actor, creator, credential, bot flag or status', async () => {
        const { connect, as } = setup();
        for (const t of (await (await connect(as(ME))).listTools()).tools) {
            const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
            // listJobs' createdBy only accepts the literal "me" (resolved server-side); status is a read filter on list tools.
            const allowed = (p: string) => (p === 'createdBy' && t.name === 'listJobs') || (p === 'status' && ['listJobs', 'listFeatures', 'listLessons', 'listProposals'].includes(t.name));
            expect(props.filter((p) => /^(actor|creator|createdBy.*|credential|isBot|userId|status)$/.test(p) && !allowed(p)), t.name).toEqual([]);
        }
    });

    it('answers an unknown tool with an error and calls no service', async () => {
        const { connect, as, jobs, specs, plans, quota } = setup();
        const client = await connect(as(ME));
        const r = await client.callTool({ name: 'approveSpec', arguments: { specId: SPEC } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
        expect(isError(r)).toBe(true);
        expect(text(r)).toMatch(/not found|unknown/i);
        for (const m of [...Object.values(jobs), ...Object.values(specs), ...Object.values(plans), ...Object.values(quota)]) expect(m).not.toHaveBeenCalled();
    });
});

describe('MCP identity', () => {
    const readCall = (client: Client) => client.callTool({ name: 'listProjects', arguments: {} });

    it('serves a verified JWT and a personal API key', async () => {
        const { connect, as } = setup();
        expect(isError(await readCall(await connect(as(ME, 'jwt'))))).toBe(false);
        expect(isError(await readCall(await connect(as(ME, 'api_key'))))).toBe(false);
    });

    it.each([
        ['no authenticated user (auth disabled)', undefined],
        ['a user without provenance', { id: ME, name: 'N', email: 'x@example.com' } as AuthUser],
        ['a spoofed provenance', { id: ME, name: 'N', email: 'x@example.com', credential: 'admin' } as unknown as AuthUser],
    ])('fails closed for %s', async (_n, user) => {
        const { connect, jobs } = setup();
        const r = await (await connect(user)).callTool({ name: 'listJobs', arguments: {} });
        expect(isError(r)).toBe(true);
        expect(text(r)).toContain('Not allowed');
        expect(jobs.list).not.toHaveBeenCalled();
    });

    it('refuses a deleted user, a persisted bot and the scout account (normalized, even when not marked as a bot)', async () => {
        const { connect, as, identities, projects } = setup();
        identities.delete(OTHER);
        expect(isError(await readCall(await connect(as(OTHER))))).toBe(true);

        identities.set(OTHER, identity(OTHER, { isBot: true }));
        expect(isError(await readCall(await connect(as(OTHER))))).toBe(true);

        const previous = process.env.SCOUT_USER_EMAIL;
        process.env.SCOUT_USER_EMAIL = `  ${ME.toUpperCase()}@Example.COM `;
        try {
            const r = await readCall(await connect(as(ME)));
            expect(isError(r)).toBe(true);
            expect(text(r)).toContain('scout');
        } finally {
            if (previous === undefined) delete process.env.SCOUT_USER_EMAIL;
            else process.env.SCOUT_USER_EMAIL = previous;
        }
        expect(projects.list).not.toHaveBeenCalled();
    });

    it('re-reads the account before every call, so a later bot marking or deletion takes effect on a live connection', async () => {
        const { connect, as, identities } = setup();
        const client = await connect(as(ME));
        expect(isError(await readCall(client))).toBe(false);
        identities.set(ME, identity(ME, { isBot: true }));
        expect(isError(await readCall(client))).toBe(true);
        identities.delete(ME);
        expect(isError(await readCall(client))).toBe(true);
    });

    it('never lets one request act as another: concurrent connections keep their own user', async () => {
        const { connect, as, jobs } = setup();
        const [mine, theirs] = await Promise.all([connect(as(ME)), connect(as(OTHER))]);
        await Promise.all([
            mine.callTool({ name: 'listJobs', arguments: { createdBy: 'me' } }),
            theirs.callTool({ name: 'listJobs', arguments: { createdBy: 'me' } }),
            mine.callTool({ name: 'listJobs', arguments: { createdBy: 'me' } }),
        ]);
        const actors = jobs.list.mock.calls.map((c) => c[1].id as string);
        expect(actors.filter((a) => a === ME)).toHaveLength(2);
        expect(actors.filter((a) => a === OTHER)).toHaveLength(1);
    });

    it('ignores an actor smuggled in the arguments of a write', async () => {
        const { connect, as, jobs } = setup();
        const client = await connect(as(ME));
        await client.callTool({ name: 'createJob', arguments: { repoId: REPO, title: 'Add a thing', task: 'Do the thing properly', acceptanceCriteria: ['It works well'], createdBy: OTHER, createdById: OTHER, actor: { id: OTHER }, isBot: false, status: 'queued' } });
        expect(jobs.create).toHaveBeenCalledTimes(1);
        const [, dto, actor] = jobs.create.mock.calls[0];
        expect(actor.id).toBe(ME);
        expect(dto.status).toBe('triage');
        expect(JSON.stringify(dto)).not.toContain(OTHER);
    });
});

describe('MCP writes', () => {
    const job = { repoId: REPO, title: 'Add a thing', task: 'Do the thing properly', acceptanceCriteria: ['It works well'] };

    it('creates the job in triage as the caller inside the quota reservation', async () => {
        const { connect, as, jobs, quota } = setup();
        const r = await (await connect(as(ME))).callTool({ name: 'createJob', arguments: job });
        expect(isError(r)).toBe(false);
        expect(quota.withReservation).toHaveBeenCalledWith(ME, { jobs: 1 }, expect.any(Function));
        expect(jobs.create).toHaveBeenCalledWith(REPO, expect.objectContaining({ status: 'triage' }), expect.objectContaining({ id: ME, credential: 'api_key' }), expect.anything());
        expect(JSON.parse(text(r))).toMatchObject({ created: true, jobId: 'job-1', status: 'triage' });
    });

    it('turns an invalid job into a tool error and creates nothing', async () => {
        const { connect, as, jobs } = setup();
        const r = await (await connect(as(ME))).callTool({ name: 'createJob', arguments: { ...job, title: 'x' } });
        expect(isError(r)).toBe(true);
        expect(text(r)).toContain('nothing was created');
        expect(jobs.create).not.toHaveBeenCalled();
    });

    it('turns an exhausted allowance into a tool error', async () => {
        const { connect, as, quota, jobs } = setup();
        quota.withReservation.mockRejectedValueOnce(new McpQuotaExceededError('jobs', 20));
        const r = await (await connect(as(ME))).callTool({ name: 'createJob', arguments: job });
        expect(isError(r)).toBe(true);
        expect(text(r)).toContain('Daily MCP limit reached');
        expect(jobs.create).not.toHaveBeenCalled();
    });

    it('maps a stale expectedVersion (HTTP 409) of draftSpec to an MCP tool error', async () => {
        const { connect, as, specs } = setup();
        specs.saveVersion.mockRejectedValueOnce(new ConflictException('The spec changed: expected version 1, current is 2'));
        const r = await (await connect(as(ME))).callTool({ name: 'draftSpec', arguments: { specId: SPEC, title: 'A spec', body: '## Goal\n\nx\n', expectedVersion: 1 } });
        expect(isError(r)).toBe(true);
        expect(text(r)).toContain('409');
        expect(text(r)).toContain('expected version 1');
        expect(text(r)).not.toContain('at ');
    });

    it('saves a draft only: carries expectedVersion, as the caller, never approves', async () => {
        const { connect, as, specs, quota } = setup();
        specs.saveVersion.mockResolvedValueOnce({ id: SPEC, currentVersion: 2, status: 'draft', approvedVersion: 1 });
        const r = await (await connect(as(ME))).callTool({ name: 'draftSpec', arguments: { specId: SPEC, title: 'A spec', body: '## Goal\n\nx\n', expectedVersion: 1 } });
        expect(isError(r)).toBe(false);
        expect(specs.saveVersion).toHaveBeenCalledWith(SPEC, { title: 'A spec', body: '## Goal\n\nx\n', expectedVersion: 1 }, expect.objectContaining({ id: ME }));
        expect(specs.approve).not.toHaveBeenCalled();
        expect(JSON.parse(text(r))).toMatchObject({ saved: true, approved: false, status: 'draft' });
        expect(quota.withReservation).not.toHaveBeenCalled();
        expect(quota.reserve).not.toHaveBeenCalled();
    });

    it('reserves one feature plus all its jobs for a planned feature, atomically with its creation, and passes the caller', async () => {
        const { connect, as, plans, quota } = setup();
        plans.create.mockImplementationOnce(async (_input: unknown, _actor: unknown, options: { reserve: (m: unknown, c: { jobs: number }) => Promise<void> }) => {
            await options.reserve({}, { jobs: 3 });
            return { created: true, featureId: 'f-1', link: '/features/f-1', jobs: [{ key: 'a', jobId: 'j1', status: 'triage' }], spec: null };
        });
        const plan = { projectId: PROJECT, title: 'A feature', spec: 'What and why', acceptanceCriteria: ['Works'], jobs: [{ key: 'a', repoId: REPO, title: 'Job a', task: 'Do a properly', acceptanceCriteria: ['A works'], dependsOn: [] }] };
        const r = await (await connect(as(ME))).callTool({ name: 'createPlannedFeature', arguments: plan });
        expect(isError(r)).toBe(false);
        expect(plans.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'A feature' }), expect.objectContaining({ id: ME }), expect.any(Object));
        expect(quota.reserve).toHaveBeenCalledWith(expect.anything(), ME, { jobs: 3, features: 1 });
        expect(JSON.parse(text(r))).toMatchObject({ created: true, featureId: 'f-1', status: 'draft' });
    });

    it('turns a refused or stale plan into a tool error', async () => {
        const { connect, as, plans } = setup();
        plans.create.mockResolvedValueOnce({ created: false, problems: ['Spec "x" is no longer the approved version'] });
        const plan = { projectId: PROJECT, title: 'A feature', spec: 'What and why', acceptanceCriteria: ['Works'], jobs: [] };
        const r = await (await connect(as(ME))).callTool({ name: 'createPlannedFeature', arguments: plan });
        expect(isError(r)).toBe(true);
        expect(text(r)).toContain('no longer the approved version');
    });

    it('does not leak a database error', async () => {
        const { connect, as, projects } = setup();
        const { QueryFailedError } = await import('typeorm');
        projects.list.mockRejectedValueOnce(new QueryFailedError('SELECT secret FROM users', [], new Error('boom: password hash $argon2')));
        const r = await (await connect(as(ME))).callTool({ name: 'listProjects', arguments: {} });
        expect(isError(r)).toBe(true);
        expect(text(r)).not.toMatch(/SELECT|argon2|boom/);
    });
});
