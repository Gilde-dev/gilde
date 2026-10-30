export const GITHUB_PORT = Symbol('GITHUB_PORT');

export interface GitHubPull {
    number: number;
    state: 'open' | 'closed';
    merged: boolean;
    headSha: string;
    headRef: string;
    htmlUrl: string;
    body: string | null;
    /** GitHub's `mergeable_state` (clean, dirty, unknown, ...); only the single-PR read has it, null or missing means not known. */
    mergeableState?: string | null;
    /** Draft state of the PR; missing when GitHub did not report it. */
    draft?: boolean;
    /** The base branch name and the commit it pointed at when this was read. */
    baseRef?: string;
    baseSha?: string;
    /** GitHub's count of changed files; only the single-PR read has it. */
    changedFiles?: number;
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

/** A comment Gilde wrote on an issue. */
export interface GitHubIssueCommentRef {
    id: string;
    htmlUrl: string;
}

/** One changed file of a pull request. `patch` is null when GitHub gave none (binary, too large, or nothing to show). */
export interface GitHubDiffFile {
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch: string | null;
}

export const DIFF_INCOMPLETE_REASONS = ['pagination_cap', 'file_count_mismatch', 'missing_patch', 'head_changed', 'base_changed'] as const;
export type DiffIncompleteReason = (typeof DIFF_INCOMPLETE_REASONS)[number];

/** The diff of a PR at one head/base. `complete` is true only when every changed file arrived with its patch. */
export interface GitHubPullDiff {
    headSha: string;
    baseSha: string;
    files: GitHubDiffFile[];
    complete: boolean;
    incompleteReasons: DiffIncompleteReason[];
    /** Paths whose patch is missing although the file has changes. */
    filesWithoutPatch: string[];
}

/** GitHub lists at most 3000 files of a pull request, 100 per page. */
export const DIFF_PAGE_SIZE = 100;
export const DIFF_MAX_PAGES = 30;

export interface GitHubReviewRef {
    id: string;
    htmlUrl: string;
    commitId: string;
}

/** A GitHub request that failed; carries the status, never headers or tokens. */
export class GitHubRequestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

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
    /**
     * Gilde's one status comment on an issue (needs Issues: write). Edits comment `commentId` when given and still there;
     * otherwise looks for an earlier comment of the app that starts with `marker`, and only creates one when none exists.
     * Throws GitHubRequestError when GitHub refuses.
     */
    upsertIssueComment(fullName: string, issueNumber: number, input: { marker: string; body: string; commentId: string | null }): Promise<GitHubIssueCommentRef>;
    /**
     * The files of a pull request with their patches, bound to `expected` head and base: a head or base that moved while
     * reading, or any cap, missing patch or count mismatch, is reported in `incompleteReasons` and never as complete.
     */
    getPullDiff(fullName: string, number: number, expected: { headSha: string; baseSha: string }): Promise<GitHubPullDiff>;
    /**
     * Publishes one review with event COMMENT (never APPROVE or REQUEST_CHANGES) bound to `commitId`. The body is made to
     * start with `marker`, so the review can be found again. Needs Pull requests: write. Throws GitHubRequestError.
     */
    publishCommentReview(fullName: string, number: number, input: { commitId: string; marker: string; body: string }): Promise<GitHubReviewRef>;
    /**
     * The review of our own identity on this PR whose body starts with `marker` and is bound to `commitId`, or null when the
     * complete listing has none. Throws when the listing could not be completed, so absence is never guessed.
     */
    findReviewByMarker(fullName: string, number: number, marker: string, commitId: string): Promise<GitHubReviewRef | null>;
}
