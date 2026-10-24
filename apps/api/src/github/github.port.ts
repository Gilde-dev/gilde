export const GITHUB_PORT = Symbol('GITHUB_PORT');

export interface GitHubPull {
    number: number;
    state: 'open' | 'closed';
    merged: boolean;
    headSha: string;
    headRef: string;
    htmlUrl: string;
    body: string | null;
}

export interface GitHubWorkflowRun {
    name: string;
    status: string;
    conclusion: string | null;
}

export interface GitHubPort {
    /** False when no GitHub credentials are configured; the other methods would fail. */
    isConfigured(): boolean;
    getPull(fullName: string, number: number): Promise<GitHubPull>;
    /** The 50 most recently updated PRs (any state), newest first. */
    listRecentPulls(fullName: string): Promise<GitHubPull[]>;
    /** Workflow runs for a commit, newest first. */
    listWorkflowRuns(fullName: string, headSha: string): Promise<GitHubWorkflowRun[]>;
}
