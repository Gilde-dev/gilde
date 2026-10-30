import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { copilotConfig, type CopilotConfig } from '../copilot/copilot.config.js';
import type { ScoutSetup, RefineSetup, PlanSetup } from '../copilot/copilot.mastra.js';
import { scoutConfig, type ScoutConfig } from '../copilot/verkenner.config.js';
import { refineConfig, type RefineConfig } from '../copilot/verfijner.config.js';
import { reviewerConfig, type ReviewerConfig } from '../copilot/reviewer.config.js';
import { planConfig, type PlanConfig } from '../copilot/werkmeester.config.js';
import { UserService } from '../user/user.service.js';

import { AGENT_IDS, AGENT_LABELS, hasModel, isBotAgent, type AgentId } from './agent-ids.js';
import { AgentSettings } from './agent-settings.entity.js';
import { defaultSettings, SETTING_FIELDS, settingsToEnv, validateSettings, type AgentSettingsValues } from './agent-settings.js';
import { agentsDisabled } from './agents-disabled.js';
import type { AgentBotUserDto, AgentStatus } from './agent.dto.js';

export const AGENT_ENV = Symbol('AGENT_ENV');
/** Resolves once the missing settings records are seeded and the first state is resolved. */
export const AGENTS_READY = Symbol('AGENTS_READY');

type AnyConfig = CopilotConfig | ScoutConfig | RefineConfig | PlanConfig | ReviewerConfig;

/** What an agent is right now: its stored settings and the status derived from them, the environment and the users table. */
export interface EffectiveAgent {
    id: AgentId;
    label: string;
    status: AgentStatus;
    reason: string | null;
    enabled: boolean;
    /** The stored model (null follows the co-pilot's). */
    model: string | null;
    /** The model a run uses: the stored one, else the co-pilot's for the bot agents; null where there is none. */
    effectiveModel: string | null;
    botUserId: string | null;
    botUser: AgentBotUserDto | null;
    settings: AgentSettingsValues;
    updatedAt: Date | null;
    /** The parsed configuration (set when status is `on` for the agents with a parser). Internal: never serialised. */
    config: Extract<AnyConfig, { enabled: true }> | null;
}

/** How long a read is reused by the synchronous `peek`-style consumers; every worker tick reads fresh instead. */
const REFRESH_CRON = '0 * * * * *';

/**
 * The single place that decides what an agent is *now*. Every worker tick, run and request asks it instead of reading the
 * environment once at startup, so a changed setting or a newly created bot user is picked up without a restart. The
 * existing `*.config.ts` parsers do the final judgement: the stored settings are rendered as the variables they read.
 * Status precedence: disabled_by_env, off, misconfigured, on.
 */
@Injectable()
export class AgentRuntimeService {
    private readonly logger = new Logger('Agents');
    private readonly disabledByEnv: ReadonlySet<AgentId>;
    private snapshot = new Map<AgentId, EffectiveAgent>();

    constructor(
        @InjectRepository(AgentSettings) private readonly records: Repository<AgentSettings>,
        private readonly users: UserService,
        @Inject(AGENT_ENV) private readonly env: NodeJS.ProcessEnv,
    ) {
        this.disabledByEnv = agentsDisabled(env);
    }

    /** The last resolved state; null before the first read. For synchronous consumers; ticks use `effective`. */
    peek(id: AgentId): EffectiveAgent | null {
        return this.snapshot.get(id) ?? null;
    }

