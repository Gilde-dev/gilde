import { z } from 'zod';

import { BudgetBlockerSchema } from '../budget/budget.dto.js';

export const DispatchReasonSchema = z.enum(['repo_paused', 'project_paused', 'no_manifest', 'no_slots', 'daily_limit', 'budget', 'none']);
export type DispatchReason = z.infer<typeof DispatchReasonSchema>;

/** Why the estimated-spend guard stopped a repo: every hard period at once, not only the first one found. */
export const DispatchBudgetEvidenceSchema = z.object({
    /** Each hard project/global day/week period with scope, period, limit, spend and reset. */
    blockers: z.array(BudgetBlockerSchema),
    /** `reset`: the latest blocker reset is the earliest automatic recovery; `manual`: a limit/config change is needed; `unknown`: evaluation failed. */
    recovery: z.enum(['reset', 'manual', 'unknown']),
    /** True when the budget could not be evaluated; new automatic dispatch stays stopped. */
    error: z.boolean(),
});
export type DispatchBudgetEvidence = z.infer<typeof DispatchBudgetEvidenceSchema>;

export const RepoDispatchReportSchema = z.object({
    repoId: z.string(),
    fullName: z.string(),
    queued: z.number(),
    fired: z.number(),
    reason: DispatchReasonSchema,
    /** pausedReason, manifestError, `active/max`, `used/limit` or the budget blockers; null otherwise. */
    detail: z.string().nullable(),
    /**
     * Next UTC midnight (ISO) when the reason is daily_limit. For budget, the LATEST reset of all blockers (the earliest
     * automatic full recovery); null when a limit or configuration change is needed or the evaluation failed.
     */
    resetsAt: z.string().nullable(),
    waitingOnDependencies: z.number(),
    waitingOnRevisions: z.number(),
    /** Queued jobs whose owner has no executor that can take them right now (see each job's waitingReason). */
    waitingOnExecutor: z.number(),
    /** Set when the reason is budget. */
    budget: DispatchBudgetEvidenceSchema.nullable(),
});
export type RepoDispatchReport = z.infer<typeof RepoDispatchReportSchema>;

export const DispatchResultSchema = z.object({
    fired: z.number(),
    failed: z.number(),
    /** Queued jobs waiting for an executor of their owner, over all repos. */
    waitingOnExecutor: z.number(),
    repos: z.array(RepoDispatchReportSchema),
});
export type DispatchResult = z.infer<typeof DispatchResultSchema>;

export const DispatchStatusSchema = z.object({
    at: z.string().nullable(),
    result: DispatchResultSchema.nullable(),
});
export type DispatchStatus = z.infer<typeof DispatchStatusSchema>;
