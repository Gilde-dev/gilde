import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';

import { Feedback } from '../../feedback/feedback.entity.js';
import { Job } from '../../job/job.entity.js';
import { Lesson } from '../../lesson/lesson.entity.js';
import { Project } from '../../project/project.entity.js';
import { Repo } from '../../repo/repo.entity.js';
import { JobRun } from '../../run/run.entity.js';

import { buildDocument } from './history-chunker.js';
import {
    historyKey,
    INDEXED_JOB_STATUSES,
    isIndexedLessonStatus,
    type HistoryProvenance,
    type HistoryRecord,
    type HistorySourceType,
    type ScanKind,
} from './history.types.js';

const orEmpty = (value: string | null | undefined, fallback: string) => (value?.trim() ? value.trim() : fallback);

/**
 * Domain extraction for the history index: reads jobs, runs, lessons, feedback and repos and turns them into
 * documents plus current provenance. The only place that knows which records are eligible. Read-only.
 */
@Injectable()
export class HistorySourceService {

    constructor(
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
        @InjectRepository(Feedback) private readonly feedback: Repository<Feedback>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @InjectRepository(Project) private readonly projects: Repository<Project>,
    ) { }

    /** Throws NotFound for an unknown project or repo and BadRequest when the repo is in another project. */
    async assertScope(projectId: string, repoId?: string): Promise<void> {
        if (!(await this.projects.exists({ where: { id: projectId } }))) throw new NotFoundException(`Project ${projectId} not found`);
        if (!repoId) return;
        const repo = await this.repos.findOne({ where: { id: repoId } });
        if (!repo) throw new NotFoundException(`Repo ${repoId} not found`);
        if (repo.projectId !== projectId) throw new BadRequestException(`Repo ${repoId} does not belong to project ${projectId}`);
    }

    /** The next sources of a kind after the cursor, ordered by id. Ineligible ones are included (with `doc` null). */
    async page(kind: ScanKind, after: string | null, limit: number): Promise<HistoryRecord[]> {
        const where = after ? { id: MoreThan(after) } : {};
        const options = { where, order: { id: 'ASC' as const }, take: limit };
        switch (kind) {
            case 'job': return this.jobRecords(await this.jobs.find(options));
            case 'run': return this.runRecords(await this.runs.find(options));
            case 'lesson': return this.lessonRecords(await this.lessons.find(options));
            case 'feedback': return this.feedbackRecords(await this.feedback.find(options));
        }
    }

    /** Current records for the given sources, keyed by `historyKey`. Deleted sources are absent. */
    async load(refs: { type: HistorySourceType; sourceId: string }[]): Promise<Map<string, HistoryRecord>> {
        const ids = (...types: HistorySourceType[]) => [...new Set(refs.filter((r) => types.includes(r.type)).map((r) => r.sourceId))];
        const [jobs, runs, lessons, feedback] = await Promise.all([
            ids('job').length ? this.jobs.find({ where: { id: In(ids('job')) } }) : [],
            ids('run').length ? this.runs.find({ where: { id: In(ids('run')) } }) : [],
            ids('lesson').length ? this.lessons.find({ where: { id: In(ids('lesson')) } }) : [],
            ids('review', 'review_comment').length ? this.feedback.find({ where: { id: In(ids('review', 'review_comment')) } }) : [],
        ]);
        const records = [
            ...(await this.jobRecords(jobs)), ...(await this.runRecords(runs)),
            ...(await this.lessonRecords(lessons)), ...(await this.feedbackRecords(feedback)),
        ];
        return new Map(records.filter((r) => r.type).map((r) => [historyKey(r.type!, r.sourceId), r]));
    }

    private async repoNames(repoIds: string[]): Promise<Map<string, string>> {
        const unique = [...new Set(repoIds)];
        if (!unique.length) return new Map();
        return new Map((await this.repos.find({ where: { id: In(unique) } })).map((r) => [r.id, r.fullName]));
    }

    private async jobsById(jobIds: string[]): Promise<Map<string, Job>> {
        const unique = [...new Set(jobIds)];
        if (!unique.length) return new Map();
        return new Map((await this.jobs.find({ where: { id: In(unique) } })).map((j) => [j.id, j]));
    }

