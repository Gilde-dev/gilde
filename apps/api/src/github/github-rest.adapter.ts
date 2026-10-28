import { Injectable } from '@nestjs/common';

import { GitHubCredentials } from './github-credentials.js';
import { GITHUB_ISSUE_PAGE_SIZE, type GitHubDirEntry, type GitHubFile, type GitHubIssue, type GitHubIssuePage, type GitHubPort, type GitHubPull, type GitHubWorkflowRun } from './github.port.js';

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

    async listOpenIssuesWithLabel(fullName: string, label: string): Promise<GitHubIssuePage> {
        const rows = await this.get<IssueJson[]>(
            `/repos/${fullName}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${GITHUB_ISSUE_PAGE_SIZE}`,
        );
        return { issues: rows.filter((r) => !r.pull_request).map(toIssue), complete: rows.length < GITHUB_ISSUE_PAGE_SIZE };
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
        if (!res.ok) throw new Error(`GitHub GET ${path.split('?')[0]} failed: ${res.status}`);
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
