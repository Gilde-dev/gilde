import { z } from 'zod';

import { INTAKE_SOURCES, INTAKE_STATUSES } from './intake-item.entity.js';

export const IntakeStatusSchema = z.enum(INTAKE_STATUSES);

export const ListIntakeQuerySchema = z.object({
    status: IntakeStatusSchema.optional(),
});
export type ListIntakeQueryDto = z.infer<typeof ListIntakeQuerySchema>;

export const IntakeItemResponseSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    repoId: z.string(),
    repoFullName: z.string().nullable(),
    source: z.enum(INTAKE_SOURCES),
    externalId: z.string(),
    number: z.number().int(),
    url: z.string(),
    title: z.string(),
    authorLogin: z.string().nullable(),
    labels: z.array(z.string()),
    status: IntakeStatusSchema,
    specId: z.string().nullable(),
    lastError: z.string().nullable(),
    refineAttempts: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type IntakeItemResponseDto = z.infer<typeof IntakeItemResponseSchema>;

export const IntakeItemDetailResponseSchema = IntakeItemResponseSchema.extend({
    body: z.string(),
    bodyTruncated: z.boolean(),
    bodySha256: z.string(),
    refinedSha256: z.string().nullable(),
});
export type IntakeItemDetailResponseDto = z.infer<typeof IntakeItemDetailResponseSchema>;

export const IntakeSweepResultSchema = z.object({
    /** Repos listed on GitHub. */
    repos: z.number().int(),
    /** Repos left out: the app is not installed, or GitHub could not be read. */
    skipped: z.number().int(),
    /** Items created or changed by the sweep. */
    upserted: z.number().int(),
    /** Items withdrawn because their issue is no longer open and labelled. */
    withdrawn: z.number().int(),
});
export type IntakeSweepResultDto = z.infer<typeof IntakeSweepResultSchema>;
