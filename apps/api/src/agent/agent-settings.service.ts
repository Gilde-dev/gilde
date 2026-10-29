import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { UserService } from '../user/user.service.js';

import { AgentRuntimeService, AGENT_ENV, type EffectiveAgent } from './agent-runtime.service.js';
import { AGENT_IDS, hasModel, isBotAgent, type AgentId } from './agent-ids.js';
import { AgentSettingsAudit } from './agent-settings-audit.entity.js';
import { AgentSettings } from './agent-settings.entity.js';
import { isValidModel, SETTING_FIELDS, seedValue, validateSettings, type AgentSettingsValues, type SettingsIssue } from './agent-settings.js';
import type { AgentAuditEntryDto, AgentBotUserDto, ReplaceAgentSettingsDto } from './agent.dto.js';
import { COPILOT_MODEL_PREFIX } from '../copilot/copilot.config.js';

/** The environment variables that switch a bot agent on and name its bot user and model (seed values only). */
const BOT_ENV: Record<'verkenner' | 'verfijner' | 'werkmeester', { enabled: string; email: string; model: string }> = {
    verkenner: { enabled: 'SCOUT_ENABLED', email: 'SCOUT_USER_EMAIL', model: 'SCOUT_MODEL' },
    verfijner: { enabled: 'REFINE_ENABLED', email: 'REFINE_USER_EMAIL', model: 'REFINE_MODEL' },
    werkmeester: { enabled: 'PLAN_ENABLED', email: 'PLAN_USER_EMAIL', model: 'PLAN_MODEL' },
};

/** Agents whose invalid numeric environment value turned them off before (fail closed); the others took the default. */
const FAIL_CLOSED: ReadonlySet<AgentId> = new Set(['verkenner', 'verfijner', 'werkmeester', 'mcp']);

/**
 * Stores the runtime settings of the agents. On startup an agent without a record gets one from the current environment
 * (resolving `*_USER_EMAIL` to the user id); an existing record is never overwritten from the environment. Changes come
 * from verified humans only, replace the whole record, are validated per agent and audited field by field.
 */
@Injectable()
export class AgentSettingsService {
    private readonly logger = new Logger('Agents');

    constructor(
        @InjectRepository(AgentSettings) private readonly records: Repository<AgentSettings>,
        @InjectRepository(AgentSettingsAudit) private readonly audit: Repository<AgentSettingsAudit>,
        private readonly dataSource: DataSource,
        private readonly users: UserService,
        private readonly runtime: AgentRuntimeService,
        @Inject(AGENT_ENV) private readonly env: NodeJS.ProcessEnv,
    ) { }

    /** Creates the missing records from the environment. Returns the ids it created. */
    async seed(): Promise<AgentId[]> {
        const existing = new Set((await this.records.find({ select: { id: true } })).map((r) => r.id));
        const created: AgentId[] = [];
        for (const id of AGENT_IDS) {
            if (existing.has(id)) continue;
            try {
                await this.records.insert(await this.fromEnv(id));
                created.push(id);
            } catch (error) {
                if (!isUniqueViolation(error)) throw error; // another instance seeded it first
            }
        }
        if (created.length > 0) this.logger.log(`Seeded the settings of ${created.join(', ')} from the environment.`);
        return created;
    }

    private async fromEnv(id: AgentId): Promise<Partial<AgentSettings>> {
        const env = this.env;
        const settings: AgentSettingsValues = {};
        let invalid = false;
        for (const field of SETTING_FIELDS[id]) {
            const seeded = seedValue(field, env[field.env]);
            settings[field.key] = seeded.value;
            if (seeded.invalid) {
                invalid = true;
                this.logger.warn(`${field.env} is invalid; seeding ${id} with the default ${field.default}${FAIL_CLOSED.has(id) ? ' and switched off' : ''}.`);
            }
        }
        const closed = invalid && FAIL_CLOSED.has(id);

        if (id === 'gilde') {
            const model = env.COPILOT_MODEL?.trim() || null;
            return { id, enabled: model !== null, botUserId: null, model, settings };
        }
        if (isBotAgent(id)) {
            const names = BOT_ENV[id];
            const email = env[names.email]?.trim();
            let botUserId: string | null = null;
            if (email) {
                botUserId = (await this.users.findByEmail(email).catch(() => null))?.id ?? null;
                if (!botUserId) this.logger.warn(`${names.email} does not match an existing user; ${id} is seeded without a bot user.`);
            }
            return { id, enabled: env[names.enabled]?.trim() === 'true' && !closed, botUserId, model: env[names.model]?.trim() || null, settings };
        }
        // The MCP server's on/off switch is MCP_ENABLED, which stays environment-only and is a ceiling; the coding agents have none.
        return { id, enabled: !closed, botUserId: null, model: null, settings };
    }

