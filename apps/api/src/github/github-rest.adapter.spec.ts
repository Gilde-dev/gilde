import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubRestAdapter } from './github-rest.adapter.js';
import { GitHubRequestError } from './github.port.js';

const MARKER = '<!-- gilde:intake:abc -->';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('GitHubRestAdapter.upsertIssueComment', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const adapter = new GitHubRestAdapter({ tokenFor: async () => 'tok', isConfigured: () => true } as never);
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
