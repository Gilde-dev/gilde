import { Injectable } from '@nestjs/common';

import type { LessonResponseDto, LessonSourceResponseDto } from './lesson.dto.js';
import { Lesson } from './lesson.entity.js';
import { LessonSource } from './lesson-source.entity.js';

@Injectable()
export class LessonMapper {

    toSourceDTO(e: LessonSource, prUrl: string | null): LessonSourceResponseDto {
        return {
            id: e.id,
            kind: e.kind,
            jobId: e.jobId,
            runId: e.runId,
            feedbackId: e.feedbackId,
            excerpt: e.excerpt,
            prUrl,
            createdAt: e.createdAt.toISOString(),
        };
    }

    toDTO(e: Lesson, sources: LessonSourceResponseDto[], appliedJobPrUrl: string | null = null): LessonResponseDto {
        return {
            id: e.id,
            projectId: e.projectId,
            text: e.text,
            status: e.status,
            targetKind: e.targetKind,
            targetRepoId: e.targetRepoId,
            note: e.note,
            appliedJobId: e.appliedJobId,
            appliedJobPrUrl,
            appliedSkillName: e.appliedSkillName,
            appliedAt: e.appliedAt?.toISOString() ?? null,
            sources,
            sourceCount: new Set(sources.map((s) => s.jobId)).size,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
        };
    }
}
