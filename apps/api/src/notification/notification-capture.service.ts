import { createHash } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { buildProgress, type StatusGroup } from '../feature/feature-progress.js';
import { Feature } from '../feature/feature.entity.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import type { GildeProposal } from '../webhook/pr-body.js';
import type { RecordNotificationInput } from './notification.dto.js';
import type { NotificationPr } from './notification.entity.js';
import { ScoutSignalPublisher } from '../scout-signal/scout-signal.publisher.js';
import { NotificationService, sanitizeReason } from './notification.service.js';

/** Why a job was parked; part of the occurrence key so different causes are different events. */
export type ParkCause = 'failure' | 'sent_back' | 'dispatch' | 'blocked';

/**
 * Builds the envelopes for the factory events and records them best effort. Every method runs after the domain
 * write succeeded, reads what it needs itself and never throws: a failure in enrichment or insert is only logged.
 * Occurrence keys come from stable source identity (ids, attempt, head sha, content digest), never the clock.
 */
@Injectable()
export class NotificationCaptureService {
    private readonly logger = new Logger(NotificationCaptureService.name);

    constructor(
        private readonly notifications: NotificationService,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @InjectRepository(Job) private readonly jobs: Repository<Job>,
        @InjectRepository(Feature) private readonly features: Repository<Feature>,
        @Optional() @InjectRepository(JobRun) private readonly runs?: Repository<JobRun>,
        @Optional() private readonly scout?: ScoutSignalPublisher,
    ) { }

    /** The job entered awaiting_review (CI passed on its current head). */
    jobAwaitingReview(job: Job): Promise<boolean> {
        return this.notifications.recordQuietly(async () => ({
            ...(await this.jobEnvelope(job)),
            occurrenceKey: jobKey('job.awaiting_review', job),
            kind: 'job.awaiting_review',
            reason: `CI passed${job.headSha ? ` on ${job.headSha.slice(0, 7)}` : ''}; waiting for your review`,
        }));
    }

    /** The job was parked. `cause` keeps a CI park, a reviewer send-back and a failed fire apart. */
    async jobParked(job: Job, reason: string, cause: ParkCause): Promise<boolean> {
        const recorded = await this.notifications.recordQuietly(async () => ({
            ...(await this.jobEnvelope(job)),
            occurrenceKey: `${jobKey('job.parked', job)}:${cause}`,
            kind: 'job.parked',
            reason: sanitizeReason(reason),
        }));
        // The scout gets the ids only, never the free-form reason; it has its own dedupe, independent of the inbox row above.
        await this.scout?.publish(job.projectId, { type: 'job_parked', jobId: job.id, repoId: job.repoId, attempts: job.attempts, cause, headSha: job.headSha });
        return recorded;
    }

    /** A gate failed on the job's current head: one approval request per job, attempt and head. */
    approvalNeeded(job: Job, reason: string): Promise<boolean> {
        return this.notifications.recordQuietly(async () => ({
            ...(await this.jobEnvelope(job)),
            occurrenceKey: jobKey('job.approval_needed', job),
            kind: 'job.approval_needed',
            reason,
        }));
    }

    /**
     * An executor hit its usage limit. One occurrence per exhaustion (executor and reset time). Names the executor and its
     * owner and the reset time; never the token or fire URL. The envelope has no recipient, so the owner is named in the text.
     */
    executorExhausted(executor: { id: string; name: string }, ownerName: string, until: Date): Promise<boolean> {
        return this.notifications.recordQuietly({
            occurrenceKey: `executor.exhausted:${executor.id}:${until.toISOString()}`,
            kind: 'executor.exhausted',
            title: `Executor ${executor.name}`,
            repos: [],
            reason: sanitizeReason(`${ownerName}'s executor "${executor.name}" hit its usage limit; no jobs fire on it until ${until.toISOString()}`),
            prLinks: [],
        });
    }

