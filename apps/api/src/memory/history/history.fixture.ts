import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { Feedback } from '../../feedback/feedback.entity.js';
import { Job } from '../../job/job.entity.js';
import type { JobStatus } from '../../job/job-state.js';
import { Lesson } from '../../lesson/lesson.entity.js';
import { LessonSource } from '../../lesson/lesson-source.entity.js';
import type { LessonStatus } from '../../lesson/lesson-state.js';
import { Project } from '../../project/project.entity.js';
import { Repo } from '../../repo/repo.entity.js';
import { JobRun } from '../../run/run.entity.js';
import { User } from '../../user/user.entity.js';
import { fakeEmbedder, testMemoryInfrastructure } from '../memory.testing.js';

import { HistoryIndexService } from './history-index.service.js';
import { HistorySearchService } from './history-search.service.js';
import { HistorySourceService } from './history-source.service.js';
import { HistoryEntry, HistoryState } from './history.entity.js';
import { historyOptions, type HistoryOptions } from './history.types.js';

export const HISTORY_ENTITIES = [User, Lesson, LessonSource, JobRun, Feedback, Job, Repo, Project, HistoryEntry, HistoryState];
export const DIMENSION = 64;

interface SqliteDb { prepare(sql: string): { all(): unknown[] }; close(): void }
const Database = createRequire(import.meta.url)('better-sqlite3') as new (file: string, options: { readonly: boolean }) => SqliteDb;

/** A deterministic embedder that can be told to fail, so retries and failures are testable. */
export function flakyEmbedder(dimension = DIMENSION) {
    const base = fakeEmbedder(dimension);
    const baseEmbed = base.doEmbed;
    const state = { failures: 0, delayMs: 0 };
    return Object.assign(base, {
        state,
        doEmbed: async (args: { values: string[] }) => {
            if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
            if (state.failures > 0) { state.failures--; throw new Error('embedding service unavailable (429)'); }
            return baseEmbed(args);
        },
    });
}

/** Real SQLite and real local LibSQL vector files in a temp dir, a fake embedder, and the history services on top. `restart()` builds fresh services on the same files. */
export async function historyHarness(overrides: Partial<HistoryOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'gilde-history-'));
    const ds = await new DataSource({ type: 'better-sqlite3', database: join(dir, 'app.db'), entities: HISTORY_ENTITIES, synchronize: true }).initialize();
    const embedder = flakyEmbedder();
    const options: HistoryOptions = { ...historyOptions({}), freshnessMs: 1, retryDelayMs: 0, embedAttempts: 1, searchTimeoutMs: 2000, ...overrides };

    const build = () => {
        const infra = testMemoryInfrastructure({ url: `file:${join(dir, 'vectors.db')}`, dimension: DIMENSION, embedder: embedder as never });
        const source = new HistorySourceService(
            ds.getRepository(Job), ds.getRepository(JobRun), ds.getRepository(Lesson), ds.getRepository(Feedback), ds.getRepository(Repo), ds.getRepository(Project),
        );
        const index = new HistoryIndexService(infra, options, source, ds.getRepository(HistoryEntry), ds.getRepository(HistoryState));
        const search = new HistorySearchService(infra, options, source, ds.getRepository(HistoryState));
        return { infra, source, index, search };
    };
    let services = build();

    const harness = {
        ds, embedder, options, dir,
        get infra() { return services.infra; },
        get index() { return services.index; },
        get search() { return services.search; },
        restart() { services = build(); },
        /** Runs reconcile until a pass completes (bounded), returning the number of runs. */
        async settle(max = 100): Promise<number> {
            for (let i = 1; i <= max; i++) {
                const result = await services.index.reconcile();
                if (result.outcome === 'failed') throw new Error(`reconcile failed: ${result.error}`);
                if (result.outcome === 'complete') return i;
            }
            throw new Error('pass did not complete');
        },
        /** Ids of every chunk in the history vector index. */
        async chunkIds(): Promise<string[]> {
            await services.infra.ensureHistoryIndex();
            // Read the table itself: an approximate vector query can miss rows after deletions.
            const db = new Database(join(dir, 'vectors.db'), { readonly: true });
            try {
                return (db.prepare(`SELECT vector_id FROM ${services.infra.historyIndexName}`).all() as { vector_id: string }[]).map((r) => r.vector_id).sort();
            } finally {
                db.close();
            }
        },
        async close() {
            await services.infra.onModuleDestroy();
            await ds.destroy();
            rmSync(dir, { recursive: true, force: true });
        },
        seed: {
            async project(name = 'Acme'): Promise<Project> {
                return ds.getRepository(Project).save({ slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, name });
            },
            async repo(project: Project, fullName = `acme/${randomUUID().slice(0, 6)}`): Promise<Repo> {
                return ds.getRepository(Repo).save({ projectId: project.id, fullName });
            },
            async job(repo: Repo, over: Partial<Job> & { status?: JobStatus } = {}): Promise<Job> {
                return ds.getRepository(Job).save({
                    projectId: repo.projectId, repoId: repo.id, title: 'Add export endpoint', task: 'Add a CSV export endpoint for invoices', acceptanceCriteria: ['Export streams rows'],
                    status: 'merged', prNumber: 7, prUrl: 'https://github.com/acme/web/pull/7', ...over,
                });
            },
            async run(job: Job, over: Partial<JobRun> = {}): Promise<JobRun> {
                const attempts = await ds.getRepository(JobRun).count({ where: { jobId: job.id } });
                return ds.getRepository(JobRun).save({ jobId: job.id, projectId: job.projectId, repoId: job.repoId, attempt: attempts + 1, status: 'ci_passed', ...over });
            },
            async lesson(project: Project, over: Partial<Lesson> & { status?: LessonStatus } = {}): Promise<Lesson> {
                return ds.getRepository(Lesson).save({ projectId: project.id, text: 'Run the migrations before the e2e tests', status: 'approved', ...over });
            },
            async feedback(job: Job, over: Partial<Feedback> = {}): Promise<Feedback> {
                return ds.getRepository(Feedback).save({
                    jobId: job.id, projectId: job.projectId, repoId: job.repoId, prNumber: job.prNumber ?? 7, kind: 'review', githubId: randomUUID(), author: 'reviewer',
                    authorAssociation: 'MEMBER', state: 'changes_requested', body: 'Please stream the export instead of buffering it', url: 'https://github.com/acme/web/pull/7#pullrequestreview-1', ...over,
                });
            },
        },
    };
    return harness;
}
export type HistoryHarness = Awaited<ReturnType<typeof historyHarness>>;
