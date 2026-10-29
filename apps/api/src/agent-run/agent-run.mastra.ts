import type { AgentRunHandle, AgentRunInit, AgentRunRecorder } from './agent-run.recorder.js';

/** Request-context key holding the AgentRunHandle of the current run. Set by the worker that owns the run, or lazily on the first step. */
export const AGENT_RUN_KEY = 'gildeAgentRun';

type Ctx = { get(key: string): unknown; set?(key: string, value: unknown): void } | undefined;

export type RunLog = Pick<AgentRunRecorder, 'begin'>;

export const runOf = (ctx: Ctx): AgentRunHandle | undefined => ctx?.get(AGENT_RUN_KEY) as AgentRunHandle | undefined;

/** Puts a handle in the request context so the tool wrapper and the finish hook find it. */
export function attachRun(ctx: Ctx, handle: AgentRunHandle): void {
    ctx?.set?.(AGENT_RUN_KEY, handle);
}

/** The run of this request, started now when the request has none yet (a co-pilot request, a scout wake). Never throws. */
export function ensureRun(ctx: Ctx, log: RunLog | undefined, init: (ctx: NonNullable<Ctx>) => AgentRunInit): AgentRunHandle | undefined {
    if (!ctx || !log) return undefined;
    try {
        const existing = runOf(ctx);
        if (existing) return existing;
        const handle = log.begin(init(ctx));
        attachRun(ctx, handle);
        return handle;
    } catch {
        return undefined;
    }
}

type Executable = { execute?: (input: unknown, context: { requestContext?: Ctx }) => Promise<unknown> };

/**
 * Wraps the execute of every tool so each call is recorded on the run of its request (name, input, output, duration,
 * error). The tool objects are copied, never changed, and their results and errors pass through untouched; recording
 * itself is queued and cannot throw. Tools of a request without a run are not recorded.
 */
export function recordTools<T extends Record<string, unknown>>(tools: T): T {
    const wrapped: Record<string, unknown> = {};
    for (const [name, tool] of Object.entries(tools)) {
        const original = (tool as Executable | null)?.execute;
        if (typeof original !== 'function') { wrapped[name] = tool; continue; }
        const copy = Object.assign(Object.create(Object.getPrototypeOf(tool) as object | null) as object, tool) as Executable;
        copy.execute = async (input, context) => {
            const run = runOf(context?.requestContext);
            const started = Date.now();
            // Recording is best effort: whatever it does, the tool's own result or error is what the agent gets.
            const record = (rest: { output?: unknown; error?: unknown }) => {
                try { run?.toolCall({ name, input, durationMs: Date.now() - started, ...rest }); } catch { /* never affects the run */ }
            };
            try {
                const output = await original.call(tool, input, context);
                record({ output });
                return output;
            } catch (error) {
                record({ error });
                throw error;
            }
        };
        wrapped[name] = copy;
    }
    return wrapped as T;
}

interface OutputResultArgs {
    messages: unknown;
    result: { usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
    requestContext?: Ctx;
}

/**
 * Ends the run of a finished Mastra stream with its tokens. Mastra's `onFinish` has neither the request context nor a run
 * id we could match to the first step, so this is an output processor: `processOutputResult` runs once at the end of a
 * generation with the request context and the usage. A run its owner manages (a worker) gets no outcome here; the owner
 * sets it. Never throws and never changes the messages.
 */
export function runLogProcessor(model: string) {
    return {
        id: 'agent-run-log',
        name: 'Agent run log',
        processOutputResult: (args: OutputResultArgs) => {
            try {
                const run = runOf(args.requestContext);
                const usage = args.result?.usage ?? {};
                run?.end({
                    ...(run.managed ? {} : { outcome: 'ok' as const }),
                    model, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0,
                });
            } catch { /* recording never affects the run */ }
            return args.messages;
        },
    } as never;
}
