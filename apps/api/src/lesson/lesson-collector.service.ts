import { Injectable, Logger } from '@nestjs/common';
import { Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import { JobRun } from '../run/run.entity.js';
import type { CollectResultDto } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonSource, lessonSourceKey, type LessonSourceKind } from './lesson-source.entity.js';

const MEMBER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const EXCERPT_MAX = 4000;
const TEXT_MAX = 200;

interface Candidate {
    projectId: string;
    kind: LessonSourceKind;
    key: string;
    jobId: string;
    runId: string | null;
    feedbackId: string | null;
    text: string;
    excerpt: string;
}

@Injectable()
export class LessonCollectorService {
    private readonly logger = new Logger(LessonCollectorService.name);
    private running = false;

    constructor(
        @InjectRepository(JobRun) private readonly runs: Repository<JobRun>,
        @InjectRepository(Feedback) private readonly feedback: Repository<Feedback>,
        @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
        @InjectRepository(LessonSource) private readonly sources: Repository<LessonSource>,
        @Optional() private readonly scout?: ScoutSignalPublisher,
    ) { }

    @Cron(CronExpression.EVERY_HOUR)
    async scheduled(): Promise<void> {
        try {
            await this.collect();
        } catch (e) {
            this.logger.error(`Lesson collection failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Creates one candidate lesson per suggested lesson or member feedback that isn't a lesson source yet (retros stay on the run and are not collected). A pass that overlaps a running one returns immediately. */
    async collect(): Promise<CollectResultDto> {
        if (this.running) return { created: 0 };
        this.running = true;
        try {
            const known = new Set((await this.sources.find({ select: { sourceKey: true } })).map((s) => s.sourceKey));
            let created = 0;
            for (const c of await this.candidates()) {
                if (known.has(c.key)) continue;
                if (await this.create(c)) created++;
                known.add(c.key);
            }
            return { created };
        } finally {
            this.running = false;
        }
    }

    private async candidates(): Promise<Candidate[]> {
        const out: Candidate[] = [];
        for (const run of await this.runs.find({ order: { createdAt: 'ASC' } })) {
            const base = { projectId: run.projectId, jobId: run.jobId, runId: run.id, feedbackId: null };
            const suggested = run.result?.suggestedLesson?.trim();
            if (suggested) {
                out.push({ ...base, kind: 'suggested_lesson', key: lessonSourceKey('suggested_lesson', run.id), text: suggested, excerpt: suggested });
            }
        }
        for (const f of await this.feedback.find({ order: { createdAt: 'ASC' } })) {
            const body = f.body.trim();
            if (!body || !MEMBER_ASSOCIATIONS.includes(f.authorAssociation)) continue;
            out.push({
                projectId: f.projectId, kind: 'feedback', key: lessonSourceKey('feedback', f.id), jobId: f.jobId,
                runId: null, feedbackId: f.id, text: body.slice(0, TEXT_MAX), excerpt: body.slice(0, EXCERPT_MAX),
            });
        }
        return out;
    }

    /** False if the source was collected concurrently. */
    private async create(c: Candidate): Promise<boolean> {
        let lessonId: string;
        try {
            lessonId = await this.lessons.manager.transaction(async (m) => {
                const lesson = await m.save(m.create(Lesson, { projectId: c.projectId, text: c.text }));
                await m.save(m.create(LessonSource, {
                    lessonId: lesson.id, sourceKey: c.key, kind: c.kind, jobId: c.jobId,
                    runId: c.runId, feedbackId: c.feedbackId, excerpt: c.excerpt,
                }));
                return lesson.id;
            });
        } catch (e) {
            if (isUniqueViolation(e)) return false;
            throw e;
        }
        // Only after the lesson and its source committed.
        await this.scout?.publish(c.projectId, { type: 'lesson_created', lessonId, jobId: c.jobId });
        return true;
    }
}