    private async jobRecords(jobs: Job[]): Promise<HistoryRecord[]> {
        if (!jobs.length) return [];
        const names = await this.repoNames(jobs.map((j) => j.repoId));
        const latest = new Map<string, JobRun>();
        for (const run of await this.runs.find({ where: { jobId: In(jobs.map((j) => j.id)) }, order: { attempt: 'DESC' } })) {
            if (!latest.has(run.jobId)) latest.set(run.jobId, run);
        }
        return jobs.map((job) => {
            const provenance = jobProvenance(job, names.get(job.repoId) ?? null, latest.get(job.id) ?? null);
            const body = [
                `Task: ${job.task}`,
                job.acceptanceCriteria.length ? `Acceptance criteria:\n${job.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
                job.lastReason ? `Last reason: ${job.lastReason}` : '',
            ].filter(Boolean).join('\n');
            const doc = INDEXED_JOB_STATUSES.has(job.status)
                ? buildDocument('job', job.id, job.projectId, job.repoId, `Job "${job.title}" (${names.get(job.repoId) ?? 'unknown repo'}), final status ${job.status}${job.prUrl ? `, PR ${job.prUrl}` : ''}`, body)
                : null;
            return { type: 'job' as const, sourceId: job.id, doc, provenance };
        });
    }

    private async runRecords(runs: JobRun[]): Promise<HistoryRecord[]> {
        if (!runs.length) return [];
        const jobs = await this.jobsById(runs.map((r) => r.jobId));
        const names = await this.repoNames(runs.map((r) => r.repoId));
        return runs.map((run) => {
            const job = jobs.get(run.jobId) ?? null;
            const provenance = jobProvenance(job, names.get(run.repoId) ?? null, run, { projectId: run.projectId, repoId: run.repoId, jobId: run.jobId });
            const result = run.result;
            const body = [
                `Run status: ${run.status}${run.ciConclusion ? `, CI ${run.ciConclusion}` : ''}`,
                result
                    ? `Outcome: ${result.outcome}. ${result.summary}${result.testsRun !== undefined ? ` Tests run: ${result.testsRun}, passed: ${result.testsPassed ?? 'unknown'}.` : ''}`
                    : `No agent result was recorded${run.resultError ? ` (${run.resultError})` : ''}.`,
                run.error ? `Error: ${run.error}` : '',
                `Retro: ${orEmpty(run.retro, 'none recorded')}`,
                result?.suggestedLesson ? `Suggested lesson: ${result.suggestedLesson}` : '',
            ].filter(Boolean).join('\n');
            const eligible = job !== null && INDEXED_JOB_STATUSES.has(job.status);
            const doc = eligible
                ? buildDocument('run', run.id, run.projectId, run.repoId, `Run: attempt ${run.attempt} of job "${job.title}" (${names.get(run.repoId) ?? 'unknown repo'})`, body)
                : null;
            return { type: 'run' as const, sourceId: run.id, doc, provenance };
        });
    }

    private async lessonRecords(lessons: Lesson[]): Promise<HistoryRecord[]> {
        if (!lessons.length) return [];
        const names = await this.repoNames(lessons.flatMap((l) => (l.targetRepoId ? [l.targetRepoId] : [])));
        return lessons.map((lesson) => {
            const repoName = lesson.targetRepoId ? names.get(lesson.targetRepoId) ?? null : null;
            const provenance: HistoryProvenance = {
                ...emptyProvenance(lesson.projectId), repoId: lesson.targetRepoId, repoFullName: repoName, status: lesson.status, lessonText: lesson.text,
            };
            const doc = isIndexedLessonStatus(lesson.status)
                ? buildDocument('lesson', lesson.id, lesson.projectId, lesson.targetRepoId ?? '', `Lesson (${repoName ? `for ${repoName}` : 'project-wide'})`, lesson.text)
                : null;
            return { type: 'lesson' as const, sourceId: lesson.id, doc, provenance };
        });
    }

    private async feedbackRecords(rows: Feedback[]): Promise<HistoryRecord[]> {
        if (!rows.length) return [];
        const jobs = await this.jobsById(rows.map((f) => f.jobId));
        const names = await this.repoNames(rows.map((f) => f.repoId));
        return rows.map((row) => {
            const job = jobs.get(row.jobId) ?? null;
            const type = row.kind === 'review' || row.kind === 'review_comment' ? row.kind : null;
            const provenance = { ...jobProvenance(job, names.get(row.repoId) ?? null, null, { projectId: row.projectId, repoId: row.repoId, jobId: row.jobId }), url: row.url };
            const body = row.body.trim();
            const where = row.kind === 'review_comment' ? ` on ${row.path ?? 'a file'}${row.line ? `:${row.line}` : ''}` : '';
            const header = `${row.kind === 'review' ? `Review (${row.state ?? 'commented'})` : 'Review comment'}${where} by ${row.author} on PR #${row.prNumber} of job "${job?.title ?? row.jobId}"`;
            const doc = type && body ? buildDocument(type, row.id, row.projectId, row.repoId, header, body) : null;
            return { type, sourceId: row.id, doc, provenance };
        });
    }
}

function emptyProvenance(projectId: string): HistoryProvenance {
    return { projectId, repoId: null, repoFullName: null, jobId: null, jobTitle: null, runId: null, attempt: null, outcome: null, status: null, prUrl: null, url: null, lessonText: null };
}

function jobProvenance(job: Job | null, repoFullName: string | null, run: JobRun | null, fallback?: { projectId: string; repoId: string; jobId: string }): HistoryProvenance {
    return {
        ...emptyProvenance(job?.projectId ?? fallback?.projectId ?? ''),
        repoId: job?.repoId ?? fallback?.repoId ?? null,
        repoFullName,
        jobId: job?.id ?? fallback?.jobId ?? null,
        jobTitle: job?.title ?? null,
        runId: run?.id ?? null,
        attempt: run?.attempt ?? null,
        outcome: run?.result?.outcome ?? null,
        status: job?.status ?? null,
        prUrl: job?.prUrl ?? null,
    };
}
