import { Injectable } from '@nestjs/common';

import { GitHubCredentials } from './github-credentials.js';
import { DIFF_MAX_PAGES, DIFF_PAGE_SIZE, GITHUB_ISSUE_PAGE_SIZE, GitHubRequestError, type GitHubIssueCommentRef, type GitHubDirEntry, type GitHubFile, type GitHubIssue, type GitHubIssuePage, type GitHubPort, type GitHubDiffFile, type GitHubPull, type GitHubPullDiff, type GitHubReviewRef, type GitHubWorkflowRun, type DiffIncompleteReason } from './github.port.js';

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

interface PullJson {
    number: number;
    state: string;
    merged?: boolean;
    merged_at?: string | null;
    html_url: string;
    body: string | null;
    head: { sha: string; ref: string };
    base?: { sha?: string; ref?: string };
    draft?: boolean;
    changed_files?: number;
    mergeable_state?: string | null;
}

interface WorkflowRunsJson {
    workflow_runs: { name?: string | null; status?: string | null; conclusion?: string | null }[];
}

interface IssueJson {
    node_id: string;
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    state: string;
    user?: { login?: string } | null;
    labels?: (string | { name?: string })[];
    pull_request?: object;
}

interface ContentJson {
    type: string;
    encoding?: string;
    content: string;
    sha: string;
}

interface ContentEntryJson {
    type: string;
    name: string;
    path: string;
}

interface PullFileJson {
    filename: string;
    previous_filename?: string | null;
    status?: string;
    additions?: number;
    deletions?: number;
    changes?: number;
    patch?: string | null;
}

interface ReviewJson {
    id: number;
    html_url: string;
    body?: string | null;
    commit_id?: string | null;
    state?: string;
    user?: { type?: string; login?: string } | null;
    performed_via_github_app?: { id?: number } | null;
}

/** GitHub rejects review bodies above 65536 characters. */
const REVIEW_BODY_LIMIT = 65_000;

@Injectable()
export class GitHubRestAdapter implements GitHubPort {
    constructor(private readonly credentials: GitHubCredentials) { }

    isConfigured(): boolean {
        return this.credentials.isConfigured();
    }

    async getPull(fullName: string, number: number): Promise<GitHubPull> {
        return toPull(await this.get<PullJson>(`/repos/${fullName}/pulls/${number}`));
    }

    async listRecentPulls(fullName: string): Promise<GitHubPull[]> {
        const pulls = await this.get<PullJson[]>(`/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=50`);
        return pulls.map(toPull);
    }

    async listWorkflowRuns(fullName: string, headSha: string): Promise<GitHubWorkflowRun[]> {
        const body = await this.get<WorkflowRunsJson>(
            `/repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
        );
        return body.workflow_runs.map((r) => ({ name: r.name ?? '', status: r.status ?? '', conclusion: r.conclusion ?? null }));
    }

    async getBranchHeadSha(fullName: string, branch: string): Promise<string> {
        const commit = await this.get<{ sha: string }>(`/repos/${fullName}/commits/${encodeURIComponent(branch)}`);
        return commit.sha;
    }

    async getFileContent(fullName: string, path: string, ref: string): Promise<GitHubFile | null> {
        const file = await this.get<ContentJson | ContentJson[]>(
            `/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
            true,
        );
        if (file === null) return null;
        if (Array.isArray(file) || file.type !== 'file' || file.encoding !== 'base64') {
            throw new Error(`GitHub path ${path} in ${fullName} is not a file`);
        }
        return { content: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha };
    }

