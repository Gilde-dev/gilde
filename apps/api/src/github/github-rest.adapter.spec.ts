import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubRestAdapter } from './github-rest.adapter.js';
import { GitHubRequestError } from './github.port.js';

const MARKER = '<!-- gilde:intake:abc -->';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('GitHubRestAdapter.upsertIssueComment in PAT mode', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const make = () => new GitHubRestAdapter({ tokenFor: async () => 'tok', isConfigured: () => true, mode: 'pat' } as never);
    const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('https://api.github.com', '')}`);

    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
    afterEach(() => vi.unstubAllGlobals());

    it('finds its own marker comment (User-typed author) when the id is lost, and edits it', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { login: 'Gilde-Bot-User' }))
            .mockResolvedValueOnce(json(200, [{ id: 3, body: `${MARKER}\nforged`, user: { type: 'User', login: 'mallory' } }, { id: 9, body: `${MARKER}\nold`, user: { type: 'User', login: 'gilde-bot-user' } }]))
            .mockResolvedValueOnce(json(200, { id: 9, html_url: 'u' }));
        expect((await make().upsertIssueComment('o/r', 7, { marker: MARKER, body: 'new', commentId: null })).id).toBe('9');
        expect(calls()).toEqual(['GET /user', 'GET /repos/o/r/issues/7/comments?per_page=100&page=1', 'PATCH /repos/o/r/issues/comments/9']);
    });

    it('ignores a marker comment by another user and creates its own, never editing theirs', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { login: 'me' }))
            .mockResolvedValueOnce(json(200, [{ id: 3, body: `${MARKER}\nforged`, user: { type: 'User', login: 'mallory' } }, { id: 4, body: `${MARKER}\nbot`, user: { type: 'Bot', login: 'x[bot]' } }]))
            .mockResolvedValueOnce(json(201, { id: 55, html_url: 'u' }));
        expect((await make().upsertIssueComment('o/r', 7, { marker: MARKER, body: 'new', commentId: null })).id).toBe('55');
        expect(calls()).toEqual(['GET /user', 'GET /repos/o/r/issues/7/comments?per_page=100&page=1', 'POST /repos/o/r/issues/7/comments']);
    });

    it('reads the authenticated user once and caches it', async () => {
        const adapter = make();
        fetchMock.mockImplementation(async (url: string, init?: { method?: string }) =>
            String(url).endsWith('/user') ? json(200, { login: 'me' }) : init?.method === 'POST' ? json(201, { id: 1, html_url: 'u' }) : json(200, []));
        await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: 'a', commentId: null });
        await adapter.upsertIssueComment('o/r', 8, { marker: MARKER, body: 'a', commentId: null });
        expect(calls().filter((c) => c === 'GET /user')).toHaveLength(1);
    });
});

describe('GitHubRestAdapter.upsertIssueComment', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const adapter = new GitHubRestAdapter({ tokenFor: async () => 'tok', isConfigured: () => true, mode: 'app', isOwnApp: (id: number) => id === 42 } as never);
    const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('https://api.github.com', '')}`);

    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
    afterEach(() => vi.unstubAllGlobals());

    it('creates the comment when none exists, after looking for the marker among bot comments only', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, [{ id: 1, body: `${MARKER}\nforged`, user: { type: 'User' } }, { id: 2, body: 'hello', user: { type: 'Bot' } }]))
            .mockResolvedValueOnce(json(201, { id: 55, html_url: 'https://github.com/o/r/issues/7#issuecomment-55' }));
        const ref = await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: `${MARKER}\nhi`, commentId: null });
        expect(ref).toEqual({ id: '55', htmlUrl: 'https://github.com/o/r/issues/7#issuecomment-55' });
        expect(calls()).toEqual(['GET /repos/o/r/issues/7/comments?per_page=100&page=1', 'POST /repos/o/r/issues/7/comments']);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ body: `${MARKER}\nhi` });
    });

    it('edits the known comment in place without listing or creating', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { id: 55, html_url: 'u' }));
        await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: 'new', commentId: '55' });
        expect(calls()).toEqual(['PATCH /repos/o/r/issues/comments/55']);
    });

    it('finds its earlier comment by marker (no duplicate) when the id is not stored', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, [{ id: 9, body: `${MARKER}\nold`, user: { type: 'Bot' } }]))
            .mockResolvedValueOnce(json(200, { id: 9, html_url: 'u' }));
        expect((await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: 'new', commentId: null })).id).toBe('9');
        expect(calls()).toEqual(['GET /repos/o/r/issues/7/comments?per_page=100&page=1', 'PATCH /repos/o/r/issues/comments/9']);
    });

    it('in app mode ignores a bot comment from another app', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, [{ id: 8, body: `${MARKER}\nother`, user: { type: 'Bot' }, performed_via_github_app: { id: 7 } }]))
            .mockResolvedValueOnce(json(201, { id: 56, html_url: 'u' }));
        expect((await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: 'new', commentId: null })).id).toBe('56');
    });

    it('creates a new comment when the stored one was deleted', async () => {
        fetchMock
            .mockResolvedValueOnce(json(404, {}))
            .mockResolvedValueOnce(json(200, []))
            .mockResolvedValueOnce(json(201, { id: 77, html_url: 'u' }));
        expect((await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: 'b', commentId: '55' })).id).toBe('77');
    });

    it('throws a GitHubRequestError with the status, never the response or token, when GitHub refuses', async () => {
        fetchMock.mockResolvedValueOnce(json(200, [])).mockResolvedValueOnce(json(403, { message: 'Resource not accessible by integration' }));
        const error = await adapter.upsertIssueComment('o/r', 7, { marker: MARKER, body: 'b', commentId: null }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitHubRequestError);
        expect((error as GitHubRequestError).status).toBe(403);
        expect((error as Error).message).not.toContain('tok');
        expect((error as Error).message).not.toContain('Resource');
    });
});

