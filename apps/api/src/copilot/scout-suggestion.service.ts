import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import { FeatureService } from '../feature/feature.service.js';
import { JobContentSchema } from '../job/job.dto.js';
import { JobService } from '../job/job.service.js';
import { LessonService } from '../lesson/lesson.service.js';
import { RepoService } from '../repo/repo.service.js';
import { RunService } from '../run/run.service.js';

import { ScoutSuggestionGuard } from './scout-suggestion-guard.entity.js';
import { ScoutSuggestion } from './scout-suggestion.entity.js';
import { isIssuedScoutBinding, type ScoutBinding } from './verkenner.context.js';

export const SUGGESTION_MARKER = 'Suggested by Verkenner';
const MAX_EVIDENCE = 20;
const MAX_REASON = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SuggestionRefusalReason =
    | 'scout_off' | 'untrusted_context' | 'invalid_input' | 'missing_evidence' | 'invalid_evidence' | 'foreign_evidence'
    | 'unknown_repo' | 'foreign_repo' | 'duplicate_evidence' | 'duplicate_title' | 'daily_limit';

export interface SuggestionRefusal {
    reason: SuggestionRefusalReason;
    message: string;
    /** The offending ids: evidence ids, the earlier suggestion's job, or the open jobs with the same title. */
    ids?: string[];
    problems?: string[];
}

export type SuggestionResult =
    | { created: true; jobId: string; status: 'triage'; basedOn: string[]; link: string }
    | { created: false; stop: true; refusal: SuggestionRefusal };

export interface SuggestionInput {
    repoId: string;
    title: string;
    task: string;
    acceptanceCriteria: string[];
    reason: string;
    basedOn: string[];
}

/** Sorted, unique, lower-case ids: the same evidence set in any order, with repeats, gives the same list. */
export const canonicalEvidence = (ids: readonly string[]): string[] => [...new Set(ids.map((i) => i.trim().toLowerCase()))].sort();

export const evidenceHash = (ids: readonly string[]): string => createHash('sha256').update(canonicalEvidence(ids).join(',')).digest('hex');

export const utcDayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** The UTC day of the Monday (00:00 UTC) of the week `d` is in. */
export function utcWeekStartDay(d: Date): string {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7;
    return utcDayOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday)));
}

/** Per-project queue of this process, shared by all instances. */
const chains = new Map<string, Promise<unknown>>();

const refuse = (reason: SuggestionRefusalReason, message: string, extra: Pick<SuggestionRefusal, 'ids' | 'problems'> = {}): SuggestionResult =>
    ({ created: false, stop: true, refusal: { reason, message, ...extra } });

/**
 * Creates the scout's job suggestions. A suggestion is one job in triage, created by the scout user, with a Why section and
 * a text marker; nothing else is mutated. Quota, evidence-hash and title checks and the job plus its receipt are one
 * transaction under a per-project lock row (see ScoutSuggestionGuard), so concurrent callers, several processes and restarts
 * cannot exceed the quota or bypass the checks, and a failure while writing the receipt rolls the job back.
 * Refusals write nothing and therefore never consume the daily allowance.
 */
