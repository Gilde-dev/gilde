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
export interface BudgetReason {
    kind: 'limit' | 'configError';
    /** Set for `configError`: the affected environment variable. */
    variable: string | null;
    message: string;
}

/**
 * - `empty`: no usage rows in the period; `spent` 0 is "no usage", not a priced zero.
 * - `complete`: every row has a price; `spent` is exact (a true 0 is possible).
 * - `partial`: some rows have no price; `spent` is a lower bound.
 * - `unknown`: rows exist but none has a price; `spent` 0 means "unknown", not zero.
 */
export type BudgetPricing = 'empty' | 'complete' | 'partial' | 'unknown';

export interface BudgetPeriodStatus {
    scope: BudgetScope;
    period: BudgetPeriod;
    /** The project this belongs to; null for global. */
    projectId: string | null;
    /** UTC start (inclusive) and next reset (exclusive end) of the current period. */
    startsAt: string;
    resetsAt: string;
    /** Sum of the known estimated costs in USD (rows without a price add nothing). */
    spent: number;
    pricedRows: number;
    totalRows: number;
    unpricedRows: number;
    pricing: BudgetPricing;
    /** True when at least one row has no price: `spent` may be too low. */
    incomplete: boolean;
    /** Null = no limit (or an unreadable global configuration, see `reason`). */
    limit: number | null;
    /** spent / limit * 100, unrounded; null without a numeric limit or for a limit of 0. */
    percent: number | null;
    /** The percentage at which the state turns soft. */
    softPct: number;
    state: BudgetState;
    /** Null while `ok`. */
    reason: BudgetReason | null;
}

export interface BudgetBlocker {
    scope: BudgetScope;
    projectId: string | null;
    period: BudgetPeriod;
    kind: 'limit' | 'configError';
    variable: string | null;
    limit: number | null;
    spent: number;
    startsAt: string;
    resetsAt: string;
    message: string;
}

export interface BudgetStatusDto {
    /** The single clock reading all periods of this response were computed from. */
    evaluatedAt: string;
    global: { day: BudgetPeriodStatus; week: BudgetPeriodStatus };
    project: { projectId: string; day: BudgetPeriodStatus; week: BudgetPeriodStatus } | null;
    /** Every hard period that stops new automatic dispatch: global ones always, the project's when `projectId` is given. */
    blockers: BudgetBlocker[];
    hardBlocked: boolean;
    /**
     * `reset`: when all blockers are limits that a reset can clear, `recoversAt` is the LATEST blocker reset: the earliest
     * possible automatic full recovery on current facts (spend and limits may still change).
     * `manual`: a blocker needs a configuration or limit change (invalid global variable, or a limit of 0); no reset estimate.
     * `none`: nothing blocks.
     */
    recovery: 'none' | 'reset' | 'manual';
    recoversAt: string | null;
}
