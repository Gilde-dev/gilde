import type { AgentUsageDto } from './agent-usage.dto.js';
import type { AgentUsage } from './agent-usage.entity.js';

export function toAgentUsageDto(e: AgentUsage): AgentUsageDto {
    return {
        id: e.id,
        runId: e.runId,
        jobId: e.jobId,
        sessionId: e.sessionId,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheCreationTokens: e.cacheCreationTokens,
        costUsd: e.costUsd,
        durationMs: e.durationMs,
        eventAt: e.eventAt.toISOString(),
        serviceVersion: e.serviceVersion,
        organizationId: e.organizationId,
        createdAt: e.createdAt.toISOString(),
    };
}
