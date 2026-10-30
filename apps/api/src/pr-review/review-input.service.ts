import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { GITHUB_PORT, GitHubRequestError, type GitHubPort, type GitHubPullDiff } from '../github/github.port.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';

import {
    REVIEW_CONVENTION_PATHS, classifyFeatureCriteria, conservativeTokenCount, criterionId, renderReviewPrompt, sha256, tooLarge,
    type AssembledReview, type AssemblyOutcome, type ReviewFile, type ReviewInputRefusal, type ReviewInputs, type ReviewSibling, type TokenCounter,
} from './review-inputs.js';

export interface AssembleRequest {
    jobId: string;
    prNumber: number;
    headSha: string;
    /** The base commit the review row recorded, if any; the pull's base must match it. */
    baseSha: string | null;
    /** The reviewer's system instructions; sized together with everything else. */
    instructions: string;
    maxInputTokens: number;
}

/** What an additional read reports, so the runtime can add up cost and stop when the budget is gone. */
export interface ContextRead {
    path: string;
    ref: string;
    /** False when the material is missing, unreadable or cut off; an incomplete read must never count as inspected. */
    complete: boolean;
    content: string | null;
    tokens: number;
    problem: string | null;
}

export interface ContextListing {
    path: string;
    ref: string;
    complete: boolean;
    entries: { path: string; type: 'file' | 'dir' }[];
    tokens: number;
    problem: string | null;
}

/** The only window the reviewer has on the repository: two reads, bound to one commit. No execution, no policy tools. */
export interface ReviewContextReader {
    readonly ref: string;
    readFile(path: string): Promise<ContextRead>;
    listDirectory(path: string): Promise<ContextListing>;
}

const TEST_SUFFIXES = ['.spec', '.test'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_NAME = /\.(?:spec|test)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)\//;
const CONTEXT_CONCURRENCY = 8;

/** Test files that would sit next to a changed source file; empty for tests and non-source files. */
export function testCandidates(path: string): string[] {
    if (TEST_NAME.test(path) || !SOURCE_EXT.test(path)) return [];
    const ext = /\.[^./]+$/.exec(path)![0];
    const stem = path.slice(0, -ext.length);
    return TEST_SUFFIXES.map((s) => `${stem}${s}${ext}`);
}

function safePath(path: string): string | null {
    if (!path || path.startsWith('/') || path.includes('\0') || path.includes('\\')) return null;
    return path.split('/').some((p) => p === '..' || p === '' || p === '.') ? null : path;
}