@Injectable()
export class ScoutSuggestionService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly jobs: Pick<JobService, 'create' | 'getById' | 'findOpenByTitle'>,
        private readonly features: Pick<FeatureService, 'getById'>,
        private readonly lessons: Pick<LessonService, 'getById'>,
        private readonly runs: Pick<RunService, 'findById'>,
        private readonly repos: Pick<RepoService, 'getById'>,
        /** The enabled scout's settings and bot user, or null when the scout is off. */
        private readonly scout: { user: { id: string }; dailySuggestions: number } | null,
        private readonly clock: () => Date = () => new Date(),
    ) { }

    async suggest(binding: unknown, input: SuggestionInput): Promise<SuggestionResult> {
        if (!this.scout) return refuse('scout_off', 'The scout is off; nothing was created.');
        if (!isIssuedScoutBinding(binding) || binding.userId !== this.scout.user.id) {
            return refuse('untrusted_context', 'This call does not come from a server-bound Verkenner run; nothing was created.');
        }
        const checked = await this.validate(binding, input);
        if ('created' in checked) return checked;
        return this.exclusive(binding.projectId, () => this.persist(binding, checked));
    }

    private async validate(binding: ScoutBinding, input: SuggestionInput) {
        const raw = [...(input.basedOn ?? [])];
        if (raw.length === 0 || raw.every((i) => !i.trim())) return refuse('missing_evidence', 'basedOn needs at least one run, job, lesson or feature id.');
        const ids = canonicalEvidence(raw.filter((i) => i.trim()));
        const malformed = ids.filter((i) => !UUID.test(i));
        if (malformed.length) return refuse('invalid_evidence', 'basedOn may only hold ids of runs, jobs, lessons or features.', { ids: malformed });
        if (ids.length > MAX_EVIDENCE) return refuse('invalid_input', `basedOn: at most ${MAX_EVIDENCE} distinct ids`);

        const reason = (input.reason ?? '').trim();
        const problems: string[] = [];
        if (reason.length < 10) problems.push('reason: at least 10 characters');
        if (reason.length > MAX_REASON) problems.push(`reason: at most ${MAX_REASON} characters`);
        const rawTask = (input.task ?? '').trim();
        const content = JobContentSchema.safeParse({ title: input.title, task: rawTask, acceptanceCriteria: input.acceptanceCriteria });
        if (!content.success) problems.push(...content.error.issues.map((i) => `${i.path.join('.') || 'job'}: ${i.message}`));
        if (problems.length || !content.success) return refuse('invalid_input', 'The suggestion does not fit the limits of a job.', { problems });

        let repo: Awaited<ReturnType<RepoService['getById']>>;
        try {
            repo = await this.repos.getById(input.repoId);
        } catch {
            return refuse('unknown_repo', `Repo ${input.repoId} does not exist.`, { ids: [input.repoId] });
        }
        if (repo.projectId !== binding.projectId) return refuse('foreign_repo', `Repo ${input.repoId} is not in this project.`, { ids: [input.repoId] });

        const unknown: string[] = [];
        const foreign: string[] = [];
        for (const id of ids) {
            const projectId = await this.projectOfEvidence(id);
            if (projectId === null) unknown.push(id);
            else if (projectId !== binding.projectId) foreign.push(id);
        }
        if (unknown.length) return refuse('invalid_evidence', 'These ids are not a known run, job, lesson or feature.', { ids: unknown });
        if (foreign.length) return refuse('foreign_evidence', 'These ids belong to another project.', { ids: foreign });

        // The final text is validated too: the Why section must not push the task past what a job may hold.
        const task = `${content.data.task}\n\n## Why\n${reason}\n\nBased on: ${ids.join(', ')}\n\n${SUGGESTION_MARKER}`;
        const final = JobContentSchema.safeParse({ ...content.data, task });
        if (!final.success) return refuse('invalid_input', 'The suggestion does not fit the limits of a job.', { problems: final.error.issues.map((i) => `${i.path.join('.') || 'job'}: ${i.message}`) });
        return { repoId: repo.id, title: content.data.title, task, acceptanceCriteria: content.data.acceptanceCriteria ?? [], ids };
    }

    /** The project an evidence id belongs to (a job, feature, lesson or run), or null when it is none of them. */
    private async projectOfEvidence(id: string): Promise<string | null> {
        const lookups: (() => Promise<{ projectId: string } | null | undefined>)[] = [
            () => this.jobs.getById(id), () => this.features.getById(id), () => this.lessons.getById(id), () => this.runs.findById(id),
        ];
        for (const lookup of lookups) {
            try {
                const found = await lookup();
                if (found) return found.projectId;
            } catch { /* not this kind of record */ }
        }
        return null;
    }

    private async persist(binding: ScoutBinding, v: { repoId: string; title: string; task: string; acceptanceCriteria: string[]; ids: string[] }): Promise<SuggestionResult> {
        const now = this.clock();
        const day = utcDayOf(now);
        const hash = evidenceHash(v.ids);
        const quota = this.scout!.dailySuggestions;
        try {
            return await this.dataSource.transaction(async (m): Promise<SuggestionResult> => {
                await m.createQueryBuilder().insert().into(ScoutSuggestionGuard).values({ projectId: binding.projectId, version: 0 }).orIgnore().execute();
                // First write of the transaction: locks the project's guard row until commit.
                await m.createQueryBuilder().update(ScoutSuggestionGuard).set({ version: () => '"version" + 1' }).where('"project_id" = :projectId', { projectId: binding.projectId }).execute();

                const receipts = m.getRepository(ScoutSuggestion);
                const same = await receipts.findOneBy({ projectId: binding.projectId, evidenceHash: hash });
                if (same) return refuse('duplicate_evidence', 'An earlier suggestion in this project was based on exactly this set of evidence.', { ids: [same.jobId] });
                const sameTitle = await this.jobs.findOpenByTitle(binding.projectId, v.title, m);
                if (sameTitle.length) return refuse('duplicate_title', 'A job with this title (ignoring case) is still open in this project.', { ids: sameTitle });
                if ((await receipts.countBy({ projectId: binding.projectId, day })) >= quota) {
                    return refuse('daily_limit', `The limit of ${quota} suggestions per project per UTC day is reached; try again tomorrow.`);
                }

                const job = await this.jobs.create(v.repoId, { title: v.title, task: v.task, acceptanceCriteria: v.acceptanceCriteria, status: 'triage' }, { id: this.scout!.user.id }, m);
                await receipts.insert({ projectId: binding.projectId, jobId: job.id, actorId: this.scout!.user.id, evidenceHash: hash, day, createdAt: now });
                return { created: true, jobId: job.id, status: 'triage', basedOn: v.ids, link: `/?project=${binding.projectId}&job=${job.id}` };
            });
        } catch (error) {
            // A concurrent process won the same evidence set: the unique (project, hash) index is the last line of defence.
            if (isUniqueViolation(error)) return refuse('duplicate_evidence', 'An earlier suggestion in this project was based on exactly this set of evidence.');
            throw error;
        }
    }

    /** Serializes this process's suggestions per project (also keeps SQLite, one connection, from nesting transactions); other processes are serialized by the guard row in the transaction. */
    private exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
        const run = (chains.get(projectId) ?? Promise.resolve()).then(work, work);
        const tail = run.catch(() => undefined);
        chains.set(projectId, tail);
        void tail.then(() => { if (chains.get(projectId) === tail) chains.delete(projectId); });
        return run;
    }
}
