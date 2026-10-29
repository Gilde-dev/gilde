import { registerCopilotKit } from '@ag-ui/mastra/copilotkit';
import { Logger } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { defaultNotificationDeliveryDecision } from '@mastra/core/notifications';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

import { ensureRun, recordTools, runLogProcessor, type RunLog } from '../agent-run/agent-run.mastra.js';
import type { AgentRunAgent, AgentRunTrigger } from '../agent-run/agent-run.entity.js';
import type { AgentRunInit } from '../agent-run/agent-run.recorder.js';
import { memoryConfig } from '../memory/memory.config.js';
import { MemoryInfrastructure } from '../memory/memory.infrastructure.js';

import type { UsageService } from '../usage/usage.service.js';
import { withEmbeddingUsage } from '../usage/usage-context.js';

import { DEFAULT_COPILOT_MAX_STEPS, type CopilotConfig } from './copilot.config.js';
import { COPILOT_PROJECT_KEY, COPILOT_USER_KEY, UNAUTHENTICATED_RESOURCE, copilotResourceId, copilotUser, extractProjectId, type CopilotUser } from './copilot.context.js';
import { COPILOT_INSTRUCTIONS } from './copilot.instructions.js';
import { createCopilotTools, type CopilotServices } from './copilot.tools.js';
import type { RepoContextService } from './repo-context.service.js';
import { SCOUT_AGENT_ID, type ScoutConfig } from './verkenner.config.js';
import { scoutDeliveryDecider, type ScoutDispatchGate } from './scout-delivery-policy.js';
import { scoutBinding, scoutProjectOfThread, scoutStreamOptions } from './verkenner.context.js';
import { VERKENNER_INSTRUCTIONS } from './verkenner.instructions.js';
import { createScoutTools } from './verkenner.tools.js';
import { REFINE_AGENT_ID, type RefineConfig } from './verfijner.config.js';
import { refineBinding } from './verfijner.context.js';
import { VERFIJNER_INSTRUCTIONS } from './verfijner.instructions.js';
import type { RefinedSpecWriter } from './verfijner.save.js';
import { createRefineTools } from './verfijner.tools.js';
import type { ScoutSuggestionService } from './scout-suggestion.service.js';
import { PLAN_AGENT_ID, type PlanConfig } from './werkmeester.config.js';
import { WERKMEESTER_INSTRUCTIONS } from './werkmeester.instructions.js';
import type { PlanProposer } from './werkmeester.propose.js';
import { planBinding } from './werkmeester.context.js';
import { createPlanTools } from './werkmeester.tools.js';

/** Where Mastra is mounted: the global prefix plus the route of the copilot module. */
export const MASTRA_PREFIX = '/api/v1/mastra';
export const COPILOTKIT_PATH = `${MASTRA_PREFIX}/copilotkit`;
export const COPILOT_AGENT_ID = 'gilde';
export const SCOUT_DISPATCH_CRON = '*/5 * * * *';

/** Postgres on DATABASE_URL when it is a postgres URL, otherwise a LibSQL file in the working directory. */
export function createMemoryStorage(databaseUrl: string | undefined = process.env.DATABASE_URL): MastraCompositeStore {
    if (databaseUrl?.startsWith('postgres://') || databaseUrl?.startsWith('postgresql://')) {
        return new PostgresStore({ id: 'gilde-copilot', connectionString: databaseUrl });
    }
    return new LibSQLStore({ id: 'gilde-copilot', url: 'file:mastra.db' });
}

/** Stable preferences the co-pilot keeps per user across all threads. Kept short on purpose: it is sent with every request. */
export const WORKING_MEMORY_TEMPLATE = `# User preferences
- Preferred language:
- Answer style (short / detailed):
- Default project or repo:
- Other stable preferences:
`;

export const SEMANTIC_RECALL = { topK: 4, messageRange: 1, scope: 'resource' } as const;

/**
 * The co-pilot's Mastra Memory: the last 20 messages of the thread, resource-scoped working memory (preferences) and,
 * when an embedder is configured, resource-scoped semantic recall of older conversations in any thread of the same
 * user. The resource is always the authenticated Gilde user (see CopilotContextInterceptor).
 * Without embeddings, only semantic recall is off; working memory and conversation history keep working.
 */