    /**
     * A revision was proposed for `target` by the run behind `prJob`'s PR. The key uses the proposal content, so
     * re-parsing the same proposal is one event and an edited proposal is a new one.
     */
    revisionWaiting(run: JobRun, prJob: Job, target: Job, proposal: GildeProposal): Promise<boolean> {
        return this.notifications.recordQuietly(async () => {
            const [targetRepo, prRepo] = await Promise.all([this.repoName(target), this.repoName(prJob)]);
            return {
                occurrenceKey: `revision.waiting:${run.id}:${target.id}:${proposalDigest(proposal)}`,
                kind: 'revision.waiting',
                projectId: target.projectId,
                jobId: target.id,
                title: target.title,
                repos: unique([targetRepo]),
                reason: sanitizeReason(proposal.reason),
                prLinks: prLinks([[prRepo, prJob]]),
            };
        });
    }

    /**
     * Records feature.ready_to_close when the feature's current data satisfies buildProgress.readyToClose.
     * Reads the current rows; identical ready job sets share one key, so repeated or concurrent checks record once.
     */
    featureReadiness(featureId: string | null | undefined): Promise<boolean> {
        if (!featureId) return Promise.resolve(false);
        return this.notifications.recordQuietly(async () => {
            const feature = await this.features.findOneBy({ id: featureId });
            if (!feature) return null;
            const all = await this.jobs.find({ where: { featureId } });
            const groups = new Map<Job['status'], StatusGroup>();
            for (const j of all) {
                const g = groups.get(j.status) ?? { status: j.status, count: 0, attempts: 0 };
                g.count++;
                g.attempts += j.attempts;
                groups.set(j.status, g);
            }
            if (!buildProgress(feature, [...groups.values()]).readyToClose) return null;

            const counted = all.filter((j) => j.status !== 'cancelled');
            const names = new Map<string, string>();
            for (const id of new Set(counted.map((j) => j.repoId))) {
                const repo = await this.repos.findOneBy({ id });
                if (repo) names.set(id, repo.fullName);
            }
            const ids = counted.map((j) => j.id).sort();
            return {
                occurrenceKey: `feature.ready_to_close:${feature.id}:${digest(ids.join(','))}`,
                kind: 'feature.ready_to_close',
                projectId: feature.projectId,
                featureId: feature.id,
                title: feature.title,
                repos: unique(counted.map((j) => names.get(j.repoId) ?? j.repoId)),
                reason: `All ${counted.length} job${counted.length === 1 ? '' : 's'} merged; close the feature when you are satisfied`,
                prLinks: prLinks(counted.map((j) => [names.get(j.repoId) ?? j.repoId, j] as const)),
            };
        });
    }

    private async jobEnvelope(job: Job): Promise<Omit<RecordNotificationInput, 'occurrenceKey' | 'kind' | 'reason'>> {
        const repo = await this.repoName(job);
        return {
            projectId: job.projectId,
            jobId: job.id,
            title: job.title,
            repos: [repo],
            prLinks: prLinks([[repo, job]]),
        };
    }

    private async repoName(job: Job): Promise<string> {
        return (await this.repos.findOneBy({ id: job.repoId }))?.fullName ?? job.repoId;
    }
}

const unique = (values: string[]) => [...new Set(values)];

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** `kind:job:attempt:head`; the head is `none` before a PR exists. */
const jobKey = (kind: string, job: Job) => `${kind}:${job.id}:a${job.attempts}:${job.headSha ?? 'none'}`;

function prLinks(entries: ReadonlyArray<readonly [string, Job]>): NotificationPr[] {
    return entries
        .filter(([, j]) => j.prNumber != null && !!j.prUrl)
        .map(([repo, j]) => ({ repo, number: j.prNumber!, url: j.prUrl! }));
}

/** Canonical form of what a proposal says; field order and absent-versus-null do not matter. */
function proposalDigest(p: GildeProposal): string {
    return digest(JSON.stringify([
        p.title ?? null, p.task ?? null, p.acceptanceCriteria ?? null, p.dependsOn ?? null, p.reason.trim(),
    ]));
}
