import type { AgentRuntimeService, EffectiveAgent } from '../agent/agent-runtime.service.js';
import { defaultSettings } from '../agent/agent-settings.js';
import type { AgentId } from '../agent/agent-ids.js';

import type { CopilotUser } from './copilot.context.js';
import type { PlanSetup, RefineSetup, ScoutSetup } from './copilot.mastra.js';
import { DEFAULT_COPILOT_MAX_STEPS } from './copilot.config.js';

/**
 * Live views of the agents' setups. The Mastra agents, the signal service and the other collaborators are built once at
 * startup, but they hold these objects, whose properties are read at the moment of use from the latest resolved state of
 * `AgentRuntimeService` (refreshed on every settings change and every minute, and by every worker tick). So a changed
 * limit, model or bot user takes effect without a restart. While an agent is not on, the view carries its settings with an
 * empty bot user id; nothing acts on that (every run is refused by `resolve`, workers and sinks check the status first).
 */
const NO_USER = '';

/** The bot user of an agent as it is now. Its `id` is empty while the agent is not on. */
export function liveBotUser(runtime: Pick<AgentRuntimeService, 'peek'>, id: AgentId): CopilotUser {
    const current = () => {
        const agent = runtime.peek(id);
        return agent?.status === 'on' ? agent.botUser : null;
    };
    return {
        get id() { return current()?.id ?? NO_USER; },
        get name() { return current()?.name; },
        get email() { return current()?.email; },
    };
}

export function isOn(runtime: Pick<AgentRuntimeService, 'peek'>, id: AgentId): boolean {
    return runtime.peek(id)?.status === 'on';
}

function settingsOf(runtime: Pick<AgentRuntimeService, 'peek'>, id: AgentId) {
    return { ...defaultSettings(id), ...runtime.peek(id)?.settings };
}

function baseOf(runtime: Pick<AgentRuntimeService, 'peek'>, agent: EffectiveAgent | null) {
    return {
        model: agent?.effectiveModel ?? '',
        userEmail: agent?.botUser?.email ?? '',
        maxSteps: runtime.peek('gilde')?.settings.maxSteps ?? DEFAULT_COPILOT_MAX_STEPS,
    };
}

export function liveScoutSetup(runtime: Pick<AgentRuntimeService, 'peek' | 'resolver'>): ScoutSetup {
    return {
        get config() {
            const s = settingsOf(runtime, 'verkenner');
            return { enabled: true as const, ...baseOf(runtime, runtime.peek('verkenner')), summaryHourUtc: s.summaryHourUtc, maxWakesPerDay: s.maxWakesPerDay, dailySuggestions: s.dailySuggestions, patternMinSize: s.patternMinSize };
        },
        user: liveBotUser(runtime, 'verkenner'),
        resolve: runtime.resolver('verkenner'),
    };
}

export function liveRefineSetup(runtime: Pick<AgentRuntimeService, 'peek' | 'resolver'>): RefineSetup {
    return {
        get config() {
            return { enabled: true as const, ...baseOf(runtime, runtime.peek('verfijner')), dailyLimit: settingsOf(runtime, 'verfijner').dailyLimit };
        },
        user: liveBotUser(runtime, 'verfijner'),
        resolve: runtime.resolver('verfijner'),
    };
}

export function livePlanSetup(runtime: Pick<AgentRuntimeService, 'peek' | 'resolver'>): PlanSetup {
    return {
        get config() {
            return { enabled: true as const, ...baseOf(runtime, runtime.peek('werkmeester')), dailyLimit: settingsOf(runtime, 'werkmeester').dailyLimit };
        },
        user: liveBotUser(runtime, 'werkmeester'),
        resolve: runtime.resolver('werkmeester'),
    };
}

/** `base` with more properties, keeping its getters live (a spread would freeze them). */
export function extend<T extends object, U extends object>(base: T, extra: U): T & U {
    return Object.defineProperties(extra, Object.getOwnPropertyDescriptors(base)) as T & U;
}
