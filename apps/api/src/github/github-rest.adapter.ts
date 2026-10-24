import { Injectable } from '@nestjs/common';

import type { GitHubPort, GitHubPull, GitHubWorkflowRun } from './github.port.js';

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

    private async get<T>(path: string): Promise<T> {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN is not set');
        const res = await fetch(`${API}${path}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Never include headers or the token in errors.
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
