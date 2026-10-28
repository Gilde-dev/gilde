import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import { ProjectService } from '../project/project.service.js';
import { GithubInstallationService } from '../repo/github-installation.service.js';
import { Repo } from '../repo/repo.entity.js';
import { UserService } from '../user/user.service.js';
import { IntakeItem } from './intake-item.entity.js';
import { capBody, hasIntakeLabel, intakeLabel, issueSha, type IntakeIssue } from './intake-issue.js';
import type { IntakeItemDetailResponseDto, IntakeItemResponseDto, IntakeSweepResultDto, ListIntakeQueryDto } from './intake.dto.js';
import { IntakeMapper } from './intake.mapper.js';

export type IntakeChange = 'created' | 'updated' | 'withdrawn' | 'unchanged' | 'ignored';

@Injectable()
export class IntakeService {
    private readonly logger = new Logger(IntakeService.name);
    private sweeping = false;

    constructor(
        @InjectRepository(IntakeItem) private readonly items: Repository<IntakeItem>,
        @InjectRepository(Repo) private readonly repos: Repository<Repo>,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        private readonly installations: GithubInstallationService,
        private readonly projects: ProjectService,
        private readonly users: UserService,
        private readonly mapper: IntakeMapper,
    ) { }

    async list(projectId: string, query: ListIntakeQueryDto): Promise<IntakeItemResponseDto[]> {
        await this.projects.assertExists(projectId);
        const rows = await this.items.find({
            where: { projectId, ...(query.status ? { status: query.status } : {}) },
            relations: { repo: true },
            order: { createdAt: 'DESC' },
        });
        return rows.map((r) => this.mapper.toDTO(r));
    }

    async getById(id: string): Promise<IntakeItemDetailResponseDto> {
        return this.mapper.toDetailDTO(await this.getOrFail(id));
    }

    /** Verified humans only. A refining item cannot be ignored; one already ignored or withdrawn has nothing to ignore. */
    async ignore(id: string, user: AuthUser | undefined): Promise<IntakeItemDetailResponseDto> {
        await this.users.requireVerifiedHuman(user);
        const item = await this.getOrFail(id);
        if (item.status === 'ignored' || item.status === 'withdrawn' || item.status === 'refining') {
            throw new ConflictException(`Intake item is ${item.status} and cannot be ignored`);
        }
        await this.items.update({ id, status: item.status }, { status: 'ignored' });
        return this.getById(id);
    }

    /** Verified humans only. Puts a failed or ignored item back to `new` for another refine round. */
    async retry(id: string, user: AuthUser | undefined): Promise<IntakeItemDetailResponseDto> {
        await this.users.requireVerifiedHuman(user);
        const item = await this.getOrFail(id);
        if (item.status !== 'failed' && item.status !== 'ignored') {
            throw new ConflictException(`Intake item is ${item.status}; only failed or ignored items can be retried`);
        }
        await this.items.update({ id, status: item.status }, { status: 'new', lastError: null, refineAttempts: 0, refinedSha256: null });
        return this.getById(id);
    }