@Injectable()
export class ReviewInputService {
    constructor(
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Feature) private readonly features: Repository<Feature>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
    ) { }

    /**
     * Assembles the complete first request for one head, or refuses. Authoritative inputs are the persisted job, the feature's
     * stored pin and the base commit's conventions; the PR body is never read. Sizing happens before the context fetch (the
     * diff alone may already not fit) and again after it; nothing is truncated or sampled to fit.
     */
    async assemble(req: AssembleRequest, count: TokenCounter = conservativeTokenCount): Promise<AssemblyOutcome> {
        const unavailable = (detail: string): AssemblyOutcome => ({ ok: false, refusal: { reasonCode: 'context_unavailable', reason: 'review input unavailable', detail } });
        try {
            const job = await this.jobs.findOne({ where: { id: req.jobId } });
            if (!job) return unavailable('The job no longer exists');
            const repo = await this.repos.findOne({ where: { id: job.repoId } });
            if (!repo) return unavailable('The job\'s repository no longer exists');

            const pull = await this.github.getPull(repo.fullName, req.prNumber);
            if (pull.headSha !== req.headSha) return unavailable(`The pull request head moved to ${pull.headSha}; reviewing ${req.headSha} is obsolete`);
            if (!pull.baseSha) return unavailable('GitHub did not report the base commit');
            if (req.baseSha && pull.baseSha !== req.baseSha) return unavailable(`The base moved from ${req.baseSha} to ${pull.baseSha}`);
            const baseSha = pull.baseSha;

            const diff = await this.github.getPullDiff(repo.fullName, req.prNumber, { headSha: req.headSha, baseSha });
            if (!diff.complete) return { ok: false, refusal: diffRefusal(diff) };

            const conventions = await this.loadConventions(repo.fullName, baseSha);
            if ('reasonCode' in conventions) return { ok: false, refusal: conventions };

            const feature = job.featureId ? await this.features.findOne({ where: { id: job.featureId } }) : null;
            const siblings: ReviewSibling[] = feature
                ? (await this.jobs.find({ where: { featureId: feature.id } })).filter((j) => j.id !== job.id).map((j) => ({ jobId: j.id, title: j.title, status: j.status, acceptanceCriteria: j.acceptanceCriteria ?? [] }))
                : [];
            const ownCriteria = job.acceptanceCriteria ?? [];
            const specPin = feature?.specPin ?? null;
            if (specPin && sha256(specPin.body) !== specPin.bodySha256) return unavailable('The feature\'s stored spec pin does not match its recorded hash');

            const inputs: ReviewInputs = {
                schemaVersion: 1,
                repo: repo.fullName,
                prNumber: req.prNumber,
                headSha: req.headSha,
                baseSha,
                baseRef: pull.baseRef ?? null,
                job: { id: job.id, title: job.title, task: job.task, criteria: ownCriteria.map((text, i) => ({ id: criterionId(text, i, 'JOB'), text })) },
                feature: feature
                    ? {
                        id: feature.id,
                        title: feature.title,
                        criteria: classifyFeatureCriteria(feature.acceptanceCriteria ?? [], ownCriteria, siblings),
                        siblings,
                        specPin: specPin ? (({ body, ...identity }) => ({ identity, body }))(specPin) : null,
                    }
                    : null,
                conventions: { ref: baseSha, files: conventions.files, missing: conventions.missing },
                diff: { files: diff.files.map((f) => ({ path: f.path, previousPath: f.previousPath, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })) },
                context: [],
            };

            const preflight = this.size(inputs, req, count);
            if (preflight.inputTokens > req.maxInputTokens) return { ok: false, refusal: tooLarge(preflight.inputTokens, req.maxInputTokens) };

            const context = await this.loadRequiredContext(repo.fullName, req.headSha, inputs);
            if ('reasonCode' in context) return { ok: false, refusal: context };
            inputs.context = context.files;

            const full = this.size(inputs, req, count);
            if (full.inputTokens > req.maxInputTokens) return { ok: false, refusal: tooLarge(full.inputTokens, req.maxInputTokens) };
            return { ok: true, review: full };
        } catch (err) {
            return unavailable(err instanceof GitHubRequestError ? `GitHub answered ${err.status} while reading the review material` : 'The review material could not be read from GitHub');
        }
    }

    /** A read-only window on `repoFullName` at one commit. Each read reports its completeness and token cost. */
    contextReader(repoFullName: string, ref: string, count: TokenCounter = conservativeTokenCount): ReviewContextReader {
        const github = this.github;
        const bad = (path: string, problem: string): ContextRead => ({ path, ref, complete: false, content: null, tokens: 0, problem });
        return {
            ref,
            async readFile(path: string): Promise<ContextRead> {
                const p = safePath(path);
                if (!p) return bad(path, 'The path is not a repository-relative file path');
                try {
                    const file = await github.getFileContent(repoFullName, p, ref);
                    if (!file) return bad(p, 'The file does not exist at this commit');
                    return { path: p, ref, complete: true, content: file.content, tokens: count(file.content), problem: null };
                } catch (err) {
                    return bad(p, err instanceof GitHubRequestError ? `GitHub answered ${err.status}` : 'The file could not be read completely (binary or too large)');
                }
            },
            async listDirectory(path: string): Promise<ContextListing> {
                const p = path === '' ? '' : safePath(path);
                const fail = (problem: string): ContextListing => ({ path, ref, complete: false, entries: [], tokens: 0, problem });
                if (p === null) return fail('The path is not a repository-relative directory path');
                try {
                    const entries = await github.listDirectory(repoFullName, p, ref);
                    if (!entries) return fail('The directory does not exist at this commit');
                    return { path: p, ref, complete: true, entries: entries.map((e) => ({ path: e.path, type: e.type })), tokens: count(JSON.stringify(entries)), problem: null };
                } catch (err) {
                    return fail(err instanceof GitHubRequestError ? `GitHub answered ${err.status}` : 'The directory could not be listed');
                }
            },
        };
    }

    private size(inputs: ReviewInputs, req: AssembleRequest, count: TokenCounter): AssembledReview {
        const prompt = renderReviewPrompt(inputs);
        return {
            inputs, instructions: req.instructions, prompt, maxInputTokens: req.maxInputTokens,
            inputTokens: count(req.instructions) + count(prompt), fingerprint: sha256(prompt),
        };
    }

    private async loadConventions(fullName: string, baseSha: string): Promise<{ files: ReviewFile[]; missing: string[] } | ReviewInputRefusal> {
        const files: ReviewFile[] = [];
        const missing: string[] = [];
        for (const path of REVIEW_CONVENTION_PATHS) {
            let file;
            try {
                file = await this.github.getFileContent(fullName, path, baseSha);
            } catch {
                return { reasonCode: 'context_unavailable', reason: 'review input unavailable', detail: `${path} exists at the base commit but could not be read completely` };
            }
            if (file) files.push({ path, ref: baseSha, sha: file.sha, content: file.content });
            else missing.push(path);
        }
        return { files, missing };
    }

    /** The tests that sit next to changed source files, at the head. A read that fails is unavailable context, not an absent test. */
    private async loadRequiredContext(fullName: string, headSha: string, inputs: ReviewInputs): Promise<{ files: ReviewFile[] } | ReviewInputRefusal> {
        const inDiff = new Set(inputs.diff.files.map((f) => f.path));
        const wanted = [...new Set(inputs.diff.files.filter((f) => f.status !== 'removed').flatMap((f) => testCandidates(f.path)))].filter((p) => !inDiff.has(p));
        const files: ReviewFile[] = [];
        for (let i = 0; i < wanted.length; i += CONTEXT_CONCURRENCY) {
            const batch = wanted.slice(i, i + CONTEXT_CONCURRENCY);
            const settled = await Promise.allSettled(batch.map((p) => this.github.getFileContent(fullName, p, headSha)));
            for (const [j, outcome] of settled.entries()) {
                if (outcome.status === 'rejected') {
                    return { reasonCode: 'context_unavailable', reason: 'review input unavailable', detail: `${batch[j]} could not be read at the head commit` };
                }
                if (outcome.value) files.push({ path: batch[j], ref: headSha, sha: outcome.value.sha, content: outcome.value.content });
            }
        }
        return { files };
    }
}

function diffRefusal(diff: GitHubPullDiff): ReviewInputRefusal {
    const parts = diff.incompleteReasons.map((r) => ({
        pagination_cap: 'GitHub lists at most 3000 files of a pull request',
        file_count_mismatch: 'the files received do not match the pull request\'s file count',
        missing_patch: `no patch for ${diff.filesWithoutPatch.slice(0, 5).join(', ')}${diff.filesWithoutPatch.length > 5 ? ' …' : ''} (binary or too large for GitHub to show)`,
        head_changed: 'the head moved while reading',
        base_changed: 'the base moved while reading',
    })[r]);
    const truncated = diff.incompleteReasons.some((r) => r === 'pagination_cap' || r === 'missing_patch' || r === 'file_count_mismatch');
    return {
        reasonCode: truncated ? 'context_truncated' : 'context_unavailable',
        reason: truncated ? 'the diff is truncated upstream' : 'the diff changed while reading',
        detail: `The complete diff is not available: ${parts.join('; ')}`,
    };
}
