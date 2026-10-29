import { HttpException } from '@nestjs/common';
import { z } from 'zod';

import type { SpecService } from '../spec/spec.service.js';

import type { FeaturePlanService } from './feature-plan.service.js';
import { planOutcome, type PlanBinding } from './werkmeester.context.js';
import { planProblems } from './werkmeester.checks.js';

/** What the model passes to proposePlan. No project, spec, version or approval: those come from the binding. */
export const proposePlanInput = z.object({
    title: z.string().describe('Feature title, 3-200 characters'),
    description: z.string().describe('What the feature is and why, a short paragraph'),
    jobs: z.array(z.object({
        key: z.string().describe('Short key, local to this plan (e.g. "api")'),
        repoId: z.string().describe('Id of a repo of this project, from the run message. Never invent one.'),
        title: z.string().describe('3-200 characters'),
        task: z.string().describe('The full task. Starts with the fetch/rebase line.'),
        acceptanceCriteria: z.array(z.string()).describe('Concrete, testable criteria; name the spec AC-n each covers'),
        dependsOn: z.array(z.string()).describe('Keys of jobs in this plan that must be merged first; [] when none'),
    })),
});
export type ProposePlanInput = z.infer<typeof proposePlanInput>;

export type ProposePlanResult =
    | { created: true; featureId: string; link: string; jobs: { key: string; jobId: string; status: 'triage' }[] }
    /** Fix exactly these problems and call proposePlan again. */
    | { created: false; retryable: true; errors: string[] }
    /** The plan can never be created from this binding: stop, do not call proposePlan again. */
    | { created: false; retryable: false; reason: string };

/**
 * The Werkmeester's only write. The project, spec, version and approval come from the server-issued binding, never from the
 * input. It checks the plan (see planProblems), then creates the draft feature and its triage jobs through FeaturePlanService
 * as the bot user. Nothing here can queue, dispatch, approve, edit a spec or touch an existing feature.
 */
export class PlanProposer {
    constructor(
        private readonly specs: Pick<SpecService, 'getDetail'>,
        private readonly plans: Pick<FeaturePlanService, 'create'>,
    ) { }

    async propose(binding: PlanBinding, input: ProposePlanInput): Promise<ProposePlanResult> {
        const outcome = planOutcome(binding);
        if (outcome.featureId) return { created: false, retryable: false, reason: `The plan was already created (feature ${outcome.featureId}); stop.` };

        const blocked = await this.blocker(binding);
        if (blocked) {
            outcome.skipReason = blocked;
            return { created: false, retryable: false, reason: blocked };
        }
        const detail = await this.specs.getDetail(binding.specId, null);
        const version = detail.versions.find((v) => v.version === binding.version)!;

        const jobs = input.jobs.map((j) => ({ ...j, key: j.key.trim(), dependsOn: j.dependsOn.map((k) => k.trim()) }));
        const problems = planProblems(version.criteria, jobs);
        if (problems.length) return this.retry(binding, problems);

        const criteria = version.criteria.map((c) => `${c.id}: ${c.text}`);
        const result = await this.create(binding, {
            projectId: binding.projectId,
            specId: binding.specId,
            specApproval: { version: binding.version, approvalId: binding.approvalId },
            title: input.title,
            spec: input.description,
            acceptanceCriteria: criteria.length >= 1 && criteria.length <= 20 ? criteria : [`All acceptance criteria of spec ${detail.slug} v${binding.version} are met`],
            jobs,
        });
        if (result.created) {
            outcome.featureId = result.featureId;
            return { created: true, featureId: result.featureId, link: result.link, jobs: result.jobs };
        }
        // A plan that was valid a moment ago and is not any more (a newer approval, an archive) must not be retried.
        const late = await this.blocker(binding);
        if (late) {
            outcome.skipReason = late;
            return { created: false, retryable: false, reason: late };
        }
        return this.retry(binding, result.problems);
    }

    /** Why this binding can no longer be planned, or null. */
    private async blocker(binding: PlanBinding): Promise<string | null> {
        return specPlanBlocker(await this.specs.getDetail(binding.specId, null), binding);
    }

    private async create(binding: PlanBinding, plan: unknown) {
        try {
            return await this.plans.create(plan, { id: binding.userId });
        } catch (e) {
            // A feature pinned this version in the meantime (the recording is pinned once): same as already planned.
            if (e instanceof HttpException && e.getStatus() < 500) return { created: false as const, problems: [e.message] };
            throw e;
        }
    }

    private retry(binding: PlanBinding, errors: string[]): ProposePlanResult {
        planOutcome(binding).lastProblems = errors;
        return { created: false, retryable: true, errors };
    }
}

/** The reason a spec version cannot be planned (archived, not the approved version, already pinned by a feature), or null. */
export function specPlanBlocker(detail: Awaited<ReturnType<SpecService['getDetail']>>, binding: Pick<PlanBinding, 'version' | 'approvalId'>): string | null {
    if (detail.archivedAt) return 'The spec is archived; nothing to plan.';
    const version = detail.versions.find((v) => v.version === binding.version);
    if (!version) return `The spec has no version ${binding.version}.`;
    if (detail.approvedVersion !== binding.version) return `Version ${binding.version} is no longer the approved version (approved: ${detail.approvedVersion ?? 'none'}); nothing to plan.`;
    if (version.approval?.id !== binding.approvalId) return `Version ${binding.version} was approved again by another approval; nothing to plan from this one.`;
    if (version.recording?.pinnedByFeatureId) return `Version ${binding.version} already has a feature pinned to it (${version.recording.pinnedByFeatureId}); it is never planned again.`;
    return null;
}
