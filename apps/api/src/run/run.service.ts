import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AgentRunRecorder } from '../agent-run/agent-run.recorder.js';
import { isUniqueViolation } from '../common/db-errors.js';
import type { CreateRunDto, RunResponseDto } from './run.dto.js';
import { toOperatorActionDtos, type OperatorActionStateDto } from './operator-actions.js';
import type { RunContext } from './run-context.js';
import type { RunKnowledge } from './run-knowledge.js';
import { JobRun } from './run.entity.js';
import { RunMapper } from './run.mapper.js';

@Injectable()
export class RunService {
    private readonly logger = new Logger(RunService.name);

    constructor(
        private readonly runMapper: RunMapper,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
        @Optional() private readonly agentRuns?: AgentRunRecorder,
    ) { }

    /** Starts the run log entry of a job run (the coding agent's run); it ends with the job run. Never throws. */
    logStart(run: { id: string; jobId: string; projectId: string }, actorUserId: string | null): void {
        this.agentRuns?.begin({
            agentId: 'coding', triggerKind: 'dispatch', triggerRefType: 'job', triggerRefId: run.jobId,
            actorUserId, projectId: run.projectId, linkedTable: 'job_runs', linkedId: run.id, managed: true,
        });
    }

    async create(dto: CreateRunDto, actorUserId: string | null = null): Promise<RunResponseDto> {
        try {
            const entity = await this.runRepository.save(
                this.runRepository.create({ ...dto, status: 'firing' }),
            );
            this.logStart(entity, actorUserId);
            return this.runMapper.toDTO(entity);
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`Job ${dto.jobId} already has a run for attempt ${dto.attempt}`);
            throw e;
        }
    }

    async markFired(id: string, session: { sessionId: string; sessionUrl: string; instructionsVersion?: string | null }): Promise<void> {
        const { instructionsVersion = null, ...rest } = session;
        await this.runRepository.update({ id }, { status: 'fired', ...rest, instructionsVersion, firedAt: new Date() });
    }

    /** Records what the agent had; the capture itself never throws, and a failed write must not stop the fire. */
    async recordContext(id: string, capture: { context: RunContext | null; contextError: string | null }): Promise<void> {
        await this.runRepository.update({ id }, { context: capture.context, contextError: capture.contextError });
    }

    /** Which MCP servers put snippets in the prompt of this run, and how much text. */
    async recordKnowledge(id: string, knowledge: RunKnowledge[]): Promise<void> {
        await this.runRepository.update({ id }, { knowledge });
    }

    async markFailed(id: string, error: string): Promise<void> {
        await this.runRepository.update({ id }, { status: 'fire_failed', error, finishedAt: new Date() });
        await this.agentRuns?.endLinked('job_runs', id, { outcome: 'error', reason: error });
    }

    /** One run, or null when the id is unknown. */
    async findById(id: string): Promise<RunResponseDto | null> {
        const entity = await this.runRepository.findOneBy({ id });
        return entity ? this.runMapper.toDTO(entity) : null;
    }

    async listForJob(jobId: string): Promise<RunResponseDto[]> {
        const entities = await this.runRepository.find({ where: { jobId }, order: { attempt: 'ASC' } });
        return entities.map((e) => this.runMapper.toDTO(e));
    }

    /** The operator actions of each job's latest run (by attempt); jobs whose latest run has none are absent. */
    async latestOperatorActions(jobIds: string[]): Promise<Map<string, OperatorActionStateDto[]>> {
        const out = new Map<string, OperatorActionStateDto[]>();
        if (!jobIds.length) return out;
        const runs = await this.runRepository.find({
            where: { jobId: In(jobIds) },
            select: { id: true, jobId: true, attempt: true, createdAt: true, operatorActions: true },
            order: { attempt: 'DESC', createdAt: 'DESC' },
        });
        const seen = new Set<string>();
        for (const r of runs) {
            if (seen.has(r.jobId)) continue;
            seen.add(r.jobId);
            if (r.operatorActions?.length) out.set(r.jobId, toOperatorActionDtos(r.operatorActions));
        }
        return out;
    }

    /**
     * Marks action `index` of the job's latest run done by `userId`. Idempotent: an action already done keeps its first
     * `doneAt` and `doneById`. Never touches the job's status. Null when there is no such action.
     */
    async markOperatorActionDone(jobId: string, index: number, userId: string): Promise<boolean> {
        return this.runRepository.manager.transaction(async (m) => {
            const repo = m.getRepository(JobRun);
            const latest = await repo.findOne({ where: { jobId }, order: { attempt: 'DESC', createdAt: 'DESC' } });
            const action = latest?.operatorActions?.[index];
            if (!latest || !action) return false;
            if (!action.doneAt) {
                const next = latest.operatorActions!.map((a, i) => (i === index ? { ...a, doneAt: new Date().toISOString(), doneById: userId } : a));
                await repo.update({ id: latest.id }, { operatorActions: next });
                this.logger.log(`Operator action ${index} of run ${latest.id} (job ${jobId}) marked done by user ${userId}`);
            }
            return true;
        });
    }

}
