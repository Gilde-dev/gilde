import { z } from 'zod';

export const AgentUsageSchema = z.object({
    id: z.string().uuid(),
    runId: z.string().uuid().nullable(),
    jobId: z.string().uuid().nullable(),
    sessionId: z.string(),
    model: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cacheReadTokens: z.number().int(),
    cacheCreationTokens: z.number().int(),
    /** Claude Code's estimate (notional under a subscription); null when it supplied none. */
    costUsd: z.number().nullable(),
    durationMs: z.number().nullable(),
    eventAt: z.string(),
    serviceVersion: z.string().nullable(),
    organizationId: z.string().nullable(),
    createdAt: z.string(),
});
export type AgentUsageDto = z.infer<typeof AgentUsageSchema>;

/** OTLP ExportLogsServiceResponse / ExportMetricsServiceResponse; `{}` is full success. */
export interface OtlpExportResponse {
    partialSuccess?: { rejectedLogRecords?: number; errorMessage?: string };
}
