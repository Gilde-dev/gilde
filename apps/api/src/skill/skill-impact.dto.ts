import { z } from 'zod';

export const SKILL_IMPACT_DEFAULT_DAYS = 30;
export const SKILL_IMPACT_MAX_DAYS = 180;

/** Query string; values arrive as strings, hence z.coerce. The default is applied by the service. */
export const SkillImpactQuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(SKILL_IMPACT_MAX_DAYS).optional(),
});
export type SkillImpactQuery = z.infer<typeof SkillImpactQuerySchema>;

const count = z.number().int();
const rate = z.number();

/** Descriptive counts of finished runs. Rates, the average and the median are null when `insufficient`. */
export const ImpactGroupSchema = z.object({
    n: count,
    insufficient: z.boolean(),
    counts: z.object({ done: count, partial: count, blocked: count, merged: count, rejectedOrParked: count, ciFailed: count }),
    rates: z.object({ done: rate, partial: rate, blocked: rate, merged: rate, rejectedOrParked: rate, ciFailed: rate }).nullable(),
    avgRevisionRounds: z.number().nullable(),
    /** Median of the attributed tokens over the runs that have attributed usage. */
    medianTokens: z.number().nullable(),
    /** How many runs of the group have attributed tokens. */
    tokensN: count,
});
export type ImpactGroupDto = z.infer<typeof ImpactGroupSchema>;

export const SkillVersionImpactSchema = z.object({
    hash: z.string(),
    managedBy: z.string().nullable(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    /** Finished runs that had exactly this version. */
    with: ImpactGroupSchema,
    /** Finished runs in the same repos that had no version of this skill. */
    without: ImpactGroupSchema,
});
export type SkillVersionImpactDto = z.infer<typeof SkillVersionImpactSchema>;

export const SkillImpactResponseSchema = z.object({
    days: z.number().int(),
    minRuns: z.number().int(),
    /** Per skill name, its versions in the order they were first seen. */
    skills: z.array(z.object({ name: z.string(), versions: z.array(SkillVersionImpactSchema) })),
});
export type SkillImpactResponseDto = z.infer<typeof SkillImpactResponseSchema>;
