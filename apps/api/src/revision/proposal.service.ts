import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Job } from '../job/job.entity.js';
import { JobRun } from '../run/run.entity.js';
import type { GildeProposal } from '../webhook/pr-body.js';
import { NotificationCaptureService } from '../notification/notification-capture.service.js';
import { JobRevision } from './revision.entity.js';

const OPEN: readonly string[] = ['triage', 'queued'];

/** Turns the gilde-proposals block of a PR body into proposed revisions. */
@Injectable()
export class ProposalService {
    private readonly logger = new Logger(ProposalService.name);

    constructor(
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(JobRevision) private readonly revisions: Repository<JobRevision>,
        @Optional() private readonly capture?: NotificationCaptureService,
    ) { }

    /**
     * Records the run's proposals. Re-parsing replaces the run's still-proposed revisions; entries whose job
     * already has a decided revision from this run are not proposed again. Targets must be in the PR job's project
     * and not started yet, unless they are the PR's own job.
     */
    async record(run: JobRun, prJob: Job, proposals: GildeProposal[], error: string | null): Promise<void> {
        await this.runs.update({ id: run.id }, { proposalsError: error });
        await this.revisions.delete({ sourceRunId: run.id, status: 'proposed' });
        if (!proposals.length) return;

        const decided = new Set(
            (await this.revisions.find({ where: { sourceRunId: run.id } })).map((r) => r.jobId),
        );
        for (const p of proposals) {
            if (decided.has(p.jobId)) continue;
            const target = await this.jobs.findOneBy({ id: p.jobId });
            if (!target || target.projectId !== prJob.projectId) {
                this.logger.log(`Run ${run.id}: ignoring proposal for job ${p.jobId}, not in the project`);
                continue;
            }
            if (target.id !== prJob.id && !OPEN.includes(target.status)) {
                this.logger.log(`Run ${run.id}: ignoring proposal for job ${p.jobId}, it is ${target.status}`);
                continue;
            }
            await this.revisions.save(this.revisions.create({
                jobId: target.id,
                title: p.title ?? null,
                task: p.task ?? null,
                acceptanceCriteria: p.acceptanceCriteria ?? null,
                dependsOn: p.dependsOn ?? null,
                reason: p.reason,
                sourceRunId: run.id,
            }));
            await this.capture?.revisionWaiting(run, prJob, target, p);
        }
    }

}
