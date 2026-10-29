import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ExecutionError } from '../execution/execution.error.js';
import { EXECUTION_PORT, type ExecutionPort } from '../execution/execution.port.js';
import { loadDownstreamContext } from '../execution/downstream.js';
import { selectJobLessons } from '../execution/job-lessons.js';
import { buildJobPromptInput } from '../execution/job-payload.js';
import { Feature } from '../feature/feature.entity.js';
import { HistorySearchService } from '../memory/history/history-search.service.js';
import { ProjectMcpKnowledgeService } from '../project-mcp/project-mcp-knowledge.service.js';
import { Repo } from '../repo/repo.entity.js';
import type { JobPromptResponseDto } from './job.dto.js';
import { Job } from './job.entity.js';

/** Run id shown in a preview: the real run only exists once the job is fired. */
const PREVIEW_RUN_ID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class JobPromptService {

    constructor(
        @Inject(EXECUTION_PORT) private readonly execution: ExecutionPort,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
        @InjectRepository(Feature) private readonly featureRepository: Repository<Feature>,
        private readonly history: HistorySearchService,
        @Optional() private readonly knowledgeService?: ProjectMcpKnowledgeService,
    ) { }

    /** The exact text the next fire of this job would send, with its size and trimming. Reads only; an oversized result is returned for inspection. */
    async get(id: string): Promise<JobPromptResponseDto> {
        const job = await this.jobRepository.findOneBy({ id });
        if (!job) throw new NotFoundException(`Job ${id} not found`);
        const repo = await this.repoRepository.findOneByOrFail({ id: job.repoId });
        const feature = job.featureId ? await this.featureRepository.findOneBy({ id: job.featureId }) : null;
        const lessons = await selectJobLessons(this.history, { ...job, stacks: repo.stacks });
        // Like at dispatch: never throws, and a failing server only means no snippets from it.
        const knowledge = (await this.knowledgeService?.collect(job.projectId, job)) ?? null;
        try {
            const { payload, context } = buildJobPromptInput(job, repo, feature, PREVIEW_RUN_ID, job.attempts + 1, await loadDownstreamContext(this.jobRepository.manager, job), lessons, knowledge);
            const { text, instructionsVersion, length, limit, trimmed } = this.execution.prepare(payload, context);
            return { text, instructionsVersion, length, limit, trimmed };
        } catch (e) {
            if (e instanceof ExecutionError) throw new BadRequestException(e.message);
            throw e;
        }
    }

}
