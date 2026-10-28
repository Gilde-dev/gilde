import { z } from 'zod';

export const ReconcileResultSchema = z.object({
    checked: z.number().int(),
    corrected: z.number().int(),
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
