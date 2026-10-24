import { afterEach, beforeEach, vi } from 'vitest';

import { ExecutionError } from './execution.error.js';
import type { JobPayload } from './execution.port.js';
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
    testCommand: 'pnpm test',
};
const okBody = { type: 'routine_fire', claude_code_session_id: 'sess_1', claude_code_session_url: 'https://claude.ai/code/sess_1' };

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('RoutineExecutionAdapter', () => {
    const adapter = new RoutineExecutionAdapter();
    const fetchMock = vi.fn();

    beforeEach(() => {
        process.env.TEST_ROUTINE_TOKEN = TOKEN;
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

    it('rejects a repo without routine config (not retryable)', async () => {
        const err = await failure(adapter.fire({ ...repo, routineFireUrl: null }, payload));
        expect(err.retryable).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a missing env var (not retryable)', async () => {
        delete process.env.TEST_ROUTINE_TOKEN;
        const err = await failure(adapter.fire(repo, payload));
        expect(err.retryable).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([400, 401, 403, 404])('treats HTTP %i as not retryable', async (status) => {
        fetchMock.mockResolvedValue(new Response('nope', { status }));
        expect((await failure(adapter.fire(repo, payload))).retryable).toBe(false);
    });

    it.each([429, 500, 503])('treats HTTP %i as retryable', async (status) => {
        fetchMock.mockResolvedValue(new Response('later', { status }));
        expect((await failure(adapter.fire(repo, payload))).retryable).toBe(true);
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
        expect((await failure(adapter.fire(repo, payload))).retryable).toBe(false);
    });
});
