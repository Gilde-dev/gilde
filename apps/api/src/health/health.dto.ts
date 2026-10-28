import { z } from 'zod';

export const HealthResponseSchema = z.object({
    status: z.enum(['up', 'down']),
    checks: z.object({
        database: z.object({ status: z.enum(['up', 'down']), error: z.string().optional() }),
    }),
});
export type HealthResponseDto = z.infer<typeof HealthResponseSchema>;
