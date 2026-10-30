import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Repository } from 'typeorm';
import { z } from 'zod';

import { AgentRuntimeService } from '../agent/agent-runtime.service.js';
import type { AgentRunHandle } from '../agent-run/agent-run.recorder.js';
import { AgentRunRecorder } from '../agent-run/agent-run.recorder.js';
import { BudgetService } from '../budget/budget.service.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { UsageService } from '../usage/usage.service.js';
import { computeCost, parsePrices } from '../usage/usage-pricing.js';

import { PrReview } from './pr-review.entity.js';
import { PrReviewService, type Usage } from './pr-review.service.js';
import { REVIEWER_INSTRUCTIONS, parseModelReview } from './review-instructions.js';
import { ReviewInputService, type ReviewContextReader } from './review-input.service.js';
import { conservativeTokenCount, refusalToResult, type AssembledReview, type TokenCounter } from './review-inputs.js';
import { ReviewMeter, type StopReason } from './review-meter.js';
import {
    DEFAULT_MAX_REVISIONS, ReviewLimitsSchema, TOO_LARGE_REASON, type BlockingFinding, type CompleteReview, type ErrorReview,
    type IncompleteReview, type ReviewLimits, type ReviewResult, type SkippedReview, type Suggestion,
} from './review-result.js';

/** Replaces the model of a review: tests pass a scripted AI SDK model, production leaves it to the model id from the settings. */
export const REVIEW_MODEL_RESOLVER = Symbol('REVIEW_MODEL_RESOLVER');
export type ReviewModelResolver = (modelId: string) => unknown;

export type ReviewerResolution =
    | { ok: true; model: string; limits: ReviewLimits }
    | { ok: false; skip: SkippedReview };

export type ReviewRunOutcome =
    | { executed: false; reason: 'not_found' | 'not_pending' | 'job_moved_on' }
    | { executed: true; review: PrReview | null; result: ReviewResult };

export interface RunOptions {
    /** Cancels the review: it ends as an incomplete result, never as a pass. */
    signal?: AbortSignal;
    count?: TokenCounter;
}