describe('GitHubRestAdapter review primitives', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const app = new GitHubRestAdapter({ tokenFor: async () => 'tok', isConfigured: () => true, mode: 'app', isOwnApp: (id: number) => id === 42 } as never);
    const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('https://api.github.com', '')}`);
    const pull = (over: Record<string, unknown> = {}) => ({
        number: 5, state: 'open', html_url: 'u', body: 'hostile', head: { sha: 'h1', ref: 'b' }, base: { sha: 'b1', ref: 'main' }, draft: false, changed_files: 2, ...over,
    });
    const file = (name: string, over: Record<string, unknown> = {}) => ({ filename: name, status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ +x', ...over });
    const expected = { headSha: 'h1', baseSha: 'b1' };

    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
    afterEach(() => vi.unstubAllGlobals());

    it('reads draft and base metadata of a pull', async () => {
        fetchMock.mockResolvedValueOnce(json(200, pull({ draft: true })));
        expect(await app.getPull('o/r', 5)).toMatchObject({ draft: true, baseRef: 'main', baseSha: 'b1', changedFiles: 2, headSha: 'h1' });
    });

    it('returns a complete multi-page diff bound to the expected head and base', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) => file(`f${i}.ts`));
        fetchMock
            .mockResolvedValueOnce(json(200, pull({ changed_files: 101 })))
            .mockResolvedValueOnce(json(200, page1))
            .mockResolvedValueOnce(json(200, [file('last.ts')]))
            .mockResolvedValueOnce(json(200, pull({ changed_files: 101 })));
        const diff = await app.getPullDiff('o/r', 5, expected);
        expect(diff.complete).toBe(true);
        expect(diff.files).toHaveLength(101);
        expect(calls()).toEqual([
            'GET /repos/o/r/pulls/5', 'GET /repos/o/r/pulls/5/files?per_page=100&page=1', 'GET /repos/o/r/pulls/5/files?per_page=100&page=2', 'GET /repos/o/r/pulls/5',
        ]);
    });

    it('is incomplete when the page cap is reached, even if the count then matches', async () => {
        fetchMock.mockResolvedValueOnce(json(200, pull({ changed_files: 4000 })));
        for (let i = 0; i < 30; i++) fetchMock.mockResolvedValueOnce(json(200, Array.from({ length: 100 }, (_, j) => file(`f${i}-${j}`))));
        fetchMock.mockResolvedValueOnce(json(200, pull({ changed_files: 4000 })));
        const diff = await app.getPullDiff('o/r', 5, expected);
        expect(diff.complete).toBe(false);
        expect(diff.incompleteReasons).toEqual(expect.arrayContaining(['pagination_cap', 'file_count_mismatch']));
    });

    it('is incomplete when a changed file has no patch (binary or too large) but not for a pure rename', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, pull()))
            .mockResolvedValueOnce(json(200, [file('logo.png', { patch: undefined, changes: 0, additions: 0 }), file('huge.sql', { patch: undefined, changes: 9000 })]))
            .mockResolvedValueOnce(json(200, pull()));
        const diff = await app.getPullDiff('o/r', 5, expected);
        expect(diff.complete).toBe(false);
        expect(diff.incompleteReasons).toEqual(['missing_patch']);
        expect(diff.filesWithoutPatch).toEqual(['huge.sql']);
    });

    it('is incomplete when head or base moved while reading', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, pull()))
            .mockResolvedValueOnce(json(200, [file('a'), file('b')]))
            .mockResolvedValueOnce(json(200, pull({ head: { sha: 'h2', ref: 'b' }, base: { sha: 'b2', ref: 'main' } })));
        const diff = await app.getPullDiff('o/r', 5, expected);
        expect(diff.incompleteReasons).toEqual(expect.arrayContaining(['head_changed', 'base_changed']));
        expect(diff.complete).toBe(false);
    });

    it('surfaces GitHub errors and permission failures as GitHubRequestError with the status', async () => {
        fetchMock.mockResolvedValueOnce(json(404, { message: 'Not Found' }));
        const e1 = await app.getPullDiff('o/r', 5, expected).catch((e: unknown) => e);
        expect(e1).toBeInstanceOf(GitHubRequestError);
        expect((e1 as GitHubRequestError).status).toBe(404);
        fetchMock.mockResolvedValueOnce(json(200, pull())).mockResolvedValueOnce(json(500, {}));
        expect(((await app.getPullDiff('o/r', 5, expected).catch((e: unknown) => e)) as GitHubRequestError).status).toBe(500);
    });

    it('publishes a COMMENT review bound to the commit, marker first, and returns id and url', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { id: 77, html_url: 'https://github.com/o/r/pull/5#pullrequestreview-77', commit_id: 'h1' }));
        const ref = await app.publishCommentReview('o/r', 5, { commitId: 'h1', marker: '<!-- gilde:review:x -->', body: 'Looks fine' });
        expect(ref).toEqual({ id: '77', htmlUrl: 'https://github.com/o/r/pull/5#pullrequestreview-77', commitId: 'h1' });
        expect(calls()).toEqual(['POST /repos/o/r/pulls/5/reviews']);
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent).toEqual({ commit_id: 'h1', event: 'COMMENT', body: '<!-- gilde:review:x -->\nLooks fine' });
        expect(JSON.stringify(sent)).not.toMatch(/APPROVE|REQUEST_CHANGES/);
    });

    it('does not prefix the marker twice and refuses a body GitHub would reject', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { id: 1, html_url: 'u' }));
        await app.publishCommentReview('o/r', 5, { commitId: 'h1', marker: 'M', body: 'M\nbody' });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).toBe('M\nbody');
        await expect(app.publishCommentReview('o/r', 5, { commitId: 'h1', marker: 'M', body: 'x'.repeat(70_000) })).rejects.toThrow(/at most/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([403, 404, 422])('publication failure %i is a GitHubRequestError without the response text', async (status) => {
        fetchMock.mockResolvedValueOnce(json(status, { message: 'Resource not accessible by integration' }));
        const error = await app.publishCommentReview('o/r', 5, { commitId: 'h1', marker: 'M', body: 'b' }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitHubRequestError);
        expect((error as GitHubRequestError).status).toBe(status);
        expect((error as Error).message).not.toContain('Resource');
    });

    it('recovers a published review by marker, head and own identity, ignoring forgeries', async () => {
        const M = '<!-- gilde:review:x -->';
        fetchMock.mockResolvedValueOnce(json(200, [
            { id: 1, body: `${M}\nforged`, commit_id: 'h1', user: { type: 'User' } },
            { id: 2, body: `${M}\nother app`, commit_id: 'h1', user: { type: 'Bot' }, performed_via_github_app: { id: 7 } },
            { id: 3, body: `${M}\nold head`, commit_id: 'h0', user: { type: 'Bot' }, performed_via_github_app: { id: 42 } },
            { id: 4, body: `${M}\nours`, commit_id: 'h1', html_url: 'u4', user: { type: 'Bot' }, performed_via_github_app: { id: 42 } },
        ]));
        expect(await app.findReviewByMarker('o/r', 5, M, 'h1')).toEqual({ id: '4', htmlUrl: 'u4', commitId: 'h1' });
    });

    it('returns null for a complete listing without the marker and throws when the listing is capped', async () => {
        fetchMock.mockResolvedValueOnce(json(200, []));
        expect(await app.findReviewByMarker('o/r', 5, 'M', 'h1')).toBeNull();
        for (let i = 0; i < 30; i++) fetchMock.mockResolvedValueOnce(json(200, Array.from({ length: 100 }, (_, j) => ({ id: i * 100 + j, body: 'x', commit_id: 'h1' }))));
        await expect(app.findReviewByMarker('o/r', 5, 'M', 'h1')).rejects.toThrow(/cannot tell/);
    });
});