    async list(): Promise<EffectiveAgent[]> {
        return this.runtime.all();
    }

    async get(id: AgentId): Promise<EffectiveAgent> {
        return this.runtime.effective(id);
    }

    async botUsers(): Promise<AgentBotUserDto[]> {
        return (await this.users.listBots()).map(({ id, name, email }) => ({ id, name, email }));
    }

    /** Full replacement; verified humans only. Field errors are a 400 with `issues`; every changed field is audited. */
    async replace(user: AuthUser | undefined, id: AgentId, dto: ReplaceAgentSettingsDto): Promise<EffectiveAgent> {
        const human = await this.users.requireVerifiedHuman(user);
        const record = await this.records.findOneBy({ id });
        if (!record) throw new NotFoundException(`Agent ${id} has no settings yet`);

        const { values, issues } = validateSettings(id, dto.settings);
        issues.push(...(await this.checkIdentity(id, dto)));
        if (issues.length > 0) throw new BadRequestException({ message: 'Validation failed', issues });

        const next = { enabled: dto.enabled, botUserId: dto.botUserId, model: dto.model || null, settings: values };
        const changes = this.diff(record, next);
        if (changes.length === 0) return this.runtime.effective(id);

        await this.dataSource.transaction(async (manager) => {
            await manager.getRepository(AgentSettings).update({ id }, { ...next, updatedById: human.id });
            await manager.getRepository(AgentSettingsAudit).insert(changes.map((c) => ({ agent: id, changedById: human.id, ...c })));
        });
        await this.runtime.refreshAll();
        return this.runtime.effective(id);
    }

    async auditOf(id: AgentId, limit = 100): Promise<AgentAuditEntryDto[]> {
        const rows = await this.audit.find({ where: { agent: id }, order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
        const profiles = new Map<string, AgentAuditEntryDto['changedBy']>();
        for (const userId of new Set(rows.map((r) => r.changedById))) {
            const profile = await this.users.findProfile(userId);
            profiles.set(userId, profile ? { id: profile.id, name: profile.name, email: profile.email } : { id: userId, name: null, email: null });
        }
        return rows.map((r) => ({ id: r.id, agent: r.agent, field: r.field, oldValue: r.oldValue, newValue: r.newValue, changedBy: profiles.get(r.changedById)!, createdAt: r.createdAt.toISOString() }));
    }

    private async checkIdentity(id: AgentId, dto: ReplaceAgentSettingsDto): Promise<SettingsIssue[]> {
        const issues: SettingsIssue[] = [];
        if (isBotAgent(id)) {
            if (dto.botUserId) {
                const profile = await this.users.findProfile(dto.botUserId);
                if (!profile) issues.push({ path: 'botUserId', message: 'This user does not exist' });
                else if (!profile.isBot) issues.push({ path: 'botUserId', message: 'Choose a user that is marked as a bot' });
            } else if (dto.enabled) issues.push({ path: 'botUserId', message: 'Choose a bot user to switch this agent on' });
        } else if (dto.botUserId !== null) issues.push({ path: 'botUserId', message: 'This agent has no bot user' });

        if (hasModel(id)) {
            if (dto.model && !isValidModel(dto.model)) issues.push({ path: 'model', message: `Must be an OpenAI model id in the form ${COPILOT_MODEL_PREFIX}<model>` });
            if (!dto.model && dto.enabled && id === 'gilde') issues.push({ path: 'model', message: 'Set a model to switch the co-pilot on' });
        } else if (dto.model) issues.push({ path: 'model', message: 'This agent has no model' });

        if (id === 'coding' && !dto.enabled) issues.push({ path: 'enabled', message: 'Coding agents are switched off per executor' });
        return issues;
    }

    private diff(record: AgentSettings, next: { enabled: boolean; botUserId: string | null; model: string | null; settings: AgentSettingsValues }) {
        const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
        const note = (field: string, before: unknown, after: unknown) => {
            if (before !== after) changes.push({ field, oldValue: before === null || before === undefined ? null : JSON.stringify(before), newValue: after === null || after === undefined ? null : JSON.stringify(after) });
        };
        note('enabled', record.enabled, next.enabled);
        note('botUserId', record.botUserId, next.botUserId);
        note('model', record.model, next.model);
        for (const field of SETTING_FIELDS[record.id]) note(`settings.${field.key}`, record.settings[field.key], next.settings[field.key]);
        return changes;
    }
}
