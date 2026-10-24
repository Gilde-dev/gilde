import { z } from 'zod';

import { FEEDBACK_KINDS } from './feedback.entity.js';

/** Query string for GET /v1/feedback. */
export const ListFeedbackQuerySchema = z.object({
    projectId: z.string().uuid().optional(),
    repoId: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
});

export const FeedbackResponseSchema = z.object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    prNumber: z.number().int(),
    kind: z.enum(FEEDBACK_KINDS),
    githubId: z.string(),
    author: z.string(),
    authorAssociation: z.string(),
    state: z.string().nullable(),
    reviewId: z.string().nullable(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string().datetime(),
});

export type ListFeedbackQuery = z.infer<typeof ListFeedbackQuerySchema>;
export type FeedbackResponseDto = z.infer<typeof FeedbackResponseSchema>;
