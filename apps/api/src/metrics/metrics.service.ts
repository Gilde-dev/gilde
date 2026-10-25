import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, type FindOptionsWhere } from 'typeorm';

import { JOB_STATUSES } from '../job/job-state.js';
import { Job } from '../job/job.entity.js';
import { ProjectService } from '../project/project.service.js';
import { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import type { MetricsQuery, MetricsResponseDto } from './metrics.dto.js';

const DAY_MS = 86_400_000;
const CHUNK = 500;
/** Jobs that ended without being cancelled; the denominator of merge rate and avg attempts. */
const DECIDED = new Set(['merged', 'rejected', 'parked']);

@Injectable()
export class MetricsService {

    constructor(
        private readonly projectService: ProjectService,
        private readonly repoService: RepoService,
        @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
        @InjectRepository(JobRun) private readonly runRepository: Repository<JobRun>,
    ) { }

    async get(q: MetricsQuery, now: Date = new Date()): Promise<MetricsResponseDto> {
        if (q.projectId) await this.projectService.assertExists(q.projectId);
        if (q.repoId) await this.repoService.getById(q.repoId);

        const days = q.days;
        const today = startOfUtcDay(now);
        const start = new Date(today.getTime() - (days - 1) * DAY_MS);

        const where: FindOptionsWhere<Job> = { createdAt: MoreThanOrEqual(start) };
        if (q.projectId) where.projectId = q.projectId;
        if (q.repoId) where.repoId = q.repoId;
        const all = await this.jobRepository.find({ where });
        // Triage jobs are not work in flight yet: they only show up in countByStatus.
        const jobs = all.filter((j) => j.status !== 'triage');
        const runs = await this.findRuns(jobs.map((j) => j.id));

        const lastRun = new Map<string, JobRun>();
        for (const r of runs) {
            const prev = lastRun.get(r.jobId);
            if (!prev || r.attempt > prev.attempt) lastRun.set(r.jobId, r);
        }

        const countByStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as MetricsResponseDto['jobs']['countByStatus'];
        for (const j of all) countByStatus[j.status]++;

        const merged = jobs.filter((j) => j.status === 'merged');
        const decided = jobs.filter((j) => DECIDED.has(j.status));

        const mergeTimes: number[] = [];
        for (const j of merged) {
            const finished = lastRun.get(j.id)?.finishedAt;
            if (finished) mergeTimes.push(Math.max(0, finished.getTime() - j.createdAt.getTime()) / 60_000);
        }
        mergeTimes.sort((a, b) => a - b);

        const byOutcome = { done: 0, partial: 0, blocked: 0, none: 0 };
        const byCiConclusion: Record<string, number> = { none: 0 };
        for (const r of runs) {
            byOutcome[r.result?.outcome ?? 'none']++;
            const c = r.ciConclusion ?? 'none';
            byCiConclusion[c] = (byCiConclusion[c] ?? 0) + 1;
        }

        const daily = Array.from({ length: days }, (_, i) => ({
            date: isoDate(new Date(start.getTime() + i * DAY_MS)), created: 0, merged: 0, parked: 0,
        }));
        const bucket = new Map(daily.map((d) => [d.date, d]));
        for (const j of jobs) {
            bucket.get(isoDate(j.createdAt))!.created++;
            if (j.status !== 'merged' && j.status !== 'parked') continue;
            const endedAt = (j.status === 'merged' ? lastRun.get(j.id)?.finishedAt : null) ?? j.updatedAt;
            const d = bucket.get(isoDate(endedAt));
            if (d) d[j.status]++;
        }

        return {
            days,
            jobs: { total: jobs.length, countByStatus },
            mergeRate: ratio(merged.length, decided.length),
            firstPassRate: ratio(merged.filter((j) => j.attempts === 1).length, merged.length),
            avgAttempts: decided.length ? round(decided.reduce((n, j) => n + j.attempts, 0) / decided.length) : null,
            timeToMerge: { median: median(mergeTimes), p90: percentile(mergeTimes, 0.9) },
            runs: { total: runs.length, byOutcome, byCiConclusion, gateFailures: jobs.filter((j) => j.needsApproval).length },
            byInstructionsVersion: byInstructionsVersion(runs, jobs, lastRun),
            daily,
        };
    }

    private async findRuns(jobIds: string[]): Promise<JobRun[]> {
        const runs: JobRun[] = [];
        for (let i = 0; i < jobIds.length; i += CHUNK) {
            runs.push(...await this.runRepository.find({ where: { jobId: In(jobIds.slice(i, i + CHUNK)) } }));
        }
        return runs;
    }
}

/**
 * Runs are counted per version. A job counts towards the version of its last run, the one that
 * led to its outcome; jobs without runs are left out. The null version is reported as "none".
 */
function byInstructionsVersion(runs: JobRun[], jobs: Job[], lastRun: Map<string, JobRun>): MetricsResponseDto['byInstructionsVersion'] {
    const groups = new Map<string, { runs: number; latest: number; jobs: Job[] }>();
    const group = (v: string | null) => {
        const key = v ?? 'none';
        let g = groups.get(key);
        if (!g) groups.set(key, g = { runs: 0, latest: 0, jobs: [] });
        return g;
    };
    for (const r of runs) {
        const g = group(r.instructionsVersion);
        g.runs++;
        g.latest = Math.max(g.latest, r.createdAt.getTime());
    }
    for (const j of jobs) {
        const last = lastRun.get(j.id);
        if (last) group(last.instructionsVersion).jobs.push(j);
    }
    return [...groups.entries()]
        .sort((a, b) => b[1].latest - a[1].latest)
        .map(([version, g]) => {
            const merged = g.jobs.filter((j) => j.status === 'merged');
            const decided = g.jobs.filter((j) => DECIDED.has(j.status));
            return {
                version,
                runs: g.runs,
                mergedJobs: merged.length,
                firstPassRate: ratio(merged.filter((j) => j.attempts === 1).length, merged.length),
                avgAttempts: decided.length ? round(decided.reduce((n, j) => n + j.attempts, 0) / decided.length) : null,
            };
        });
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number) => Math.round(n * 100) / 100;
const ratio = (n: number, d: number) => (d === 0 ? null : round(n / d));

function median(sorted: number[]): number | null {
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number | null {
    if (!sorted.length) return null;
    return round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
}
