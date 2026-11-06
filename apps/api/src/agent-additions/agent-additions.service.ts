import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { ProjectService } from '../project/project.service.js';
import { UserService } from '../user/user.service.js';

import { agentInstructionsMaxChars } from './agent-additions.config.js';
import type { AgentInstructionDto, AgentInstructionVersionDto, AgentInstructionsDto, ReplaceAgentInstructionDto } from './agent-additions.dto.js';
import {
    ADDITION_AGENT_IDS, PROMPT_PROVENANCE_KEY, additionBlock, promptVersion, withAddition,
    type AdditionAgentId, type PromptProvenance,
} from './agent-additions.render.js';
import { ProjectAgentInstructionVersion } from './project-agent-instruction-version.entity.js';
import { ProjectAgentInstruction } from './project-agent-instruction.entity.js';

/** An addition as the agent's prompt gets it. */
export interface ResolvedAddition { version: number; text: string; projectName: string; block: string }

export interface AppliedInstructions {
    /** The full instructions: the unchanged base, then the addition block when there is one. */
    text: string;
    /** Null when there is no addition. */
    additionVersion: number | null;
    promptVersion: string;
}

type Ctx = { get?(key: string): unknown; set?(key: string, value: unknown): void } | undefined;

/**
 * Per-project, per-agent additional instructions (admin-written, versioned). The base instructions stay in code and always
 * win: an addition is only appended, as a delimited block, to the prompt of a run in that project. It has no way to reach
 * tools, allowlists, bindings or limits: this service only produces text.
 */
@Injectable()
export class AgentAdditionsService {
    private readonly logger = new Logger('AgentAdditions');

    constructor(
        @InjectRepository(ProjectAgentInstruction) private readonly current: Repository<ProjectAgentInstruction>,
        @InjectRepository(ProjectAgentInstructionVersion) private readonly versions: Repository<ProjectAgentInstructionVersion>,
        private readonly dataSource: DataSource,
        private readonly users: UserService,
        private readonly projects: ProjectService,
    ) { }

    /** All five agents of a project; an agent without an addition has empty text and version 0. */
    async list(projectId: string): Promise<AgentInstructionsDto> {
        await this.projects.getById(projectId);
        const rows = await this.current.find({ where: { projectId } });
        const byAgent = new Map(rows.map((r) => [r.agentId, r]));
        const agents: AgentInstructionDto[] = [];
        for (const agentId of ADDITION_AGENT_IDS) agents.push(await this.toDto(agentId, byAgent.get(agentId)));
        return { projectId, maxChars: agentInstructionsMaxChars(), agents };
    }

