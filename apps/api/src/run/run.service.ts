import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import type { CreateRunDto, RunResponseDto } from './run.dto.js';
import type { RunContext } from './run-context.js';
import type { RunKnowledge } from './run-knowledge.js';
import { JobRun } from './run.entity.js';
import { RunMapper } from './run.mapper.js';

@Injectable()
export class RunService {

    constructor(
        private readonly runMapper: RunMapper,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
    ) { }

    async create(dto: CreateRunDto): Promise<RunResponseDto> {
        try {
            const entity = await this.runRepository.save(
                this.runRepository.create({ ...dto, status: 'firing' }),
            );
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

}
