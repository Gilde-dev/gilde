import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { Mastra } from '@mastra/core/mastra';

import { attachRun } from '../agent-run/agent-run.mastra.js';
import type { AgentRunHandle } from '../agent-run/agent-run.recorder.js';
import type { RepoService } from '../repo/repo.service.js';
import type { SpecService } from '../spec/spec.service.js';

import type { PlanSetup } from './copilot.mastra.js';
import { PLAN_AGENT_ID } from './werkmeester.config.js';
import { isIssuedPlanBinding, issuePlanBinding, planOutcome, planStreamOptions, type PlanBinding } from './werkmeester.context.js';
import { planPrompt } from './werkmeester.instructions.js';
import { specPlanBlocker } from './werkmeester.propose.js';

/** A run that takes longer than this is abandoned and fails. */
const RUN_TIMEOUT_MS = 10 * 60_000;

export type PlanRunResult =
    | { outcome: 'planned'; featureId: string }
    | { outcome: 'skipped'; reason: string }
    | { outcome: 'failed'; reason: string };

/**
 * Runs the Werkmeester once for one approved spec version. The caller (the planning worker) picks the version and issues the
 * binding with `bind`; the agent can create a plan for that version and nothing else. `plan` never throws: it returns
 * `planned` (with the feature id), `skipped` (nothing to plan any more: archived, not approved, already planned) or `failed`
 * (with a short reason without secrets).
 */
export class WerkmeesterService {
    private readonly logger = new Logger('Werkmeester');

    constructor(
        private readonly setup: PlanSetup | null,
        private readonly mastra: Pick<Mastra, 'getAgent'>,
        private readonly specs: Pick<SpecService, 'getDetail'>,
        private readonly repos: Pick<RepoService, 'listForProject'>,
    ) { }

    get enabled(): boolean {
        return this.setup !== null;
    }

    /** A server-issued binding to one approved spec version, as the bot user. Throws while the Werkmeester is off. */
    bind(target: { projectId: string; specId: string; version: number; approvalId: string }, attempt: number): PlanBinding {
        if (!this.setup) throw new Error('The Werkmeester is not enabled');
        return issuePlanBinding(this.setup.user.id, target, attempt);
    }

    async plan(binding: PlanBinding, log?: AgentRunHandle): Promise<PlanRunResult> {
        if (!this.setup) return { outcome: 'failed', reason: 'The Werkmeester is not enabled' };
        if (!isIssuedPlanBinding(binding)) return { outcome: 'failed', reason: 'The planning run has no server-issued binding' };
        try {
            const detail = await this.specs.getDetail(binding.specId, null);
            if (detail.projectId !== binding.projectId) return { outcome: 'failed', reason: 'The spec is not in the bound project' };
            const blocked = specPlanBlocker(detail, binding);
            if (blocked) return { outcome: 'skipped', reason: blocked };
            const version = detail.versions.find((v) => v.version === binding.version)!;
            const repos = await this.repos.listForProject(binding.projectId);

            const prompt = planPrompt({
                slug: detail.slug, title: version.title, version: version.version, body: version.body, criteria: version.criteria,
                repos: repos.map((r) => ({ id: r.id, fullName: r.fullName, isSpecRepo: r.id === detail.repoId, stacks: r.stacks, testCommands: r.testCommands })),
            }, randomBytes(8).toString('hex'));
            const options = planStreamOptions(this.setup.user, binding);
            if (log) attachRun(options.requestContext, log);
            const output = await this.mastra.getAgent(PLAN_AGENT_ID).stream(prompt, {
                ...options,
                abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
            } as never);
            await (output as { consumeStream(): Promise<void> }).consumeStream();

            const outcome = planOutcome(binding);
            if (outcome.featureId) return { outcome: 'planned', featureId: outcome.featureId };
            if (outcome.skipReason) return { outcome: 'skipped', reason: outcome.skipReason };
            const last = outcome.lastProblems[0];
            return { outcome: 'failed', reason: short(last ? `The agent finished without a valid plan: ${last}` : 'The agent finished without proposing a plan') };
        } catch (error) {
            this.logger.warn(`Planning spec ${binding.specId} v${binding.version} failed: ${message(error)}`);
            return { outcome: 'failed', reason: short(message(error)) };
        }
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const short = (text: string) => (text.length > 300 ? `${text.slice(0, 297)}...` : text);