    @Cron(REFRESH_CRON)
    async refreshAll(): Promise<void> {
        try {
            for (const id of AGENT_IDS) await this.effective(id);
        } catch (error) {
            this.logger.warn(`Refreshing the agent settings failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }

    async all(): Promise<EffectiveAgent[]> {
        const rows = new Map((await this.records.find()).map((r) => [r.id, r]));
        const result: EffectiveAgent[] = [];
        for (const id of AGENT_IDS) result.push(await this.resolve(id, rows.get(id) ?? null, rows.get('gilde') ?? null));
        return result;
    }

    async effective(id: AgentId): Promise<EffectiveAgent> {
        const [record, gilde] = await Promise.all([this.records.findOneBy({ id }), id === 'gilde' ? Promise.resolve(null) : this.records.findOneBy({ id: 'gilde' })]);
        return this.resolve(id, record, id === 'gilde' ? record : gilde);
    }

    /** Whether the agent may run right now. Never throws. */
    async isOn(id: AgentId): Promise<boolean> {
        try {
            return (await this.effective(id)).status === 'on';
        } catch {
            return false;
        }
    }

    async copilotConfig(): Promise<Extract<CopilotConfig, { enabled: true }> | null> {
        const agent = await this.effective('gilde');
        return agent.status === 'on' ? (agent.config as Extract<CopilotConfig, { enabled: true }>) : null;
    }

    /** Whether `AGENTS_DISABLED` (read once at startup, like any environment variable) names this agent. */
    isDisabledByEnv(id: AgentId): boolean {
        return this.disabledByEnv.has(id);
    }

    /**
     * What a run needs, resolved per run: the model and the step limit of the agent as it is now. Throws when the agent is
     * not `on` (misconfigured, switched off or disabled by the environment), so such an agent never runs.
     */
    resolver(id: AgentId): () => Promise<{ model: string; maxSteps: number }> {
        return async () => {
            const agent = await this.effective(id);
            const config = agent.config;
            if (agent.status !== 'on' || !config?.enabled) throw new Error(`The ${agent.label} is not on${agent.reason ? `: ${agent.reason}` : ` (${agent.status})`}`);
            return { model: config.model, maxSteps: config.maxSteps ?? SETTING_FIELDS.gilde[0].default };
        };
    }

    /** The scout's configuration and bot user, or null when it is not `on` right now. */
    async scoutSetup(): Promise<ScoutSetup | null> {
        const agent = await this.effective('verkenner');
        return agent.status === 'on' && agent.botUser ? { config: agent.config as Extract<ScoutConfig, { enabled: true }>, user: agent.botUser } : null;
    }

    async refineSetup(): Promise<RefineSetup | null> {
        const agent = await this.effective('verfijner');
        return agent.status === 'on' && agent.botUser ? { config: agent.config as Extract<RefineConfig, { enabled: true }>, user: agent.botUser } : null;
    }

    async planSetup(): Promise<PlanSetup | null> {
        const agent = await this.effective('werkmeester');
        return agent.status === 'on' && agent.botUser ? { config: agent.config as Extract<PlanConfig, { enabled: true }>, user: agent.botUser } : null;
    }

    /**
     * The reviewer's configuration as it is now, read per review (never cached across reviews), or the reason it is not
     * available: `off` (switched off in the settings), `misconfigured` (no model or key, invalid limits) or `disabled_by_env`
     * (AGENTS_DISABLED, including `all`). Never throws.
     */
    async reviewerSetup(): Promise<{ config: Extract<ReviewerConfig, { enabled: true }> } | { config: null; status: Exclude<AgentStatus, 'on'>; reason: string }> {
        try {
            const agent = await this.effective('reviewer');
            if (agent.status === 'on' && agent.config?.enabled) return { config: agent.config as Extract<ReviewerConfig, { enabled: true }> };
            return { config: null, status: agent.status === 'on' ? 'misconfigured' : agent.status, reason: agent.reason ?? 'The reviewer is not available' };
        } catch (error) {
            return { config: null, status: 'misconfigured', reason: `The reviewer settings could not be read: ${error instanceof Error ? error.message : 'unknown error'}` };
        }
    }

    /** The settings of an agent whatever its status (limits of the MCP server and the coding agents). */
    async settingsOf(id: AgentId): Promise<AgentSettingsValues> {
        return (await this.effective(id)).settings;
    }

    private async resolve(id: AgentId, record: AgentSettings | null, gilde: AgentSettings | null): Promise<EffectiveAgent> {
        const checked = record ? validateSettings(id, record.settings) : { values: defaultSettings(id), issues: [] };
        const settings = checked.values;
        const base = {
            id,
            label: AGENT_LABELS[id],
            enabled: record?.enabled ?? false,
            model: record?.model ?? null,
            botUserId: record?.botUserId ?? null,
            settings,
            updatedAt: record?.updatedAt ?? null,
        };
        const fallbackModel = id !== 'gilde' && (isBotAgent(id) || id === 'reviewer') ? (gilde?.model ?? null) : null;
        const effectiveModel = hasModel(id) ? (base.model ?? fallbackModel) : null;
        const done = (status: AgentStatus, reason: string | null, botUser: AgentBotUserDto | null = null, config: EffectiveAgent['config'] = null): EffectiveAgent => {
            const agent: EffectiveAgent = { ...base, effectiveModel, status, reason, botUser, config };
            this.snapshot.set(id, agent);
            return agent;
        };

        if (this.disabledByEnv.has(id)) return done('disabled_by_env', 'AGENTS_DISABLED names this agent');
        if (id === 'mcp' && this.env.MCP_ENABLED !== 'true') return done('disabled_by_env', 'MCP_ENABLED is not "true"');
        if (!record || !record.enabled) return done('off', id === 'reviewer' ? 'The reviewer is switched off in the agent settings' : null);
        if (checked.issues.length > 0) return done('misconfigured', `Invalid settings: ${checked.issues.map((i) => `${i.path.replace('settings.', '')} ${i.message.toLowerCase()}`).join('; ')}`);

        if (id === 'mcp' || id === 'coding') return done('on', null);

        // The agents with a parser: the user checks first (they need the users table), then the parser's own judgement.
        let botUser: AgentBotUserDto | null = null;
        if (isBotAgent(id)) {
            if (!record.botUserId) return done('misconfigured', 'No bot user is chosen');
            const profile = await this.users.findProfile(record.botUserId);
            if (!profile) return done('misconfigured', 'The chosen bot user no longer exists');
            if (!profile.isBot) return done('misconfigured', `${profile.email} is not marked as a bot; mark it with \`user:mark-bot --email ${profile.email}\``);
            botUser = { id: profile.id, name: profile.name, email: profile.email };
        }
        const parsed = this.parse(id, record, gilde, botUser);
        if (!parsed.enabled) return done('misconfigured', this.friendly(id, parsed.reason), botUser);
        return done('on', null, botUser, parsed);
    }

