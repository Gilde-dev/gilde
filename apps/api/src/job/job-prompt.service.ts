import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ExecutionError } from '../execution/execution.error.js';
import { EXECUTION_PORT, type ExecutionPort } from '../execution/execution.port.js';
import { buildJobPayload } from '../execution/job-payload.js';
import { Feature } from '../feature/feature.entity.js';
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
    ) { }

    /** The exact text the next fire of this job would send. Reads only. */
    async get(id: string): Promise<JobPromptResponseDto> {
        const job = await this.jobRepository.findOneBy({ id });
        if (!job) throw new NotFoundException(`Job ${id} not found`);
        const repo = await this.repoRepository.findOneByOrFail({ id: job.repoId });
        const feature = job.featureId ? await this.featureRepository.findOneBy({ id: job.featureId }) : null;
        try {
            const { text, instructionsVersion } = this.execution.preview(
                buildJobPayload(job, repo, feature, PREVIEW_RUN_ID, job.attempts + 1),
            );
            return { text, instructionsVersion };
        } catch (e) {
            if (e instanceof ExecutionError) throw new BadRequestException(e.message);
            throw e;
        }
    }

}