const NOT_FOUND = /does not exist at this commit/;
const STOP_TEXT: Record<StopReason, string> = {
    too_large: TOO_LARGE_REASON,
    timeout: 'The review ran out of time',
    step_limit: 'The review ran out of model steps',
    token_limit: 'The review ran out of tokens',
    cancelled: 'The review was cancelled',
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (text: string, max = 900) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Executes one durably claimed automatic review: resolves nothing from the past (the reviewer's configuration is read now),
 * checks the budgets before any model call, assembles the complete input, runs the read-only reviewer under hard bounds and
 * persists the validated result. Every failure is a persisted incomplete/error result, never a pass, and the model is called
 * at most once per head: `markRunning` is won by one caller and a restart abandons what it cannot know the end of.
 *
 * Not in here: when to claim a review, publishing it to GitHub and routing the job (the CI routing does those).
 */
@Injectable()
export class ReviewExecutionService {
    private readonly logger = new Logger('PrReview');

    constructor(
        private readonly reviews: PrReviewService,
        private readonly inputs: ReviewInputService,
        private readonly runtime: AgentRuntimeService,
        private readonly budget: BudgetService,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @Optional() private readonly runLog?: AgentRunRecorder,
        @Optional() private readonly usage?: UsageService,
        @Optional() @Inject(REVIEW_MODEL_RESOLVER) private readonly resolveModel?: ReviewModelResolver,
    ) { }

    /**
     * The reviewer as configured right now, with its limits as the snapshot to store on a new review. Called by whoever
     * claims a review; the snapshot then governs that review whatever the settings become.
     */
    async resolve(): Promise<ReviewerResolution> {
        const setup = await this.runtime.reviewerSetup();
        if (setup.config) {
            const c = setup.config;
            return {
                ok: true, model: c.model,
                limits: ReviewLimitsSchema.parse({
                    timeoutMs: c.timeoutSeconds * 1000, maxSteps: c.maxSteps, maxInputTokens: c.maxInputTokens,
                    maxOutputTokens: c.maxOutputTokens, maxRevisions: c.maxRevisions ?? DEFAULT_MAX_REVISIONS,
                }),
            };
        }
        const reasonCode = setup.status === 'disabled_by_env' ? 'kill_switch' : setup.status === 'off' ? 'runtime_disabled' : 'runtime_unconfigured';
        return { ok: false, skip: { kind: 'skipped', reasonCode, reason: short(setup.reason, 1000) } };
    }

    /** Runs the pending review `reviewId`. Never throws: a failure is stored as the review's result. */
    async run(reviewId: string, options: RunOptions = {}): Promise<ReviewRunOutcome> {
        const review = await this.reviews.findById(reviewId);
        if (!review) return { executed: false, reason: 'not_found' };
        if (review.status !== 'pending') return { executed: false, reason: 'not_pending' };

        const log = this.startLog(review);
        let usage: Usage = {};
        try {
            const out = await this.execute(review, options, log, (u) => { usage = u; });
            return await this.finish(review, out.result, usage, log, out.executedModel);
        } catch (error) {
            // Whatever went wrong after the claim: stored as an error, never repeated.
            this.logger.warn(`Review ${review.id} failed: ${message(error)}`);
            return this.finish(review, errorResult('execution_error', `The review failed: ${short(message(error), 300)}`), usage, log, false);
        }
    }

    private async finish(review: PrReview, result: ReviewResult, usage: Usage, log: AgentRunHandle | undefined, ranModel: boolean): Promise<ReviewRunOutcome> {
        let stored: PrReview | null = null;
        let final = result;
        try {
            stored = await this.reviews.complete(review.id, result, usage);
        } catch (error) {
            // The result itself could not be stored (e.g. it failed validation): store a plain error instead.
            final = errorResult('execution_error', `The review result could not be stored: ${short(message(error), 300)}`);
            try { stored = await this.reviews.complete(review.id, final, usage); } catch (e) { this.logger.error(`Review ${review.id} could not be stored: ${message(e)}`); }
        }
        await this.record(review, final, usage, log, ranModel);
        return { executed: true, review: stored, result: final };
    }

    private async execute(review: PrReview, options: RunOptions, log: AgentRunHandle | undefined, setUsage: (u: Usage) => void): Promise<{ result: ReviewResult; executedModel: boolean }> {
        const limits = ReviewLimitsSchema.safeParse(review.limits);
        if (!limits.success) return { result: errorResult('execution_error', 'The review has no valid limits snapshot'), executedModel: false };
        const count = options.count ?? conservativeTokenCount;

        // 1. Runtime and environment kill switches, read now.
        const setup = await this.runtime.reviewerSetup();
        if (!setup.config) {
            const code = setup.status === 'disabled_by_env' ? 'kill_switch' : setup.status === 'off' ? 'runtime_disabled' : 'runtime_unconfigured';
            return { result: { kind: 'skipped', reasonCode: code, reason: short(setup.reason, 1000) }, executedModel: false };
        }
        const model = setup.config.model;

        // 2. Budgets, before anything is fetched or called. A refusal or an unreadable budget is a visible result.
        try {
            const status = await this.budget.status(review.projectId);
            if (status.hardBlocked) {
                const why = status.blockers.map((b) => `${b.scope} ${b.period}`).join(', ');
                return { result: incomplete('budget_refused', short(`A budget limit is reached${why ? ` (${why})` : ''}; no model call was made`, 1000)), executedModel: false };
            }
        } catch (error) {
            return { result: incomplete('budget_unavailable', short(`The budget could not be evaluated, so no model call was made: ${message(error)}`, 1000)), executedModel: false };
        }

        // 3. Complete input, sized against the whole input budget. A refusal here is final and costs no model call.
        const repo = await this.repos.findOneBy({ id: review.repoId });
        if (!repo) return { result: incomplete('context_unavailable', 'The repository no longer exists'), executedModel: false };
        const assembled = await this.inputs.assemble({
            jobId: review.jobId, prNumber: review.prNumber, headSha: review.headSha, baseSha: review.baseSha,
            instructions: REVIEWER_INSTRUCTIONS, maxInputTokens: limits.data.maxInputTokens,
        }, count);
        if (!assembled.ok) return { result: refusalToResult(assembled.refusal), executedModel: false };

        // 4. The one execution of this head: only the winner of this conditional write may call the model.
        if (!(await this.reviews.markRunning(review.id))) {
            return { result: skipped('superseded', 'The review was not started: the job moved on or another worker owns it'), executedModel: false };
        }
        const reader = this.inputs.contextReader(repo.fullName, review.headSha, count);
        const run = await this.model(assembled.review, reader, limits.data, model, count, options);
        setUsage(run.usage);
        return { result: run.result, executedModel: true };
    }

    /** The bounded model loop. Returns the validated result and the usage actually spent. */
    private async model(
        assembled: AssembledReview, reader: ReviewContextReader, limits: ReviewLimits, modelId: string,
        count: TokenCounter, options: RunOptions,
    ): Promise<{ result: ReviewResult; usage: Usage }> {
        const meter = new ReviewMeter(limits, assembled.inputTokens);
        const controller = new AbortController();
        const halt = (reason: StopReason, detail: string) => { meter.halt(reason, detail); controller.abort(); };
        const problems: string[] = [];
        const readPaths = new Set<string>();
        const toolSet = this.tools(assembled, reader, meter, halt, problems, readPaths, count);
        const timer = setTimeout(() => halt('timeout', `The review did not finish within ${limits.timeoutMs} ms`), limits.timeoutMs);
        const onCancel = () => halt('cancelled', 'The review was cancelled');
        if (options.signal?.aborted) onCancel(); else options.signal?.addEventListener('abort', onCancel, { once: true });

        let text = '';
        let thrown: unknown = null;
        try {
            const agent = new Agent({
                id: 'reviewer', name: 'reviewer', instructions: REVIEWER_INSTRUCTIONS,
                model: (this.resolveModel ? this.resolveModel(modelId) : modelId) as never,
                tools: toolSet as never,
            });
            // Only the assembled prompt goes in; the PR description is never part of it.
            const output = await agent.stream(assembled.prompt, {
                maxSteps: limits.maxSteps,
                abortSignal: controller.signal,
                // Mastra reports provider errors through this hook instead of rejecting.
                onError: ({ error }: { error: unknown }) => { thrown ??= error; },
                modelSettings: { maxRetries: 0, temperature: 0, maxOutputTokens: meter.remainingOutput() },
                prepareStep: () => {
                    if (meter.beforeStep()) { controller.abort(); return undefined; }
                    return { modelSettings: { maxRetries: 0, temperature: 0, maxOutputTokens: meter.remainingOutput() } };
                },
                onStepFinish: (step: { usage?: { inputTokens?: number; outputTokens?: number }; finishReason?: string }) => {
                    meter.afterStep(step.usage);
                    if (step.finishReason === 'length') halt('token_limit', 'The model hit its output token limit');
                },
            } as never);
            await (output as { consumeStream(): Promise<void> }).consumeStream();
            text = meter.stop ? '' : String(await (output as { text: Promise<string> }).text);
        } catch (error) {
            thrown = error;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onCancel);
        }

        const usage: Usage = { model: modelId, inputTokens: meter.inputUsed, outputTokens: meter.outputUsed, costUsd: computeCost(parsePrices(process.env.LLM_PRICES), modelId, { inputTokens: meter.inputUsed, cachedInputTokens: 0, outputTokens: meter.outputUsed }) };

        if (meter.stop) {
            return { result: incomplete(meter.stop === 'cancelled' ? 'abandoned' : meter.stop, meter.stop === 'too_large' ? TOO_LARGE_REASON : short(`${STOP_TEXT[meter.stop]}: ${meter.stopDetail ?? ''}`)), usage };
        }
        if (thrown) return { result: errorResult('execution_error', short(`The model call failed: ${message(thrown)}`)), usage };

        const parsed = parseModelReview(text);
        if (!parsed && meter.steps >= limits.maxSteps) {
            return { result: incomplete('step_limit', short(`${STOP_TEXT.step_limit}: the review used its ${limits.maxSteps} allowed model steps without answering`)), usage };
        }
        if (!parsed || (parsed.verdict === 'pass') !== (parsed.blockingFindings.length === 0)) {
            return { result: incomplete('malformed_output', 'The reviewer did not answer with a valid, consistent structured result'), usage };
        }
        const normalized = normalize(parsed, assembled, readPaths);
        if (problems.length > 0) {
            // Context the review needed could not be read completely: what was found stays visible, it never routes.
            return { result: incomplete('context_unavailable', short(`Required context could not be read completely: ${problems[0]}`), normalized.blockingFindings, normalized.suggestions), usage };
        }
        return { result: normalized, usage };
    }

    /** The reviewer's whole tool set: read-only, bound to this head and base, each read metered before it reaches the model. */
    private tools(
        assembled: AssembledReview, reader: ReviewContextReader, meter: ReviewMeter, halt: (r: StopReason, d: string) => void,
        problems: string[], readPaths: Set<string>, count: TokenCounter,
    ) {
        const { inputs } = assembled;
        const baseReader = this.inputs.contextReader(inputs.repo, inputs.baseSha, count);
        const deliver = <T extends { tokens: number; complete: boolean; problem: string | null }>(r: T, what: string, payload: () => object) => {
            if (!r.complete) {
                if (!r.problem || !NOT_FOUND.test(r.problem)) problems.push(`${what}: ${r.problem ?? 'incomplete'}`);
                return { complete: false, problem: r.problem };
            }
            if (!meter.toolResultFits(r.tokens)) {
                halt(meter.overflowReason(), `${what} needs ${r.tokens} more input tokens than are left`);
                throw new Error('The review input budget is exhausted');
            }
            meter.addToolResult(r.tokens);
            return { complete: true, tokens: r.tokens, ...payload() };
        };
        const path = z.object({ path: z.string().min(1).max(500) });
        return {
            listChangedFiles: createTool({
                id: 'listChangedFiles',
                description: 'List the files changed by the pull request with their change type and size.',
                inputSchema: z.object({}),
                execute: async () => {
                    const files = inputs.diff.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions }));
                    const tokens = count(JSON.stringify(files));
                    return deliver({ tokens, complete: true, problem: null }, 'changed files', () => ({ files }));
                },
            }),
            readFileAtHead: createTool({
                id: 'readFileAtHead',
                description: 'Read a file as it is at the reviewed head commit; reports whether the content is complete and what it costs in tokens.',
                inputSchema: path,
                execute: async ({ path: p }) => {
                    const r = await reader.readFile(p);
                    if (r.complete) readPaths.add(r.path);
                    return deliver(r, `${p} at the head`, () => ({ path: r.path, content: r.content }));
                },
            }),
            readFileAtBase: createTool({
                id: 'readFileAtBase',
                description: 'Read a file as it is at the trusted base commit (conventions and unchanged code); reports completeness and token cost.',
                inputSchema: path,
                execute: async ({ path: p }) => {
                    const r = await baseReader.readFile(p);
                    if (r.complete) readPaths.add(r.path);
                    return deliver(r, `${p} at the base`, () => ({ path: r.path, content: r.content }));
                },
            }),
            searchCodeAtHead: createTool({
                id: 'searchCodeAtHead',
                description: 'Find files at the reviewed head commit whose path contains a text, under a directory; reports completeness and token cost.',
                inputSchema: z.object({ directory: z.string().max(500), contains: z.string().min(1).max(200) }),
                execute: async ({ directory, contains }) => {
                    const r = await reader.listDirectory(directory);
                    const matches = r.entries.filter((e) => e.path.toLowerCase().includes(contains.toLowerCase()));
                    return deliver({ ...r, tokens: count(JSON.stringify(matches)) }, `directory ${directory}`, () => ({ matches }));
                },
            }),
        };
    }

    private startLog(review: PrReview): AgentRunHandle | undefined {
        try {
            return this.runLog?.begin({
                agentId: 'reviewer', triggerKind: 'pr_review', triggerRefType: 'job', triggerRefId: review.jobId, projectId: review.projectId,
                linkedTable: 'pr_reviews', linkedId: review.id, managed: true,
            });
        } catch {
            return undefined;
        }
    }

    /** Activity, usage and cost. Best effort: nothing in here can change the stored verdict. */
    private async record(review: PrReview, result: ReviewResult, usage: Usage, log: AgentRunHandle | undefined, ranModel: boolean): Promise<void> {
        try {
            const clean = result.kind === 'complete';
            log?.end({
                outcome: result.kind === 'skipped' ? 'skipped' : result.kind === 'error' ? 'error' : result.kind === 'incomplete' && result.reasonCode.startsWith('budget') ? 'refused' : clean ? 'ok' : 'error',
                reason: result.kind === 'complete' ? null : result.reason,
                model: usage.model ?? undefined, inputTokens: usage.inputTokens ?? undefined, outputTokens: usage.outputTokens ?? undefined,
            });
            if (ranModel && usage.model) {
                await this.usage?.record({ kind: 'chat', model: usage.model, agent: 'reviewer', threadId: review.id, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
            }
        } catch (error) {
            this.logger.warn(`Recording review ${review.id} failed: ${message(error)}`);
        }
    }
}

const incomplete = (reasonCode: IncompleteReview['reasonCode'], reason: string, partialFindings: BlockingFinding[] = [], suggestions: Suggestion[] = []): IncompleteReview =>
    ({ kind: 'incomplete', reasonCode, reason, partialFindings, suggestions });
const errorResult = (reasonCode: ErrorReview['reasonCode'], reason: string): ErrorReview => ({ kind: 'error', reasonCode, reason, partialFindings: [], suggestions: [] });
const skipped = (reasonCode: SkippedReview['reasonCode'], reason: string): SkippedReview => ({ kind: 'skipped', reasonCode, reason });

/**
 * Makes the model's answer trustworthy against what the server knows. Relevance comes from the persisted job and feature,
 * never from the model; an unknown criterion is dropped; a criterion of the job nobody assessed is `unverifiable`. A blocker
 * that rests on a criterion assigned elsewhere, or that cites a file nobody saw, becomes a suggestion. If no blocker is left
 * the verdict is a pass, with unmet-but-unsupported criteria downgraded to `unverifiable`.
 */
export function normalize(model: ReturnType<typeof parseModelReview> & object, assembled: AssembledReview, readPaths: ReadonlySet<string>): CompleteReview {
    const { inputs } = assembled;
    const relevance = new Map<string, 'relevant' | 'assigned_elsewhere'>();
    for (const c of inputs.job.criteria) relevance.set(c.id, 'relevant');
    for (const c of inputs.feature?.criteria ?? []) if (!relevance.has(c.id)) relevance.set(c.id, c.relevance);

    const seen = new Set<string>();
    const coverage: CompleteReview['coverage'] = [];
    for (const c of model.coverage) {
        const rel = relevance.get(c.criterionId);
        if (!rel || seen.has(c.criterionId)) continue;
        seen.add(c.criterionId);
        coverage.push({ criterionId: c.criterionId, relevance: rel, status: c.status, explanation: c.explanation });
    }
    for (const [id, rel] of relevance) {
        if (rel === 'relevant' && !seen.has(id)) coverage.push({ criterionId: id, relevance: rel, status: 'unverifiable', explanation: 'The reviewer did not assess this criterion' });
    }

    const known = new Set([...inputs.diff.files.flatMap((f) => [f.path, f.previousPath ?? '']), ...inputs.context.map((f) => f.path), ...inputs.conventions.files.map((f) => f.path), ...readPaths]);
    const blocking: BlockingFinding[] = [];
    const suggestions: Suggestion[] = [...model.suggestions];
    for (const f of model.blockingFindings) {
        const elsewhere = f.criterionId !== undefined && relevance.get(f.criterionId) === 'assigned_elsewhere';
        const unknownCriterion = f.criterionId !== undefined && !relevance.has(f.criterionId);
        const unseenPath = f.path !== undefined && !known.has(f.path);
        if (elsewhere || unknownCriterion || unseenPath) {
            suggestions.push({ title: f.title, detail: `${f.evidence} — ${f.requestedFix}`.slice(0, 2000), ...(f.path && !unseenPath ? { path: f.path, ...(f.line ? { line: f.line } : {}) } : {}) });
        } else blocking.push(f);
    }
    const verdict = blocking.length > 0 ? 'blocking' : 'pass';
    const final = verdict === 'pass'
        ? coverage.map((c) => (c.relevance === 'relevant' && c.status === 'unmet' ? { ...c, status: 'unverifiable' as const, explanation: `No evidence-backed finding: ${c.explanation}`.slice(0, 2000) } : c))
        : coverage;
    return {
        kind: 'complete', verdict, summary: model.summary, inspection: { diffComplete: true, contextComplete: true },
        coverage: final, blockingFindings: blocking, suggestions: suggestions.slice(0, 100),
    };
}