    /**
     * Applies the current state of one issue of a registered repo. Idempotent: the same issue twice changes nothing.
     * - not open, or without the intake label: an item that exists is withdrawn; an issue never seen is not stored.
     * - new item, or changed title/body: status `new` (an ignored item stays ignored, a refining one is queued again).
     * - a withdrawn item whose issue is open and labelled again: `new`.
     */
    async applyIssue(repo: Pick<Repo, 'id' | 'projectId'>, issue: IntakeIssue): Promise<IntakeChange> {
        const existing = await this.items.findOneBy({ source: 'github_issue', repoId: repo.id, number: issue.number });
        const wanted = issue.open && hasIntakeLabel(issue.labels);
        if (!wanted) {
            if (!existing) return 'unchanged';
            if (existing.status === 'withdrawn') return 'unchanged';
            await this.items.update({ id: existing.id }, { status: 'withdrawn', labels: issue.labels });
            return 'withdrawn';
        }

        const sha = issueSha(issue.title, issue.body);
        const { body, truncated } = capBody(issue.body);
        const fields = {
            externalId: issue.nodeId, url: issue.url, title: issue.title, body, bodyTruncated: truncated,
            bodySha256: sha, authorLogin: issue.authorLogin, labels: issue.labels,
        };

        if (!existing) {
            try {
                await this.items.insert({ ...fields, projectId: repo.projectId, repoId: repo.id, source: 'github_issue', number: issue.number, status: 'new' });
                return 'created';
            } catch (e) {
                if (!isUniqueViolation(e)) throw e;
                return this.applyIssue(repo, issue); // a concurrent delivery created it first
            }
        }

        const changed = existing.bodySha256 !== sha;
        const status = existing.status === 'ignored' ? 'ignored'
            : changed || existing.status === 'withdrawn' ? 'new'
                : existing.status;
        const same = !changed && status === existing.status && existing.url === issue.url && existing.authorLogin === issue.authorLogin
            && existing.externalId === issue.nodeId && existing.labels.join('\n') === issue.labels.join('\n');
        if (same) return 'unchanged';
        await this.items.update({ id: existing.id }, {
            ...fields, status,
            ...(status === 'new' && (changed || existing.status !== 'new') ? { lastError: null, refineAttempts: 0 } : {}),
        });
        return status === 'ignored' ? 'ignored' : 'updated';
    }

    /** The manual sweep: verified humans only. */
    async sweepAs(user: AuthUser | undefined): Promise<IntakeSweepResultDto> {
        await this.users.requireVerifiedHuman(user);
        return this.sweep();
    }

    /** Every 15 minutes: recovers issue events whose webhook was missed. */
    @Cron('0 */15 * * * *')
    async scheduledSweep(): Promise<void> {
        try {
            await this.sweep();
        } catch (e) {
            this.logger.error(`Intake sweep failed: ${errorMessage(e)}`);
        }
    }

    /**
     * Lists the open labelled issues of every registered repo (one request each, skipping repos the app is not installed on)
     * and applies them. When the list is complete, items of that repo missing from it are withdrawn: their issue was
     * unlabelled or closed while no webhook arrived. An overlapping sweep returns immediately.
     */
    async sweep(): Promise<IntakeSweepResultDto> {
        const result: IntakeSweepResultDto = { repos: 0, skipped: 0, upserted: 0, withdrawn: 0 };
        if (!this.github.isConfigured() || this.sweeping) return result;
        this.sweeping = true;
        try {
            const repos = await this.repos.find({ order: { fullName: 'ASC' } });
            const status = await this.installations.statusFor(repos.map((r) => r.fullName));
            for (const repo of repos) {
                if (status.get(repo.fullName)?.installed === false) { result.skipped++; continue; }
                try {
                    const page = await this.github.listOpenIssuesWithLabel(repo.fullName, intakeLabel());
                    result.repos++;
                    const seen: number[] = [];
                    for (const g of page.issues) {
                        const change = await this.applyIssue(repo, {
                            nodeId: g.nodeId, number: g.number, url: g.htmlUrl, title: g.title, body: g.body,
                            open: g.state === 'open', authorLogin: g.authorLogin, labels: g.labels,
                        });
                        seen.push(g.number);
                        if (change === 'created' || change === 'updated') result.upserted++;
                        if (change === 'withdrawn') result.withdrawn++;
                    }
                    if (page.complete) result.withdrawn += await this.withdrawMissing(repo.id, seen);
                } catch (e) {
                    result.skipped++;
                    this.logger.warn(`Intake sweep of ${repo.fullName} failed: ${errorMessage(e)}`);
                }
            }
            return result;
        } finally {
            this.sweeping = false;
        }
    }

    private async withdrawMissing(repoId: string, seen: number[]): Promise<number> {
        const stale = await this.items.find({
            where: { repoId, source: 'github_issue', status: Not(In(['withdrawn'])) },
            select: { id: true, number: true },
        });
        const ids = stale.filter((s) => !seen.includes(s.number)).map((s) => s.id);
        if (ids.length) await this.items.update({ id: In(ids) }, { status: 'withdrawn' });
        return ids.length;
    }

    private async getOrFail(id: string): Promise<IntakeItem> {
        const item = await this.items.findOne({ where: { id }, relations: { repo: true } });
        if (!item) throw new NotFoundException(`Intake item ${id} not found`);
        return item;
    }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