export function createCopilotMemory(infra: MemoryInfrastructure, usage?: Pick<UsageService, 'record'>): Memory {
    const recall = infra.embeddingsEnabled;
    let embedder = infra.embedder;
    if (usage && embedder) {
        const name = infra.config.embeddings ? infra.config.model : 'custom';
        // A string is routed by Mastra; build the model here so its embedding calls can be recorded.
        embedder = withEmbeddingUsage(typeof embedder === 'string' ? new ModelRouterEmbeddingModel(embedder) : embedder, name, usage) as typeof embedder;
    }
    return new Memory({
        storage: infra.storage,
        ...(recall ? { vector: infra.personalVector, embedder, embeddingDimension: infra.embeddingDimension } : { vector: false as const }),
        options: {
            lastMessages: 20,
            workingMemory: { enabled: true, scope: 'resource', template: WORKING_MEMORY_TEMPLATE },
            semanticRecall: recall ? { ...SEMANTIC_RECALL } : false,
        },
    });
}

/**
 * The scout's Mastra Memory: the same storage (and, when configured, embedder and vector store) as the co-pilot, but
 * everything is scoped to the thread. The scout has one resource (the bot user) and one thread per project, so
 * thread scope is what keeps projects apart; there is no resource-wide working memory or recall.
 */
export function createScoutMemory(infra: MemoryInfrastructure, usage?: Pick<UsageService, 'record'>): Memory {
    const recall = infra.embeddingsEnabled;
    let embedder = infra.embedder;
    if (usage && embedder) {
        const name = infra.config.embeddings ? infra.config.model : 'custom';
        embedder = withEmbeddingUsage(typeof embedder === 'string' ? new ModelRouterEmbeddingModel(embedder) : embedder, name, usage) as typeof embedder;
    }
    return new Memory({
        storage: infra.storage,
        ...(recall ? { vector: infra.personalVector, embedder, embeddingDimension: infra.embeddingDimension } : { vector: false as const }),
        options: {
            lastMessages: 20,
            workingMemory: { enabled: false },
            semanticRecall: recall ? { ...SEMANTIC_RECALL, scope: 'thread' as const } : false,
        },
    });
}

/** An enabled scout: its configuration and the existing bot user it acts as. `model` replaces the configured one in tests. */
export interface ScoutSetup {
    config: Extract<ScoutConfig, { enabled: true }>;
    user: CopilotUser;
    model?: unknown;
    /** Native delivery policy of the scout. Without it (unit tests) the default decision is used. */
    gate?: ScoutDispatchGate;
    /** Creates the scout's triage suggestions (the suggestJob tool). */
    suggestions?: ScoutSuggestionService;
}

/** An enabled Verfijner: its configuration and the existing bot user it acts as. `model` replaces the configured one in tests. */
export interface RefineSetup {
    config: Extract<RefineConfig, { enabled: true }>;
    user: CopilotUser;
    model?: unknown;
    /** Saves the draft specs (the saveRefinedSpec tool). Without it (unit tests of the agent) every save is refused. */
    writer?: Pick<RefinedSpecWriter, 'save'>;
}

/** An enabled Werkmeester: its configuration and the existing bot user it acts as. `model` replaces the configured one in tests. */
export interface PlanSetup {
    config: Extract<PlanConfig, { enabled: true }>;
    user: CopilotUser;
    model?: unknown;
    /** Creates the plans (the proposePlan tool). Without it (unit tests of the agent) every proposal is refused. */
    proposer?: Pick<PlanProposer, 'propose'>;
}

interface RunUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }

interface RunFinish {
    steps?: unknown[];
    totalUsage?: RunUsage;
    usage?: RunUsage;
}

/** One info line per co-pilot run: number of steps and token usage, so cost is visible in the API log. */
export function logRunUsage(logger: Pick<Logger, 'log'>, threadId: unknown, result: RunFinish): void {
    const u = result.totalUsage ?? result.usage ?? {};
    logger.log(
        `Co-pilot run finished (thread ${String(threadId ?? 'unknown')}): steps=${result.steps?.length ?? 0} ` +
            `inputTokens=${u.inputTokens ?? 0} cachedInputTokens=${u.cachedInputTokens ?? 0} outputTokens=${u.outputTokens ?? 0}`,
    );
}

