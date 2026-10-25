import { Injectable } from '@nestjs/common';

import type { GitHubCodeHit, GitHubDirEntry, GitHubFile, GitHubPort, GitHubPull, GitHubWorkflowRun } from './github.port.js';

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

interface ContentJson {
    type: string;
    encoding?: string;
    content: string;
    sha: string;
}

interface CodeSearchJson {
    items: { path: string; text_matches?: { fragment: string }[] }[];
}

interface ContentEntryJson {
    type: string;
    name: string;
    path: string;
}

@Injectable()
export class GitHubRestAdapter implements GitHubPort {
    isConfigured(): boolean {
        return !!process.env.GITHUB_TOKEN;
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

    async searchCode(fullName: string, query: string, limit: number): Promise<GitHubCodeHit[]> {
        const q = encodeURIComponent(`${query} repo:${fullName}`);
        const body = await this.get<CodeSearchJson>(
            `/search/code?q=${q}&per_page=${limit}`,
            false,
            'application/vnd.github.text-match+json',
        );
        return body.items.slice(0, limit).map((i) => ({ path: i.path, fragments: (i.text_matches ?? []).map((m) => m.fragment) }));
    }

    private async get<T>(path: string, nullOn404?: false, accept?: string): Promise<T>;
    private async get<T>(path: string, nullOn404: true): Promise<T | null>;
    private async get<T>(path: string, nullOn404 = false, accept = 'application/vnd.github+json'): Promise<T | null> {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN is not set');
        const res = await fetch(`${API}${path}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: accept,
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
