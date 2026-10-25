import { Logger } from '@nestjs/common';

import type { HistorySearchService } from '../memory/history/history-search.service.js';
import { HISTORY_MAX_QUERY_CHARS } from '../memory/history/history.dto.js';
import { isIndexedLessonStatus } from '../memory/history/history.types.js';
import type { JobLesson } from './execution.port.js';

/** Most lessons, longest lesson and most lesson characters in total handed to an agent. */
export const LESSONS_MAX_COUNT = 5;
export const LESSON_TEXT_LIMIT = 800;
export const LESSONS_TOTAL_LIMIT = 3000;
/** Longest diagnostic logged when retrieval is skipped. */
const DIAGNOSTIC_LIMIT = 200;

export interface LessonRetrievalOptions {
    topK: number;
    minScore: number;
    timeoutMs: number;
}

/** DISPATCH_LESSONS_TOP_K (default 5, at most LESSONS_MAX_COUNT), DISPATCH_LESSONS_MIN_SCORE (0.5) and DISPATCH_LESSONS_TIMEOUT_MS (3000). */
export function lessonRetrievalOptions(env: NodeJS.ProcessEnv = process.env): LessonRetrievalOptions {
    const topK = Number(env.DISPATCH_LESSONS_TOP_K);
    const minScore = env.DISPATCH_LESSONS_MIN_SCORE?.trim() ? Number(env.DISPATCH_LESSONS_MIN_SCORE) : NaN;
    const timeoutMs = Number(env.DISPATCH_LESSONS_TIMEOUT_MS);
    return {
        topK: Number.isInteger(topK) && topK >= 0 ? Math.min(topK, LESSONS_MAX_COUNT) : LESSONS_MAX_COUNT,
        minScore: minScore >= 0 && minScore <= 1 ? minScore : 0.5,
        timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 100 ? timeoutMs : 3000,
    };
}

export interface LessonJobInput {
    projectId: string;
    repoId: string;
    title: string;
    task: string;
    acceptanceCriteria: string[];
    stacks: string[];
}

const logger = new Logger('JobLessons');

/**
 * The lessons to offer an agent for this job: approved, applying or applied lessons of its project that are
 * project-wide or target its repo, relevant to title, task, criteria and stacks. Fail-open: a timeout, rate limit,
 * missing credentials or index, vector error or no match yields an empty list and a bounded log line, never an error.
 * Only lessons are searched, so raw retros, reviews and personal memory cannot appear.
 */
export async function selectJobLessons(
    history: Pick<HistorySearchService, 'searchLessons'>,
    job: LessonJobInput,
    options: LessonRetrievalOptions = lessonRetrievalOptions(),
): Promise<JobLesson[]> {
    if (options.topK === 0) return [];
    let timer: NodeJS.Timeout | undefined;
    try {
        const query = [job.title, job.task, ...job.acceptanceCriteria, `Stacks: ${job.stacks.join(', ')}`].join('\n').slice(0, HISTORY_MAX_QUERY_CHARS);
        const work = history.searchLessons({ projectId: job.projectId, repoId: job.repoId, query, topK: options.topK, minScore: options.minScore });
        work.catch(() => undefined);
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${options.timeoutMs} ms`)), options.timeoutMs); });
        const result = await Promise.race([work, timeout]);
        if (result.status !== 'ok') {
            skipped(job, result.reason);
            return [];
        }
        return shapeLessons(result.lessons, job, options.minScore);
    } catch (e) {
        skipped(job, e instanceof Error ? e.message : String(e));
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/** Revalidates scope and lifecycle, deduplicates, orders by relevance and caps count and characters. */
function shapeLessons(hits: Awaited<ReturnType<HistorySearchService['searchLessons']>>['lessons'], job: LessonJobInput, minScore: number): JobLesson[] {
    const seen = new Set<string>();
    const lessons: JobLesson[] = [];
    let total = 0;
    for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
        if (lessons.length >= LESSONS_MAX_COUNT) break;
        const text = hit.text.trim().slice(0, LESSON_TEXT_LIMIT);
        if (!text || seen.has(hit.lessonId)) continue;
        if (hit.projectId !== job.projectId || (hit.targetRepoId !== null && hit.targetRepoId !== job.repoId)) continue;
        if (!isIndexedLessonStatus(hit.status as never) || hit.score < minScore) continue;
        if (total + text.length > LESSONS_TOTAL_LIMIT) continue;
        seen.add(hit.lessonId);
        total += text.length;
        lessons.push({
            id: hit.lessonId,
            text,
            scope: hit.targetRepoId === null ? 'project' : 'repo',
            status: hit.status as JobLesson['status'],
            relevance: Math.round(hit.score * 100) / 100,
        });
    }
    return lessons;
}

function skipped(job: LessonJobInput, reason: string): void {
    logger.warn(`No lessons for a job in repo ${job.repoId}: ${reason.replace(/\s+/g, ' ').slice(0, DIAGNOSTIC_LIMIT)}`);
}
