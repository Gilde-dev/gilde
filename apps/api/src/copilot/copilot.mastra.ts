import { registerCopilotKit } from '@ag-ui/mastra/copilotkit';
import { Logger } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

import { DEFAULT_COPILOT_MAX_STEPS, type CopilotConfig } from './copilot.config.js';
import { COPILOT_PROJECT_KEY, COPILOT_USER_KEY, copilotResourceId, copilotUser, extractProjectId } from './copilot.context.js';
import { COPILOT_INSTRUCTIONS } from './copilot.instructions.js';
import { createCopilotTools, type CopilotServices } from './copilot.tools.js';
import type { RepoContextService } from './repo-context.service.js';

/** Where Mastra is mounted: the global prefix plus the route of the copilot module. */
export const MASTRA_PREFIX = '/api/v1/mastra';
export const COPILOTKIT_PATH = `${MASTRA_PREFIX}/copilotkit`;
export const COPILOT_AGENT_ID = 'gilde';

/** Postgres on DATABASE_URL when it is a postgres URL, otherwise a LibSQL file in the working directory. */
export function createMemoryStorage(databaseUrl: string | undefined = process.env.DATABASE_URL): MastraCompositeStore {
    if (databaseUrl?.startsWith('postgres://') || databaseUrl?.startsWith('postgresql://')) {
        return new PostgresStore({ id: 'gilde-copilot', connectionString: databaseUrl });
    }
    return new LibSQLStore({ id: 'gilde-copilot', url: 'file:mastra.db' });
}

interface RunFinish {
    steps?: unknown[];
    totalUsage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}

/** One info line per co-pilot run: number of steps and token usage, so cost is visible in the API log. */
export function logRunUsage(logger: Pick<Logger, 'log'>, threadId: unknown, result: RunFinish): void {
    const u = result.totalUsage ?? result.usage ?? {};
    logger.log(
        `Co-pilot run finished (thread ${String(threadId ?? 'unknown')}): steps=${result.steps?.length ?? 0} ` +
            `inputTokens=${u.inputTokens ?? 0} cachedInputTokens=${u.cachedInputTokens ?? 0} outputTokens=${u.outputTokens ?? 0}`,
    );
}

const STEP_LIMIT_NOTE =
    'You are out of steps. Do not call any more tools. Reply with a short text: say you ran out of steps, what you have done and found so far, and what is left, so the user can continue.';

/**
 * Default options for every call path (CopilotKit route, remote calls from the channels app): the step limit,
 * and on the last step tools are switched off so the run ends with a message instead of silently.
 */
export function copilotDefaultOptions(maxSteps: number = DEFAULT_COPILOT_MAX_STEPS, logger: Pick<Logger, 'warn' | 'log'> = new Logger('Copilot')) {
    return {
        maxSteps,
        onFinish: (result: RunFinish & { threadId?: string; requestContext?: { get(key: string): unknown } }) =>
            logRunUsage(logger, result.threadId ?? result.requestContext?.get('threadId'), result),
        prepareStep: ({ stepNumber, systemMessages, requestContext }: { stepNumber: number; systemMessages?: unknown[]; requestContext?: { get(key: string): unknown } }) => {
            if (stepNumber < maxSteps - 1) return undefined;
            logger.warn(`Co-pilot reached the step limit of ${maxSteps}; forcing a final message (thread ${String(requestContext?.get('threadId') ?? 'unknown')})`);
            return { toolChoice: 'none' as const, systemMessages: [...(systemMessages ?? []), { role: 'system' as const, content: STEP_LIMIT_NOTE }] };
        },
    };
}

/**
 * Builds the Mastra instance. Called from a Nest provider so the tools get the Gilde services by injection.
 * When the co-pilot is not configured, the instance is empty (no agent, no storage) and the routes answer 503.
 */
export function createMastra(config: CopilotConfig, services: CopilotServices, storage?: MastraCompositeStore, repoContext?: RepoContextService): Mastra {
    if (!config.enabled) return new Mastra({});

    const agent = new Agent({
        id: COPILOT_AGENT_ID,
        name: COPILOT_AGENT_ID,
        description: 'Gilde co-pilot: answers questions about projects, jobs, features, proposals, dispatching, metrics and lessons.',
        // The repos' AGENTS.md, stacks and test commands are appended per request (selected project, else the only one).
        instructions: async ({ requestContext }) => {
            if (!repoContext) return COPILOT_INSTRUCTIONS;
            const reference = await repoContext.build(requestContext?.get(COPILOT_PROJECT_KEY) as string | undefined);
            return reference ? `${COPILOT_INSTRUCTIONS}\n\n${reference}` : COPILOT_INSTRUCTIONS;
        },
        // OpenAI through the Mastra model router; the provider is only chosen by COPILOT_MODEL.
        model: config.model as `openai/${string}`,
        tools: createCopilotTools(services),
        memory: new Memory({ options: { lastMessages: 20 } }),
        defaultOptions: copilotDefaultOptions(config.maxSteps) as never,
    });

    return new Mastra({
        agents: { [COPILOT_AGENT_ID]: agent },
        storage: storage ?? createMemoryStorage(),
        server: {
            apiRoutes: [
                registerCopilotKit({
                    path: COPILOTKIT_PATH,
                    // Replaced per request by the authenticated user (see CopilotContextInterceptor).
                    resourceId: copilotResourceId(null),
                    setContext: async (c, requestContext) => {
                        // Remember the project the page says is selected, so the instructions can include its repos.
                        try {
                            const projectId = extractProjectId(await c.req.raw.clone().json());
                            if (projectId) requestContext.set(COPILOT_PROJECT_KEY, projectId);
                        } catch { /* no JSON body: no page context */ }
                        // The interceptor has put req.user here; make sure memory is scoped to it.
                        requestContext.set(MASTRA_RESOURCE_ID_KEY, copilotResourceId(copilotUser(requestContext)));
                    },
                }),
            ],
        },
    });
}

export { COPILOT_USER_KEY };