/** How a Mastra run is described in the run log, from what the server put in its request context. */
function runInit(agentId: AgentRunAgent, ctx: { get(key: string): unknown }, model: string): AgentRunInit {
    const scout = agentId === 'verkenner' ? scoutBinding(ctx as never) : null;
    const trigger: AgentRunTrigger = agentId === 'gilde' ? 'chat' : agentId === 'verkenner' ? 'signal' : 'schedule';
    const threadId = ctx.get('threadId');
    return {
        agentId, triggerKind: trigger, model,
        actorUserId: scout?.userId ?? copilotUser(ctx as never)?.id ?? null,
        projectId: scout?.projectId ?? (ctx.get(COPILOT_PROJECT_KEY) as string | undefined) ?? null,
        ...(scout ? { triggerRefType: 'project', triggerRefId: scout.projectId } : typeof threadId === 'string' ? { triggerRefType: 'thread', triggerRefId: threadId } : {}),
    };
}

const STEP_LIMIT_NOTE =
    'You are out of steps. Do not call any more tools. Reply with a short text: say you ran out of steps, what you have done and found so far, and what is left, so the user can continue.';

/**
 * Default options for every call path (CopilotKit route, remote calls from the channels app): the step limit,
 * and on the last step tools are switched off so the run ends with a message instead of silently.
 */
