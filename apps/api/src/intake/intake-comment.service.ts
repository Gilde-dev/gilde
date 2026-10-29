import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import { Spec } from '../spec/spec.entity.js';
import { SpecVersion } from '../spec/spec-version.entity.js';
import { parseSpec } from '../spec/spec-parser.js';
import {
    commentMarker, commentSha, goalSummary, INTAKE_COMMENT_INTERVAL_MS, renderStatusComment, safeCommentError, safeFailure,
    type IntakeCommentView,
} from './intake-comment.js';
import { hasIntakeLabel, refineSha } from './intake-issue.js';
import { IntakeItem } from './intake-item.entity.js';

/**
 * Gilde's one status comment per intake item, written as the GitHub App. Everything here is best effort: a missing
 * permission or a GitHub error is recorded on the item (`commentError`) and never reaches the caller, so it can never fail a
 * refine, an approval or a plan. Internal: it works on entities.
 */
@Injectable()
export class IntakeCommentService {
    private readonly logger = new Logger(IntakeCommentService.name);
    private readonly chains = new Map<string, Promise<void>>();
    /** Overridable clock for tests. */
    now: () => Date = () => new Date();

    constructor(
        @InjectRepository(IntakeItem) private readonly items: Repository<IntakeItem>,
        @InjectRepository(Spec) private readonly specs: Repository<Spec>,
        @InjectRepository(SpecVersion) private readonly versions: Repository<SpecVersion>,
        @InjectRepository(Feature) private readonly features: Repository<Feature>,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
    ) { }

    /** Creates or updates the status comment of one item. One at a time per item; never throws. */
    sync(itemId: string): Promise<void> {
        const run = (this.chains.get(itemId) ?? Promise.resolve()).then(() => this.write(itemId)).catch((e: unknown) => {
            this.logger.warn(`Status comment of intake item ${itemId} failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        this.chains.set(itemId, run);
        void run.finally(() => { if (this.chains.get(itemId) === run) this.chains.delete(itemId); });
        return run;
    }

    /** After a spec was approved or planned: refreshes the comment of every item that drafted it. Never throws. */
    async syncForSpec(specId: string): Promise<void> {
        try {
            const linked = await this.items.find({ where: { specId }, select: { id: true } });
            for (const item of linked) await this.sync(item.id);
        } catch (e) {
            this.logger.warn(`Status comments for spec ${specId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Every minute: writes that the rate limit held back. */
    @Cron('30 * * * * *')
    async flushPending(): Promise<void> {
        try {
            const pending = await this.items.find({ where: { statusCommentPending: true }, select: { id: true } });
            for (const item of pending) await this.sync(item.id);
        } catch (e) {
            this.logger.warn(`Pending status comments failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async write(itemId: string): Promise<void> {
        const item = await this.items.findOne({ where: { id: itemId }, relations: { repo: true } });
        if (!item?.repo || !this.github.isConfigured()) return;
        // a withdrawn or ignored item only gets its existing comment updated; one that never had a comment gets none
        if ((item.status === 'withdrawn' || item.status === 'ignored') && !item.statusCommentId) return;
        const view = await this.view(item);
        if (!view) return;
        const body = renderStatusComment(view);
        const sha = commentSha(body);
        if (item.statusCommentId && item.statusCommentSha256 === sha) {
            if (item.statusCommentPending || item.commentError) await this.items.update({ id: item.id }, { statusCommentPending: false, commentError: null });
            return; // unchanged: no write
        }
        const now = this.now();
        if (item.statusCommentWrittenAt && now.getTime() - item.statusCommentWrittenAt.getTime() < INTAKE_COMMENT_INTERVAL_MS) {
            if (!item.statusCommentPending) await this.items.update({ id: item.id }, { statusCommentPending: true });
            return;
        }
        try {
            const ref = await this.github.upsertIssueComment(item.repo.fullName, item.number, {
                marker: commentMarker(item.id), body, commentId: item.statusCommentId,
            });
            await this.items.update({ id: item.id }, {
                statusCommentId: ref.id, statusCommentUrl: ref.htmlUrl, statusCommentSha256: sha,
                statusCommentWrittenAt: now, statusCommentPending: false, commentError: null,
            });
        } catch (e) {
            await this.items.update({ id: item.id }, { statusCommentWrittenAt: now, statusCommentPending: false, commentError: safeCommentError(e) });
        }
    }

    /** What the comment says now; null when there is nothing to say yet (no draft and no failure). */
    private async view(item: IntakeItem): Promise<IntakeCommentView | null> {
        if (item.status === 'withdrawn' || item.status === 'ignored') {
            const reason = item.status === 'ignored' ? 'ignored in Gilde' : hasIntakeLabel(item.labels ?? []) ? 'issue closed' : 'label removed';
            return { itemId: item.id, status: 'no longer refined', spec: null, failure: null, reason };
        }
        const spec = item.specId ? await this.specs.findOneBy({ id: item.specId }) : null;
        const version = spec ? await this.versions.findOneBy({ specId: spec.id, version: spec.currentVersion }) : null;
        const parsed = version ? parseSpec(version.body) : null;
        const shown = spec && version && parsed ? {
            title: version.title, version: version.version, link: this.specLink(spec.id, item.projectId),
            criteria: parsed.criteria.length, summary: goalSummary(version.body), openQuestions: parsed.openQuestions,
        } : null;

        if (item.status === 'failed') return { itemId: item.id, status: 'refine failed', spec: shown, failure: safeFailure(item.lastError) };
        if (!spec || !shown) return null;
        const planned = (await this.features.countBy({ specId: spec.id })) > 0;
        const answered = (item.status === 'new' || item.status === 'refining') && !!item.comments?.length
            && !!item.refinedSha256 && item.refinedSha256 !== refineSha(item);
        const status = planned ? 'planned'
            : answered && spec.approvedVersion !== spec.currentVersion ? 'answers received'
            : spec.approvedVersion === spec.currentVersion ? 'approved'
                : shown.openQuestions.length ? 'waiting for answers'
                    : item.status === 'drafted' ? 'ready to approve'
                        : 'draft';
        return { itemId: item.id, status, spec: shown, failure: null };
    }

    private specLink(specId: string, projectId: string): string {
        const base = (process.env.WEB_ORIGIN?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
        return `${base}/specs/${specId}?project=${projectId}`;
    }
}