    /** Full replacement; admins only. Empty text removes the addition. A change increments the version and keeps the old one. */
    async replace(user: AuthUser | undefined, projectId: string, agentId: AdditionAgentId, dto: ReplaceAgentInstructionDto): Promise<AgentInstructionDto> {
        const admin = await this.users.requireAdmin(user);
        await this.projects.getById(projectId);
        const text = dto.text.trim();
        const max = agentInstructionsMaxChars();
        if (text.length > max) throw new BadRequestException({ message: 'Validation failed', issues: [{ path: 'text', message: `At most ${max} characters (now ${text.length})` }] });

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const saved = await this.dataSource.transaction(async (manager) => {
                    const repo = manager.getRepository(ProjectAgentInstruction);
                    const existing = await repo.findOneBy({ projectId, agentId });
                    if (!existing && text === '') return null;
                    if (existing && existing.text === text) return existing;
                    const now = new Date();
                    if (!existing) return repo.save(repo.create({ projectId, agentId, text, version: 1, updatedById: admin.id, updatedAt: now }));
                    await manager.getRepository(ProjectAgentInstructionVersion).insert({
                        projectId, agentId, version: existing.version, text: existing.text, updatedById: existing.updatedById, updatedAt: existing.updatedAt,
                    });
                    // Guarded by the version read above: a concurrent change makes this update match no row.
                    const result = await repo.update({ id: existing.id, version: existing.version }, { text, version: existing.version + 1, updatedById: admin.id, updatedAt: now });
                    if (!result.affected) throw new Error('concurrent change');
                    return repo.findOneByOrFail({ id: existing.id });
                });
                if (saved) this.logger.log(`${admin.id} set ${agentId} instructions of project ${projectId} to version ${saved.version}${saved.text === '' ? ' (removed)' : ''}`);
                return this.toDto(agentId, saved ?? undefined);
            } catch (error) {
                if (attempt === 0 && (isUniqueViolation(error) || (error instanceof Error && error.message === 'concurrent change'))) continue;
                throw error;
            }
        }
        throw new BadRequestException('The instructions were changed by someone else; reload and try again');
    }

    /** Every version of one agent's addition, newest first: the current one and all replaced ones. */
    async history(projectId: string, agentId: AdditionAgentId): Promise<AgentInstructionVersionDto[]> {
        await this.projects.getById(projectId);
        const current = await this.current.findOneBy({ projectId, agentId });
        const old = await this.versions.find({ where: { projectId, agentId }, order: { version: 'DESC' } });
        const rows = [...(current ? [{ ...current, isCurrent: true }] : []), ...old.map((v) => ({ ...v, isCurrent: false }))];
        const out: AgentInstructionVersionDto[] = [];
        for (const r of rows) {
            out.push({ version: r.version, text: r.text, current: r.isCurrent, updatedAt: r.updatedAt.toISOString(), updatedBy: await this.userRef(r.updatedById) });
        }
        return out.sort((a, b) => b.version - a.version);
    }

    /** The addition of an agent for a run in this project; null without a project, without an addition or when it cannot be read. Never throws. */
    async resolve(projectId: string | null | undefined, agentId: AdditionAgentId): Promise<ResolvedAddition | null> {
        if (!projectId) return null;
        try {
            const row = await this.current.findOneBy({ projectId, agentId });
            if (!row || row.text.trim() === '') return null;
            const project = await this.projects.getById(projectId);
            return { version: row.version, text: row.text, projectName: project.name, block: additionBlock(project.name, row.text) };
        } catch (error) {
            // Without the addition the agent still has its full base instructions.
            this.logger.warn(`Reading the ${agentId} instructions of project ${projectId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
            return null;
        }
    }

    /** The agent's instructions for a run: the unchanged base followed by the project's addition, if any. */
    async apply(base: string, agentId: AdditionAgentId, projectId: string | null | undefined): Promise<AppliedInstructions> {
        const addition = await this.resolve(projectId, agentId);
        const text = withAddition(base, addition?.block ?? null);
        return { text, additionVersion: addition?.version ?? null, promptVersion: promptVersion(text) };
    }

    private async toDto(agentId: AdditionAgentId, row: ProjectAgentInstruction | undefined): Promise<AgentInstructionDto> {
        if (!row) return { agentId, text: '', version: 0, updatedAt: null, updatedBy: null };
        return { agentId, text: row.text, version: row.version, updatedAt: row.updatedAt.toISOString(), updatedBy: await this.userRef(row.updatedById) };
    }

    private async userRef(id: string) {
        const profile = await this.users.findProfile(id);
        return { id, name: profile?.name ?? null, email: profile?.email ?? null };
    }
}

/**
 * The instructions of one run, for the agents built in code. Resolves the addition for the run's project, remembers the
 * provenance in the request context (the run log reads it) and never throws: on any failure the base is used unchanged.
 */
export async function runInstructions(
    base: string, agentId: AdditionAgentId, projectId: string | null | undefined, ctx: Ctx,
    additions: Pick<AgentAdditionsService, 'apply'> | undefined,
): Promise<string> {
    let applied: AppliedInstructions = { text: base, additionVersion: null, promptVersion: promptVersion(base) };
    try {
        if (additions) applied = await additions.apply(base, agentId, projectId);
    } catch { /* the base alone */ }
    try {
        const provenance: PromptProvenance = { additionVersion: applied.additionVersion, promptVersion: applied.promptVersion };
        ctx?.set?.(PROMPT_PROVENANCE_KEY, provenance);
    } catch { /* provenance is best effort */ }
    return applied.text;
}
