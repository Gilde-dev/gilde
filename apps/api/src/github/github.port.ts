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

export interface GitHubFile {
    content: string;
    /** The file's blob sha. */
    sha: string;
}

export interface GitHubDirEntry {
    name: string;
    /** Path from the repo root. */
    path: string;
    type: 'file' | 'dir';
}

export interface GitHubIssue {
    /** The issue's GraphQL node id. */
    nodeId: string;
    number: number;
    htmlUrl: string;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    authorLogin: string | null;
    labels: string[];
}

export interface GitHubIssuePage {
    /** Real issues only; pull requests are left out. */
    issues: GitHubIssue[];
    /** False when GitHub returned a full page, so more issues may exist. */
    complete: boolean;
}

export const GITHUB_ISSUE_PAGE_SIZE = 100;

export interface GitHubPort {
    /** False when no GitHub credentials are configured; the other methods would fail. */
    isConfigured(): boolean;
    getPull(fullName: string, number: number): Promise<GitHubPull>;
    /** The 50 most recently updated PRs (any state), newest first. */
    listRecentPulls(fullName: string): Promise<GitHubPull[]>;
    /** Workflow runs for a commit, newest first. */
    listWorkflowRuns(fullName: string, headSha: string): Promise<GitHubWorkflowRun[]>;
    /** The commit sha a branch points at. */
    getBranchHeadSha(fullName: string, branch: string): Promise<string>;
    /** A text file at `ref`, or null when it does not exist. */
    getFileContent(fullName: string, path: string, ref: string): Promise<GitHubFile | null>;
    /** The entries of a directory at `ref`, or null when it does not exist. */
    listDirectory(fullName: string, path: string, ref: string): Promise<GitHubDirEntry[] | null>;
    /** One page (at most GITHUB_ISSUE_PAGE_SIZE) of the open issues that carry `label`. */
    listOpenIssuesWithLabel(fullName: string, label: string): Promise<GitHubIssuePage>;
}