export function copilotDefaultOptions(
    maxSteps: number = DEFAULT_COPILOT_MAX_STEPS,
    logger: Pick<Logger, 'warn' | 'log'> = new Logger('Copilot'),
    usage?: { service: Pick<UsageService, 'record'>; model: string },
    agentId: string = COPILOT_AGENT_ID,
    runs?: { log: RunLog; model: string },
) {
    return {
        maxSteps,
        onFinish: (result: RunFinish & { threadId?: string; requestContext?: { get(key: string): unknown } }) => {
            const threadId = result.threadId ?? result.requestContext?.get('threadId');
            logRunUsage(logger, threadId, result);
            if (!usage) return;
            const u = result.totalUsage ?? result.usage ?? {};
            void usage.service.record({
                kind: 'chat',
                model: usage.model,
                agent: agentId,
                userId: copilotUser(result.requestContext as Parameters<typeof copilotUser>[0])?.id ?? null,
                threadId: threadId === undefined || threadId === null ? null : String(threadId),
                steps: result.steps?.length ?? 0,
                inputTokens: u.inputTokens,
                cachedInputTokens: u.cachedInputTokens,
                outputTokens: u.outputTokens,
                reasoningTokens: u.reasoningTokens,
            });
        },
        prepareStep: ({ stepNumber, systemMessages, requestContext }: { stepNumber: number; systemMessages?: unknown[]; requestContext?: { get(key: string): unknown } }) => {
            if (stepNumber === 0 && runs) ensureRun(requestContext, runs.log, (ctx) => runInit(agentId as AgentRunAgent, ctx, runs.model));
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
export function createMastra(config: CopilotConfig, services: CopilotServices, storage?: MastraCompositeStore, repoContext?: RepoContextService, infra?: MemoryInfrastructure, usage?: Pick<UsageService, 'record'>, scout?: ScoutSetup | null, refine?: RefineSetup | null, plan?: PlanSetup | null, runLog?: RunLog): Mastra {
    // The scout and the Verfijner are configured independently of the co-pilot: any one alone gets an instance, none gets an empty one.
    if (!config.enabled && !scout && !refine && !plan) return new Mastra({});

    const memoryInfra = infra ?? new MemoryInfrastructure(memoryConfig(), storage ? { storage } : {});
    const agents: Record<string, Agent> = {};
    if (config.enabled) agents[COPILOT_AGENT_ID] = createCopilotAgent(config, services, memoryInfra, repoContext, usage, runLog);
    if (scout) agents[SCOUT_AGENT_ID] = createScoutAgent(scout, services, memoryInfra, usage, runLog);
    if (refine) agents[REFINE_AGENT_ID] = createRefineAgent(refine, services, memoryInfra, usage, runLog);
    if (plan) agents[PLAN_AGENT_ID] = createPlanAgent(plan, services, memoryInfra, usage, runLog);

    return new Mastra({
        agents,
        storage: memoryInfra.storage,
        ...(config.enabled ? { server: { apiRoutes: [copilotKitRoute()] } } : {}),
        // Scheduled dispatch of deferred notifications and summaries, only while the scout is on. The cron says how often
        // Mastra looks; the delivery policy (scout-delivery-policy.ts) decides what may wake the agent.
        ...(scout ? { notifications: { dispatch: { enabled: true, cron: SCOUT_DISPATCH_CRON, batchSize: 100 } } } : {}),
    });
}

type McpToolSource = Pick<NonNullable<CopilotServices['mcpTools']>, 'buildTools'> | undefined;

/**
 * The agent's own tools plus the MCP tools of one project, per request. The project comes from the request context (never
 * from tool input); without one, or when the MCP layer fails, the agent just has its own tools.
 */
async function withMcpTools<T extends Record<string, unknown>>(own: T, mcp: McpToolSource, projectId: string | null | undefined, audience: 'copilot' | 'unattended'): Promise<T> {
    if (!mcp || !projectId) return own;
    try {
        return { ...(await mcp.buildTools(projectId, audience, Object.keys(own))), ...own };
    } catch {
        return own;
    }
}

/** Used when no suggestion service is wired (unit tests of the agent): every suggestion is refused and nothing is created. */
const REFUSING_SUGGESTIONS: Pick<ScoutSuggestionService, 'suggest'> = {
    suggest: async () => ({ created: false, stop: true, refusal: { reason: 'scout_off', message: 'Suggestions are not available.' } }),
};

const REFUSING_WRITER: Pick<RefinedSpecWriter, 'save'> = {
    save: async () => ({ saved: false, errors: ['Saving specs is not available.'] }),
};

const REFUSING_PROPOSER: Pick<PlanProposer, 'propose'> = {
    propose: async () => ({ created: false, retryable: false, reason: 'Proposing plans is not available.' }),
};

function createPlanAgent(plan: PlanSetup, services: CopilotServices, memoryInfra: MemoryInfrastructure, usage?: Pick<UsageService, 'record'>, runLog?: RunLog): Agent {
    const own = createPlanTools(services, plan.proposer ?? REFUSING_PROPOSER);
    return new Agent({
        id: PLAN_AGENT_ID,
        name: PLAN_AGENT_ID,
        description: 'Werkmeester, the planner: turns one approved spec version into a draft feature with triage jobs. Runs unattended, bound to one spec version; not reachable over HTTP.',
        instructions: WERKMEESTER_INSTRUCTIONS,
        model: (plan.model ?? plan.config.model) as `openai/${string}`,
        // Exactly its own allowlisted tools: no MCP tools, nothing else.
        tools: ({ requestContext }) => recordTools(planBinding(requestContext) ? own : {}) as never,
        // One thread per attempt; thread-scoped memory like the scout's.
        memory: createScoutMemory(memoryInfra, usage),
        ...(runLog ? { outputProcessors: [runLogProcessor(plan.config.model)] } : {}),
        defaultOptions: copilotDefaultOptions(plan.config.maxSteps, undefined, usage && { service: usage, model: plan.config.model }, PLAN_AGENT_ID, runLog && { log: runLog, model: plan.config.model }) as never,
    });
}

function createRefineAgent(refine: RefineSetup, services: CopilotServices, memoryInfra: MemoryInfrastructure, usage?: Pick<UsageService, 'record'>, runLog?: RunLog): Agent {
    const own = createRefineTools(services, refine.writer ?? REFUSING_WRITER);
    return new Agent({
        id: REFINE_AGENT_ID,
        name: REFINE_AGENT_ID,
        description: 'Verfijner, the refiner: turns one labelled GitHub issue into a draft spec. Runs unattended, bound to one intake item; not reachable over HTTP.',
        instructions: VERFIJNER_INSTRUCTIONS,
        model: (refine.model ?? refine.config.model) as `openai/${string}`,
        // Plus the read tools of the bound project's MCP servers that were opted in for unattended agents (never write tools).
        tools: async ({ requestContext }) => recordTools(await withMcpTools(own, services.mcpTools, refineBinding(requestContext)?.projectId, 'unattended')) as never,
        // One thread per attempt; thread-scoped memory like the scout's.
        memory: createScoutMemory(memoryInfra, usage),
        ...(runLog ? { outputProcessors: [runLogProcessor(refine.config.model)] } : {}),
        defaultOptions: copilotDefaultOptions(refine.config.maxSteps, undefined, usage && { service: usage, model: refine.config.model }, REFINE_AGENT_ID, runLog && { log: runLog, model: refine.config.model }) as never,
    });
}

function createScoutAgent(scout: ScoutSetup, services: CopilotServices, memoryInfra: MemoryInfrastructure, usage?: Pick<UsageService, 'record'>, runLog?: RunLog): Agent {
    const own = createScoutTools(services, memoryInfra.storage, scout.suggestions ?? REFUSING_SUGGESTIONS, scout.config.patternMinSize);
    return new Agent({
        id: SCOUT_AGENT_ID,
        name: SCOUT_AGENT_ID,
        description: 'Verkenner, the scout: reads what happens in a project and suggests follow-up work. Runs unattended on notifications; not reachable over HTTP.',
        instructions: VERKENNER_INSTRUCTIONS,
        model: (scout.model ?? scout.config.model) as `openai/${string}`,
        // Plus the read tools of the bound project's MCP servers that were opted in for unattended agents (never write tools).
        tools: async ({ requestContext }) => recordTools(await withMcpTools(own, services.mcpTools, scoutBinding(requestContext)?.projectId, 'unattended')) as never,
        memory: createScoutMemory(memoryInfra, usage),
        // Whatever starts a run of the scout (an immediate wake or the scheduled dispatcher) gets the memory thread and the
        // server-issued project binding of the notification's own thread. The project is parsed from the thread id.
        notifications: {
            deliveryPolicy: scout.gate ? { decide: scoutDeliveryDecider(scout.user, scout.gate) } : {
                decide: (input) => {
                    const projectId = scoutProjectOfThread(input.record.threadId);
                    if (!projectId) return undefined;
                    return { ...defaultNotificationDeliveryDecision(input), streamOptions: scoutStreamOptions(scout.user, projectId) as never };
                },
            },
        },
        ...(runLog ? { outputProcessors: [runLogProcessor(scout.config.model)] } : {}),
        defaultOptions: copilotDefaultOptions(scout.config.maxSteps, undefined, usage && { service: usage, model: scout.config.model }, SCOUT_AGENT_ID, runLog && { log: runLog, model: scout.config.model }) as never,
    });
}

function createCopilotAgent(config: Extract<CopilotConfig, { enabled: true }>, services: CopilotServices, memoryInfra: MemoryInfrastructure, repoContext?: RepoContextService, usage?: Pick<UsageService, 'record'>, runLog?: RunLog): Agent {
    const own = createCopilotTools(services);
    return new Agent({
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
        // Plus the allowed tools of the selected project's MCP servers; the write ones always ask for approval.
        tools: async ({ requestContext }) => recordTools(await withMcpTools(own, services.mcpTools, requestContext?.get(COPILOT_PROJECT_KEY) as string | undefined, 'copilot')) as never,
        memory: createCopilotMemory(memoryInfra, usage),
        ...(runLog ? { outputProcessors: [runLogProcessor(config.model)] } : {}),
        defaultOptions: copilotDefaultOptions(config.maxSteps, undefined, usage && { service: usage, model: config.model }, COPILOT_AGENT_ID, runLog && { log: runLog, model: config.model }) as never,
    });
}

/**
 * The Mastra instance as the CopilotKit route sees it: without the scout and the Verfijner. The route turns every registered agent into
 * a CopilotKit agent for the calling user; the scout is internal (unattended, bound to a project and the bot user) and
 * must be neither listed nor runnable there.
 */
export function withoutScout(mastra: Mastra): Mastra {
    return new Proxy(mastra, {
        get(target, prop) {
            if (prop === 'listAgents') {
                return () => Object.fromEntries(Object.entries(target.listAgents() ?? {}).filter(([id]) => id !== SCOUT_AGENT_ID && id !== REFINE_AGENT_ID && id !== PLAN_AGENT_ID));
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}

interface HonoContext { get(key: string): unknown; set(key: string, value: unknown): void }

function copilotKitRoute() {
    const route = registerCopilotKit({
        path: COPILOTKIT_PATH,
        // Replaced per request by the authenticated user (see CopilotContextInterceptor).
        resourceId: UNAUTHENTICATED_RESOURCE,
        setContext: async (c, requestContext) => {
            // Remember the project the page says is selected, so the instructions can include its repos.
            try {
                const projectId = extractProjectId(await c.req.raw.clone().json());
                if (projectId) requestContext.set(COPILOT_PROJECT_KEY, projectId);
            } catch { /* no JSON body: no page context */ }
            // The interceptor has put req.user here; make sure memory is scoped to it.
            requestContext.set(MASTRA_RESOURCE_ID_KEY, copilotResourceId(copilotUser(requestContext)));
        },
    });
    const handle = (route as unknown as { handler: (c: HonoContext) => Promise<Response> }).handler;
    return {
        ...route,
        handler: (c: HonoContext) => {
            c.set('mastra', withoutScout(c.get('mastra') as Mastra));
            return handle(c);
        },
    } as typeof route;
}

export { COPILOT_USER_KEY };
