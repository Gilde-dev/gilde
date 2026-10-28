import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';

import { Job } from '../job/job.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';
import { ProjectService } from '../project/project.service.js';
import { JobRevision } from '../revision/revision.entity.js';
import { JobRun } from '../run/run.entity.js';

import { classifyRun } from './run-outcome.js';
import { computeSkillImpact, type ImpactRun } from './skill-impact.js';
import { SKILL_IMPACT_CONFIG, type SkillImpactConfig } from './skill-impact.config.js';
import { SKILL_IMPACT_DEFAULT_DAYS, type SkillImpactResponseDto } from './skill-impact.dto.js';

const DAY_MS = 86_400_000;
const CHUNK = 500;
/** Attempts that never started an agent carry no information about what the agent had. */
const NEVER_RAN = ['firing', 'fire_failed'] as const;

@Injectable()
export class SkillImpactService {
    constructor(
        private readonly projects: ProjectService,
        @Inject(SKILL_IMPACT_CONFIG) private readonly config: SkillImpactConfig,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRevision) private readonly revisions: Repository<JobRevision>,
        @InjectRepository(AgentUsage) private readonly usage: Repository<AgentUsage>,
    ) { }

    /** Descriptive outcomes per skill version for the runs of one project in the last `days` days. */
    async impact(projectId: string, days: number = SKILL_IMPACT_DEFAULT_DAYS, now: Date = new Date()): Promise<SkillImpactResponseDto> {
        await this.projects.assertExists(projectId);
        const since = new Date(now.getTime() - days * DAY_MS);
        const rows = (await this.runs.find({
            where: { projectId, createdAt: MoreThanOrEqual(since), context: Not(IsNull()) },
            select: { id: true, jobId: true, repoId: true, attempt: true, status: true, result: true, ciConclusion: true, context: true, createdAt: true },
        })).filter((r) => r.context && !(NEVER_RAN as readonly string[]).includes(r.status));

        const jobIds = [...new Set(rows.map((r) => r.jobId))];
        const jobs = new Map<string, Job>();
        const latest = new Map<string, number>();
        const rounds = new Map<string, number>();
        for (const ids of chunks(jobIds)) {
            for (const j of await this.jobs.find({ where: { id: In(ids) }, select: { id: true, status: true, mergedBlocked: true } })) jobs.set(j.id, j);
            // A later attempt may be missing from `rows` (no context, or never ran), so ask for the highest real attempt.
            const attempts = await this.runs.createQueryBuilder('r')
                .select('r.jobId', 'jobId').addSelect('MAX(r.attempt)', 'attempt')
                .where('r.jobId IN (:...ids)', { ids }).andWhere('r.status NOT IN (:...never)', { never: NEVER_RAN })
                .groupBy('r.jobId').getRawMany<{ jobId: string; attempt: number | string }>();
            for (const a of attempts) latest.set(a.jobId, Number(a.attempt));
            const accepted = await this.revisions.createQueryBuilder('v')
                .select('v.jobId', 'jobId').addSelect('COUNT(*)', 'n')
                .where('v.jobId IN (:...ids)', { ids }).andWhere("v.status = 'accepted'")
                .groupBy('v.jobId').getRawMany<{ jobId: string; n: number | string }>();
            for (const a of accepted) rounds.set(a.jobId, Number(a.n));
        }

        const tokens = new Map<string, { tokens: number; cost: number | null }>();
        for (const ids of chunks(rows.map((r) => r.id))) {
            const sums = await this.usage.createQueryBuilder('u')
                .select('u.runId', 'runId')
                .addSelect('SUM(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens)', 'tokens')
                .addSelect('SUM(u.costUsd)', 'cost')
                .where('u.runId IN (:...ids)', { ids }).groupBy('u.runId')
                .getRawMany<{ runId: string; tokens: number | string; cost: number | string | null }>();
            for (const s of sums) tokens.set(s.runId, { tokens: Number(s.tokens), cost: s.cost === null ? null : Number(s.cost) });
        }

        const impactRuns: ImpactRun[] = rows.map((r) => {
            const job = jobs.get(r.jobId);
            const usage = tokens.get(r.id);
            return {
                repoId: r.repoId,
                createdAt: r.createdAt,
                skills: r.context!.skills,
                outcome: job ? classifyRun({
                    attempt: r.attempt,
                    resultOutcome: r.result?.outcome ?? null,
                    ciConclusion: r.ciConclusion,
                    jobStatus: job.status,
                    jobMergedBlocked: job.mergedBlocked,
                    revisionRounds: rounds.get(r.jobId) ?? 0,
                    latestAttempt: latest.get(r.jobId) ?? r.attempt,
                    tokens: usage?.tokens ?? null,
                    costUsd: usage?.cost ?? null,
                }) : null,
            };
        });
        return computeSkillImpact(impactRuns, { days, minRuns: this.config.minRuns });
    }
}

function* chunks<T>(items: T[]): Generator<T[]> {
    for (let i = 0; i < items.length; i += CHUNK) yield items.slice(i, i + CHUNK);
}
