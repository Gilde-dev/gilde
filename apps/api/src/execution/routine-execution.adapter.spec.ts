import { afterEach, beforeEach, vi } from 'vitest';

import { ExecutionError } from './execution.error.js';
import type { JobPayload } from './execution.port.js';
import type { AgentInstructionsService } from './agent-instructions.service.js';
import { PROMPT_LIMIT } from './job-prompt.js';
import { RoutineExecutionAdapter } from './routine-execution.adapter.js';

const TOKEN = 'secret-token-value';
const repo = { fullName: 'gilde-dev/gilde', routineFireUrl: 'https://example.test/fire', routineTokenEnv: 'TEST_ROUTINE_TOKEN' };
const payload: JobPayload = {
    gilde: 1,
    jobId: 'job-1',
    runId: 'run-1',
    attempt: 2,
    repo: 'gilde-dev/gilde',
    baseBranch: 'main',
    title: 'T',
    task: 'Do it',
    acceptanceCriteria: ['a'],
    testCommands: ['pnpm test'],
    stacks: ['node'],
};
const okBody = { type: 'routine_fire', claude_code_session_id: 'sess_1', claude_code_session_url: 'https://claude.ai/code/sess_1' };

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('RoutineExecutionAdapter', () => {
    let instructions = { text: null as string | null, version: null as string | null };
    const adapter = new RoutineExecutionAdapter({ get: () => instructions } as unknown as AgentInstructionsService);
    const fetchMock = vi.fn();

    beforeEach(() => {
        process.env.TEST_ROUTINE_TOKEN = TOKEN;
        instructions = { text: null, version: null };
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        delete process.env.TEST_ROUTINE_TOKEN;
        fetchMock.mockReset();
        vi.unstubAllGlobals();
    });

    const failure = async (p: Promise<unknown>) => {
        const err = await p.then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(ExecutionError);
        expect((err as ExecutionError).message).not.toContain(TOKEN);
        return err as ExecutionError;
    };

    it('fires the routine and returns the session', async () => {
        fetchMock.mockResolvedValue(jsonResponse(okBody));

        await expect(adapter.fire(repo, payload)).resolves.toEqual({
            sessionId: 'sess_1',
            sessionUrl: 'https://claude.ai/code/sess_1',
            instructionsVersion: null,
        });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(repo.routineFireUrl);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({
            Authorization: `Bearer ${TOKEN}`,
            'anthropic-beta': 'experimental-cc-routine-2026-04-01',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        });
        expect(JSON.parse(init.body)).toEqual({
            text:
                'Gilde job job-1 (attempt 2). Execute it as described in your routine instructions.\n\n' +
                JSON.stringify(payload),
        });
    });

    it('sends instructions, a --- line, then the job line and payload', async () => {
        instructions = { text: 'Be good.\n', version: 'abc123def456' };
        fetchMock.mockResolvedValue(jsonResponse(okBody));

        const result = await adapter.fire(repo, payload);

        expect(result.instructionsVersion).toBe('abc123def456');
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body).text;
        expect(sent).toBe(
            'Be good.\n\n---\n\nGilde job job-1 (attempt 2). Execute it as described in your routine instructions.\n\n' +
            JSON.stringify(payload),
        );
        expect(adapter.preview(payload)).toEqual({ text: sent, instructionsVersion: 'abc123def456' });
    });

    it('sends the payload only, version null, without instructions', async () => {
        fetchMock.mockResolvedValue(jsonResponse(okBody));
        const result = await adapter.fire(repo, payload);
        expect(result.instructionsVersion).toBeNull();
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toMatch(/^Gilde job job-1/);
    });

    it('fails as a config error instead of truncating an oversized prompt', async () => {
        instructions = { text: 'x'.repeat(PROMPT_LIMIT), version: 'v' };
        const err = await failure(adapter.fire(repo, payload));
        expect(err.kind).toBe('config');
        expect(err.message).toContain('limit');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('lessons', () => {
        const lesson = (i: number, size = 100) => ({ id: `l${i}`, text: 'z'.repeat(size), scope: 'project' as const, status: 'approved' as const, relevance: 0.9 - i / 100 });

        it('sends lessons in the payload; a legacy payload without them is unchanged and still validates', async () => {
            fetchMock.mockResolvedValue(jsonResponse(okBody));
            await adapter.fire(repo, { ...payload, lessons: [lesson(1)] });
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain('"lessons":[{"id":"l1"');
            expect(adapter.preview(payload).text).not.toContain('lessons');
            expect(adapter.preview(payload).text).toBe(`Gilde job job-1 (attempt 2). Execute it as described in your routine instructions.\n\n${JSON.stringify(payload)}`);
        });

        it('drops the least relevant lessons first to fit near the limit, never touching task or instructions', () => {
            const base = adapter.preview(payload).text.length;
            instructions = { text: 'x'.repeat(PROMPT_LIMIT - base - 1520), version: 'v' };
            const lessons = [lesson(1, 400), lesson(2, 400), lesson(3, 400), lesson(4, 400)];
            const { text } = adapter.preview({ ...payload, lessons });
            expect(text.length).toBeLessThanOrEqual(PROMPT_LIMIT);
            expect(text).toContain('"id":"l1"');
            expect(text).not.toContain('"id":"l4"');
            expect(text).toContain('"task":"Do it"');
            expect(text.startsWith('x'.repeat(100))).toBe(true);
        });

        it('omits the lessons key entirely when none fit, and a prompt that is valid without lessons is never a config error', () => {
            const base = adapter.preview(payload).text.length;
            instructions = { text: 'x'.repeat(PROMPT_LIMIT - base - 20), version: 'v' };
            const { text } = adapter.preview({ ...payload, lessons: [lesson(1, 800)] });
            expect(text).not.toContain('lessons');
            expect(text.length).toBeLessThanOrEqual(PROMPT_LIMIT);
        });

        it('still fails as a config error when the required content alone is too long', () => {
            instructions = { text: 'x'.repeat(PROMPT_LIMIT), version: 'v' };
            expect(() => adapter.preview({ ...payload, lessons: [lesson(1)] })).toThrow(ExecutionError);
        });

        it('keeps feature, downstream and continuation context next to lessons', () => {
            const full = {
                ...payload, lessons: [lesson(1)],
                feature: { title: 'F', spec: 's', acceptanceCriteria: [] },
                downstream: [{ jobId: 'd', title: 'D', task: 't', acceptanceCriteria: [], dependsOn: ['job-1'] }],
                continueOn: { branch: 'b', prNumber: 3, reason: 'fix ci' },
            };
            const { text } = adapter.preview(full);
            for (const key of ['"feature"', '"downstream"', '"continueOn"', '"lessons"']) expect(text).toContain(key);
        });
    });

    it('rejects a repo without routine config (not retryable)', async () => {
        const err = await failure(adapter.fire({ ...repo, routineFireUrl: null }, payload));
        expect(err.kind).toBe('config');
        expect(err.retryable).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a missing env var (not retryable)', async () => {
        delete process.env.TEST_ROUTINE_TOKEN;
        const err = await failure(adapter.fire(repo, payload));
        expect(err.kind).toBe('config');
        expect(err.retryable).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([400, 401, 403, 404])('treats HTTP %i as not retryable', async (status) => {
        fetchMock.mockResolvedValue(new Response('nope', { status }));
        expect((await failure(adapter.fire(repo, payload))).kind).toBe('config');
    });

    it.each([429, 500, 503])('treats HTTP %i as retryable', async (status) => {
        fetchMock.mockResolvedValue(new Response('later', { status }));
        const err = await failure(adapter.fire(repo, payload));
        expect(err.kind).toBe('transient');
        expect(err.retryable).toBe(true);
    });

    it('treats network errors as retryable', async () => {
        fetchMock.mockRejectedValue(new TypeError(`fetch failed ${TOKEN}`));
        expect((await failure(adapter.fire(repo, payload))).retryable).toBe(true);
    });

    it('treats timeouts as retryable', async () => {
        fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        expect((await failure(adapter.fire(repo, payload))).retryable).toBe(true);
    });

    it('rejects an invalid response shape', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ type: 'other' }));
        expect((await failure(adapter.fire(repo, payload))).kind).toBe('invalid_response');
    });
});
