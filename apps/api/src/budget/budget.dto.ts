import { z } from 'zod';

export const BudgetQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
});
export type BudgetQuery = z.infer<typeof BudgetQuerySchema>;

export const BUDGET_SCOPES = ['global', 'project'] as const;
export const BUDGET_PERIODS = ['day', 'week'] as const;
export const BUDGET_STATES = ['ok', 'soft', 'hard'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export type BudgetState = (typeof BUDGET_STATES)[number];

/** The global environment variables, by period. */
export const GLOBAL_BUDGET_VARIABLES = { day: 'GLOBAL_DAILY_BUDGET_USD', week: 'GLOBAL_WEEKLY_BUDGET_USD' } as const;

/**
 * Why a period is soft or hard. `limit`: recorded spend reached a configured limit (a limit of 0 stops immediately).
 * `configError`: the named global environment variable is set but invalid; it never carries the raw value, only the
 * variable name. A period reset does not clear a `configError`; the variable must be corrected.
 */
export const BudgetReasonSchema = z.object({
    kind: z.enum(['limit', 'configError']),
    /** Set for `configError`: the affected environment variable. */
    variable: z.string().nullable(),
    message: z.string(),
});
export type BudgetReason = z.infer<typeof BudgetReasonSchema>;

/**
 * - `empty`: no usage rows in the period; `spent` 0 is "no usage", not a priced zero.
 * - `complete`: every row has a price; `spent` is exact (a true 0 is possible).
 * - `partial`: some rows have no price; `spent` is a lower bound.
 * - `unknown`: rows exist but none has a price; `spent` 0 means "unknown", not zero.
 */
export const BudgetPricingSchema = z.enum(['empty', 'complete', 'partial', 'unknown']);
export type BudgetPricing = z.infer<typeof BudgetPricingSchema>;

export const BudgetPeriodStatusSchema = z.object({
    scope: z.enum(BUDGET_SCOPES),
    period: z.enum(BUDGET_PERIODS),
    /** The project this belongs to; null for global. */
    projectId: z.string().nullable(),
    /** UTC start (inclusive) and next reset (exclusive end) of the current period. */
    startsAt: z.string(),
    resetsAt: z.string(),
    /** Sum of the known estimated costs in USD (rows without a price add nothing). */
    spent: z.number(),
    pricedRows: z.number(),
    totalRows: z.number(),
    unpricedRows: z.number(),
    pricing: BudgetPricingSchema,
    /** True when at least one row has no price: `spent` may be too low. */
    incomplete: z.boolean(),
    /** Null = no limit (or an unreadable global configuration, see `reason`). */
    limit: z.number().nullable(),
    /** spent / limit * 100, unrounded; null without a numeric limit or for a limit of 0. */
    percent: z.number().nullable(),
    /** The percentage at which the state turns soft. */
    softPct: z.number(),
    state: z.enum(BUDGET_STATES),
    /** Null while `ok`. */
    reason: BudgetReasonSchema.nullable(),
});
export type BudgetPeriodStatus = z.infer<typeof BudgetPeriodStatusSchema>;

export const BudgetBlockerSchema = z.object({
    scope: z.enum(BUDGET_SCOPES),
    projectId: z.string().nullable(),
    period: z.enum(BUDGET_PERIODS),
    kind: z.enum(['limit', 'configError']),
    variable: z.string().nullable(),
    limit: z.number().nullable(),
    spent: z.number(),
    startsAt: z.string(),
    resetsAt: z.string(),
    message: z.string(),
});
export type BudgetBlocker = z.infer<typeof BudgetBlockerSchema>;

export const BudgetStatusSchema = z.object({
    /** The single clock reading all periods of this response were computed from. */
    evaluatedAt: z.string(),
    global: z.object({ day: BudgetPeriodStatusSchema, week: BudgetPeriodStatusSchema }),
    project: z.object({ projectId: z.string(), day: BudgetPeriodStatusSchema, week: BudgetPeriodStatusSchema }).nullable(),
    /** Every hard period that stops new automatic dispatch: global ones always, the project's when `projectId` is given. */
    blockers: z.array(BudgetBlockerSchema),
    hardBlocked: z.boolean(),
    /**
     * `reset`: when all blockers are limits that a reset can clear, `recoversAt` is the LATEST blocker reset: the earliest
     * possible automatic full recovery on current facts (spend and limits may still change).
     * `manual`: a blocker needs a configuration or limit change (invalid global variable, or a limit of 0); no reset estimate.
     * `none`: nothing blocks.
     */
    recovery: z.enum(['none', 'reset', 'manual']),
    recoversAt: z.string().nullable(),
});
export type BudgetStatusDto = z.infer<typeof BudgetStatusSchema>;