    async listDirectory(fullName: string, path: string, ref: string): Promise<GitHubDirEntry[] | null> {
        const entries = await this.get<ContentEntryJson[] | ContentJson>(
            `/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
            true,
        );
        if (entries === null) return null;
        if (!Array.isArray(entries)) throw new Error(`GitHub path ${path} in ${fullName} is not a directory`);
        return entries
            .filter((e) => e.type === 'file' || e.type === 'dir')
            .map((e) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file' }));
    }

    async getPullDiff(fullName: string, number: number, expected: { headSha: string; baseSha: string }): Promise<GitHubPullDiff> {
        const before = await this.getPull(fullName, number);
        const reasons = new Set<DiffIncompleteReason>();
        const files: GitHubDiffFile[] = [];
        let capped = false;
        for (let page = 1; page <= DIFF_MAX_PAGES; page++) {
            const rows = await this.get<PullFileJson[]>(`/repos/${fullName}/pulls/${number}/files?per_page=${DIFF_PAGE_SIZE}&page=${page}`);
            files.push(...rows.map(toDiffFile));
            if (rows.length < DIFF_PAGE_SIZE) break;
            if (page === DIFF_MAX_PAGES) capped = true;
        }
        if (capped) reasons.add('pagination_cap');
        if (before.changedFiles !== undefined && files.length !== before.changedFiles) reasons.add('file_count_mismatch');
        const filesWithoutPatch = files.filter((f) => f.patch === null && f.changes > 0).map((f) => f.path);
        if (filesWithoutPatch.length > 0) reasons.add('missing_patch');
        // The listing has no sha of its own: the pull is read again after it, and both reads must be the expected commits.
        const after = await this.getPull(fullName, number);
        if (before.headSha !== expected.headSha || after.headSha !== expected.headSha) reasons.add('head_changed');
        if ((before.baseSha ?? '') !== expected.baseSha || (after.baseSha ?? '') !== expected.baseSha) reasons.add('base_changed');
        return { headSha: expected.headSha, baseSha: expected.baseSha, files, complete: reasons.size === 0, incompleteReasons: [...reasons], filesWithoutPatch };
    }

    async publishCommentReview(fullName: string, number: number, input: { commitId: string; marker: string; body: string }): Promise<GitHubReviewRef> {
        const body = input.body.startsWith(input.marker) ? input.body : `${input.marker}\n${input.body}`;
        if (body.length > REVIEW_BODY_LIMIT) throw new Error(`Review body is ${body.length} characters; GitHub accepts at most ${REVIEW_BODY_LIMIT}`);
        const res = await this.send(`/repos/${fullName}/pulls/${number}/reviews`, 'POST', { commit_id: input.commitId, body, event: 'COMMENT' });
        if (!res.ok) throw new GitHubRequestError(`GitHub POST /repos/:repo/pulls/:number/reviews failed: ${res.status}`, res.status);
        const created = (await res.json()) as ReviewJson;
        return { id: String(created.id), htmlUrl: created.html_url, commitId: created.commit_id ?? input.commitId };
    }

    async findReviewByMarker(fullName: string, number: number, marker: string, commitId: string): Promise<GitHubReviewRef | null> {
        const own = await this.ownAuthor(fullName);
        for (let page = 1; page <= DIFF_MAX_PAGES; page++) {
            const rows = await this.get<ReviewJson[]>(`/repos/${fullName}/pulls/${number}/reviews?per_page=100&page=${page}`);
            const hit = rows.find((r) => (r.body ?? '').trimStart().startsWith(marker) && r.commit_id === commitId && own(r));
            if (hit) return { id: String(hit.id), htmlUrl: hit.html_url, commitId };
            if (rows.length < 100) return null;
        }
        throw new Error(`GitHub review listing of ${fullName}#${number} has more than ${DIFF_MAX_PAGES * 100} reviews; cannot tell whether ours exists`);
    }

    async listOpenIssuesWithLabel(fullName: string, label: string): Promise<GitHubIssuePage> {
        const rows = await this.get<IssueJson[]>(
            `/repos/${fullName}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${GITHUB_ISSUE_PAGE_SIZE}`,
        );
        return { issues: rows.filter((r) => !r.pull_request).map(toIssue), complete: rows.length < GITHUB_ISSUE_PAGE_SIZE };
    }

    async upsertIssueComment(fullName: string, issueNumber: number, input: { marker: string; body: string; commentId: string | null }): Promise<GitHubIssueCommentRef> {
        const base = `/repos/${fullName}/issues`;
        let id = input.commentId;
        if (!id) id = await this.findOwnComment(fullName, issueNumber, input.marker);
        if (id) {
            const res = await this.send(`/repos/${fullName}/issues/comments/${encodeURIComponent(id)}`, 'PATCH', { body: input.body });
            if (res.ok) return toCommentRef(await res.json());
            if (res.status !== 404) throw new GitHubRequestError(`GitHub PATCH /repos/:repo/issues/comments/:id failed: ${res.status}`, res.status);
            if (input.commentId) {
                // The stored comment was deleted: look again, then create.
                const found = await this.findOwnComment(fullName, issueNumber, input.marker);
                if (found && found !== input.commentId) return this.upsertIssueComment(fullName, issueNumber, { ...input, commentId: found });
            }
        }
        const res = await this.send(`${base}/${issueNumber}/comments`, 'POST', { body: input.body });
        if (!res.ok) throw new GitHubRequestError(`GitHub POST /repos/:repo/issues/:number/comments failed: ${res.status}`, res.status);
        return toCommentRef(await res.json());
    }

    /**
     * Gilde's earlier status comment: starts with the marker and was written by the authenticated identity, so nobody else
     * can make us edit their comment. App mode: a bot (not a member's comment, and the app's own id when GitHub reports it).
     * PAT mode: the token's own user, read once from `GET /user` and cached.
     */
    private async findOwnComment(fullName: string, issueNumber: number, marker: string): Promise<string | null> {
        const own = await this.ownAuthor(fullName);
        for (let page = 1; page <= 10; page++) {
            const rows = await this.get<{ id: number; body?: string | null; user?: { type?: string; login?: string } | null; performed_via_github_app?: { id?: number } | null }[]>(
                `/repos/${fullName}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
            );
            const hit = rows.find((r) => (r.body ?? '').trimStart().startsWith(marker) && own(r));
            if (hit) return String(hit.id);
            if (rows.length < 100) break;
        }
        return null;
    }

    private ownAuthor(fullName: string): Promise<(row: { user?: { type?: string; login?: string } | null; performed_via_github_app?: { id?: number } | null }) => boolean> {
        if (this.credentials.mode !== 'pat') {
            return Promise.resolve((r) => r.user?.type === 'Bot' && (r.performed_via_github_app?.id == null || this.credentials.isOwnApp(r.performed_via_github_app.id)));
        }
        return this.patLogin(fullName).then((login) => (r) => !!login && r.user?.login?.toLowerCase() === login.toLowerCase());
    }

    private patLoginPromise: Promise<string> | null = null;

    /** The login of the personal access token's user; read once, a failed read is not cached. */
    private patLogin(fullName: string): Promise<string> {
        if (!this.patLoginPromise) {
            const read = (async () => {
                const res = await fetch(`${API}/user`, {
                    headers: {
                        Authorization: `Bearer ${await this.credentials.tokenFor(fullName)}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                    },
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                if (!res.ok) throw new GitHubRequestError(`GitHub GET /user failed: ${res.status}`, res.status);
                return ((await res.json()) as { login?: string }).login ?? '';
            })();
            this.patLoginPromise = read;
            read.catch(() => { if (this.patLoginPromise === read) this.patLoginPromise = null; });
        }
        return this.patLoginPromise;
    }

    private async send(path: string, method: 'POST' | 'PATCH', payload: object): Promise<Response> {
        const fullName = /^\/repos\/([^/]+\/[^/?]+)/.exec(path)?.[1] as string;
        const token = await this.credentials.tokenFor(fullName);
        return fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }

    private async get<T>(path: string, nullOn404?: false): Promise<T>;
    private async get<T>(path: string, nullOn404: true): Promise<T | null>;
    private async get<T>(path: string, nullOn404 = false): Promise<T | null> {
        const fullName = /^\/repos\/([^/]+\/[^/?]+)/.exec(path)?.[1];
        if (!fullName) throw new Error(`GitHub path ${path.split('?')[0]} has no repo`);
        const token = await this.credentials.tokenFor(fullName);
        const res = await fetch(`${API}${path}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Never include headers or the token in errors.
        if (nullOn404 && res.status === 404) return null;
        if (!res.ok) throw new GitHubRequestError(`GitHub GET ${path.split('?')[0]} failed: ${res.status}`, res.status);
        return (await res.json()) as T;
    }
}

const toPull = (p: PullJson): GitHubPull => ({
    number: p.number,
    state: p.state === 'open' ? 'open' : 'closed',
    merged: p.merged ?? p.merged_at != null,
    headSha: p.head.sha,
    headRef: p.head.ref,
    htmlUrl: p.html_url,
    body: p.body,
    mergeableState: p.mergeable_state ?? null,
    draft: p.draft,
    baseRef: p.base?.ref,
    baseSha: p.base?.sha,
    changedFiles: p.changed_files,
});

const toDiffFile = (f: PullFileJson): GitHubDiffFile => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status ?? 'modified',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? (f.additions ?? 0) + (f.deletions ?? 0),
    patch: typeof f.patch === 'string' ? f.patch : null,
});

const toIssue = (i: IssueJson): GitHubIssue => ({
    nodeId: i.node_id,
    number: i.number,
    htmlUrl: i.html_url,
    title: i.title,
    body: i.body,
    state: i.state === 'open' ? 'open' : 'closed',
    authorLogin: i.user?.login ?? null,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
});

const toCommentRef = (json: unknown): GitHubIssueCommentRef => {
    const c = json as { id: number; html_url: string };
    return { id: String(c.id), htmlUrl: c.html_url };
};
