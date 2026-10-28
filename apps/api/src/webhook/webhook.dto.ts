import { z } from 'zod';

export const WebhookResponseSchema = z.object({ result: z.string() });
export type WebhookResponseDto = z.infer<typeof WebhookResponseSchema>;