    /** Runs the existing parser on the stored settings rendered as the variables it reads. */
    private parse(id: AgentId, record: AgentSettings, gilde: AgentSettings | null, botUser: AgentBotUserDto | null): AnyConfig {
        const key = this.env.OPENAI_API_KEY ?? '';
        const gildeSteps = gilde ? validateSettings('gilde', gilde.settings).values.maxSteps : undefined;
        const common = { OPENAI_API_KEY: key, COPILOT_MODEL: gilde?.model ?? '', COPILOT_MAX_STEPS: String(gildeSteps ?? SETTING_FIELDS.gilde[0].default) };
        const values = settingsToEnv(id, record.settings);
        switch (id) {
            case 'gilde':
                return copilotConfig({ ...values, COPILOT_MODEL: record.model ?? '', OPENAI_API_KEY: key });
            case 'verkenner':
                return scoutConfig({ ...common, ...values, SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: botUser?.email ?? '', SCOUT_MODEL: record.model ?? '' });
            case 'verfijner':
                return refineConfig({ ...common, ...values, REFINE_ENABLED: 'true', REFINE_USER_EMAIL: botUser?.email ?? '', REFINE_MODEL: record.model ?? '' });
            case 'reviewer':
                return reviewerConfig({ ...common, ...values, REVIEWER_ENABLED: 'true', REVIEWER_MODEL: record.model ?? '' });
            default:
                return planConfig({ ...common, ...values, PLAN_ENABLED: 'true', PLAN_USER_EMAIL: botUser?.email ?? '', PLAN_MODEL: record.model ?? '' });
        }
    }

    /** The parser speaks of environment variables; the page speaks of settings. Never contains a secret value. */
    private friendly(id: AgentId, reason: string): string {
        const names = new Map<string, string>([
            ['COPILOT_MODEL', 'The co-pilot model'], ['SCOUT_MODEL', 'The model'], ['REFINE_MODEL', 'The model'], ['PLAN_MODEL', 'The model'], ['REVIEWER_MODEL', 'The model'],
            ...SETTING_FIELDS[id].map((f) => [f.env, f.label] as [string, string]),
        ]);
        return reason
            .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (name) => names.get(name) ?? name)
            .replace('The model (or The co-pilot model) is not set', 'No model is set (neither for this agent nor for the co-pilot)')
            .replace('The co-pilot model is not set', 'No model is set');
    }
}
