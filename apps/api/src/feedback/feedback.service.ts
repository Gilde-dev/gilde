import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';

import { Optional } from '@nestjs/common';

import { isUniqueViolation } from '../common/db-errors.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import type { FeedbackResponseDto, ListFeedbackQuery } from './feedback.dto.js';
import { Feedback } from './feedback.entity.js';
import { FeedbackMapper } from './feedback.mapper.js';

export type NewFeedback = Omit<Feedback, 'id' | 'createdAt'> & { createdAt?: Date };

@Injectable()
export class FeedbackService {

    constructor(
        private readonly feedbackMapper: FeedbackMapper,
        @InjectRepository(Feedback) private readonly feedbackRepository: Repository<Feedback>,
        @Optional() private readonly scout?: ScoutSignalPublisher,
    ) { }

    /** Stores one piece of feedback; returns false when (kind, githubId) was already stored (redelivery). */
    async record(input: NewFeedback): Promise<boolean> {
        const existing = await this.feedbackRepository.findOneBy({ kind: input.kind, githubId: input.githubId });
        if (existing) return false;
        try {
            const saved = await this.feedbackRepository.save(this.feedbackRepository.create(input));
            if (saved.kind === 'review' && saved.state === 'changes_requested') {
                await this.scout?.publish(saved.projectId, { type: 'changes_requested', jobId: saved.jobId, repoId: saved.repoId, feedbackId: saved.id, prNumber: saved.prNumber });
            }
            return true;
        } catch (e) {
            if (isUniqueViolation(e)) return false; // concurrent redelivery
            throw e;
        }
    }

    async listForJob(jobId: string): Promise<FeedbackResponseDto[]> {
        const entities = await this.feedbackRepository.find({ where: { jobId }, order: { createdAt: 'ASC', id: 'ASC' } });
        return entities.map((e) => this.feedbackMapper.toDTO(e));
    }

    async list(q: ListFeedbackQuery): Promise<FeedbackResponseDto[]> {
        const where: FindOptionsWhere<Feedback> = {};
        if (q.projectId) where.projectId = q.projectId;
        if (q.repoId) where.repoId = q.repoId;
        if (q.since) where.createdAt = MoreThanOrEqual(new Date(q.since));
        const entities = await this.feedbackRepository.find({ where, order: { createdAt: 'ASC', id: 'ASC' } });
        return entities.map((e) => this.feedbackMapper.toDTO(e));
    }

    /** Internal: inline review comments on the job's PR created after `since` (i.e. not yet answered by an agent push). */
    findReviewCommentsSince(jobId: string, since: Date | null): Promise<Feedback[]> {
        return this.feedbackRepository.find({
            where: { jobId, kind: 'review_comment', ...(since ? { createdAt: MoreThan(since) } : {}) },
            order: { createdAt: 'ASC', id: 'ASC' },
        });
    }

    /** Internal: the inline comments stored for one review, oldest first. */
    findReviewComments(jobId: string, reviewId: string): Promise<Feedback[]> {
        return this.feedbackRepository.find({
            where: { jobId, kind: 'review_comment', reviewId },
            order: { createdAt: 'ASC', id: 'ASC' },
        });
    }

}
