import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '../auth/auth.dto.js';
import { Feature } from '../feature/feature.entity.js';
import type { GitHubIssue, GitHubPort } from '../github/github.port.js';
import { Job } from '../job/job.entity.js';
import { Notification } from '../notification/notification.entity.js';
import { Project } from '../project/project.entity.js';
import type { ProjectService } from '../project/project.service.js';
import { GithubInstallation } from '../repo/github-installation.entity.js';
import { GithubInstallationService } from '../repo/github-installation.service.js';
import { Repo } from '../repo/repo.entity.js';
import type { RepoService } from '../repo/repo.service.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import type { UserService } from '../user/user.service.js';
import { WebhookDelivery } from '../webhook/webhook-delivery.entity.js';
import { WebhookService } from '../webhook/webhook.service.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { IntakeItem } from './intake-item.entity.js';
import { IntakeRefineRun } from './intake-refine-run.entity.js';
import { IntakeRefineService } from './intake-refine.service.js';
import { INTAKE_BODY_LIMIT, INTAKE_COMMENT_LIMIT, INTAKE_COMMENT_MAX, capBody, hasIntakeLabel, issueSha, refineSha, type IntakeIssue } from './intake-issue.js';
import { IntakeMapper } from './intake.mapper.js';
import { IntakeService } from './intake.service.js';

let ds: DataSource;
let items: Repository<IntakeItem>;
let repos: Repository<Repo>;
let repo: Repo;
let service: IntakeService;
let webhook: WebhookService;
let pages: Map<string, { issues: GitHubIssue[]; complete: boolean } | Error>;
let configured: boolean;
let syncSpy: ReturnType<typeof vi.fn>;
let requireHuman: ReturnType<typeof vi.fn>;

const issue = (over: Partial<IntakeIssue> = {}): IntakeIssue => ({
    nodeId: 'I_1', number: 7, url: 'https://github.com/o/r/issues/7', title: 'Add X', body: 'Please add X',
    open: true, authorLogin: 'octo', labels: ['gilde:refine'], ...over,
});
const ghIssue = (over: Partial<GitHubIssue> = {}): GitHubIssue => ({
    nodeId: 'I_1', number: 7, htmlUrl: 'https://github.com/o/r/issues/7', title: 'Add X', body: 'Please add X',
    state: 'open', authorLogin: 'octo', labels: ['gilde:refine'], ...over,
});
const payload = (action: string, over: Record<string, unknown> = {}, fullName = 'o/r') => ({
    action,
    repository: { full_name: fullName },
    issue: {
        number: 7, node_id: 'I_1', html_url: 'https://github.com/o/r/issues/7', title: 'Add X', body: 'Please add X',
        state: 'open', user: { login: 'octo' }, labels: [{ name: 'gilde:refine' }], ...over,
    },
});
const all = () => items.find({ order: { number: 'ASC' } });

beforeEach(async () => {
    delete process.env.INTAKE_LABEL;
    ds = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', synchronize: true,
        entities: [User, Project, Repo, Job, JobRun, Feedback, Feature, Notification, GithubInstallation, WebhookDelivery, IntakeItem, IntakeRefineRun],
    }).initialize();
    items = ds.getRepository(IntakeItem);
    repos = ds.getRepository(Repo);
    const project = await ds.getRepository(Project).save(ds.getRepository(Project).create({ slug: 'p', name: 'P' }));
    repo = await repos.save(repos.create({ projectId: project.id, fullName: 'o/r' }));
    pages = new Map();
    configured = true;
    const github = {
        isConfigured: () => configured,
        listOpenIssuesWithLabel: vi.fn(async (name: string) => {
            const page = pages.get(name) ?? { issues: [], complete: true };
            if (page instanceof Error) throw page;
            return page;
        }),
    } as unknown as GitHubPort;
    requireHuman = vi.fn(async (user: AuthUser | undefined) => {
        if (user?.credential !== 'jwt') throw new ForbiddenException('A verified human is required');
        return { id: user.id };
    });
    const installations = new GithubInstallationService(ds.getRepository(GithubInstallation), { mode: 'app' } as never);
    service = new IntakeService(
        items, repos, github, installations,
        { assertExists: async () => undefined } as unknown as ProjectService,
        { requireVerifiedHuman: requireHuman } as unknown as UserService,
        new IntakeMapper(), undefined, undefined, { sync: syncSpy = vi.fn(async () => undefined) } as never,
    );
    const repoService = { findByFullName: (n: string) => repos.findOneBy({ fullName: n.toLowerCase() }) } as unknown as RepoService;
    webhook = new WebhookService(
        repoService, undefined as never, undefined as never, undefined as never, ds.getRepository(Project),
        undefined as never, undefined, installations, service,
        { isOwnApp: (id: unknown) => String(id) === '4242' } as never,
    );
});

afterEach(() => { delete process.env.INTAKE_LABEL; return ds.destroy(); });

describe('issue helpers', () => {
    it('matches the label case-insensitively and honours INTAKE_LABEL', () => {
        expect(hasIntakeLabel(['bug', 'Gilde:Refine'])).toBe(true);
        expect(hasIntakeLabel(['bug'])).toBe(false);
        process.env.INTAKE_LABEL = 'Spec-Me';
        expect(hasIntakeLabel(['spec-me'])).toBe(true);
        expect(hasIntakeLabel(['gilde:refine'])).toBe(false);
    });

    it('caps the body and hashes title + the full body', () => {
        expect(capBody(null)).toEqual({ body: '', truncated: false });
        expect(capBody('x'.repeat(INTAKE_BODY_LIMIT))).toMatchObject({ truncated: false });
        const capped = capBody('x'.repeat(INTAKE_BODY_LIMIT + 5));
        expect(capped.body).toHaveLength(INTAKE_BODY_LIMIT);
        expect(capped.truncated).toBe(true);
        expect(issueSha('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
        expect(issueSha('a', 'b')).not.toBe(issueSha('a', 'c'));
        expect(issueSha('a', 'b')).not.toBe(issueSha('b', 'a'));
        expect(issueSha('t', 'x'.repeat(INTAKE_BODY_LIMIT) + '1')).not.toBe(issueSha('t', 'x'.repeat(INTAKE_BODY_LIMIT) + '2'));
    });
});

describe('applyIssue', () => {
    it('stores a labelled issue as new with cap, sha and links, and is idempotent', async () => {
        expect(await service.applyIssue(repo, issue({ body: 'y'.repeat(INTAKE_BODY_LIMIT + 1) }))).toBe('created');
        expect(await service.applyIssue(repo, issue({ body: 'y'.repeat(INTAKE_BODY_LIMIT + 1) }))).toBe('unchanged');
        const [item] = await all();
        expect(await items.count()).toBe(1);
        expect(item).toMatchObject({
            projectId: repo.projectId, repoId: repo.id, source: 'github_issue', externalId: 'I_1', number: 7,
            url: 'https://github.com/o/r/issues/7', title: 'Add X', bodyTruncated: true, authorLogin: 'octo',
            labels: ['gilde:refine'], status: 'new', specId: null, lastError: null, refineAttempts: 0, refinedSha256: null,
        });
        expect(item!.body).toHaveLength(INTAKE_BODY_LIMIT);
        expect(item!.bodySha256).toBe(issueSha('Add X', 'y'.repeat(INTAKE_BODY_LIMIT + 1)));
    });

    it('never stores unlabelled or closed issues', async () => {
        expect(await service.applyIssue(repo, issue({ labels: ['bug'] }))).toBe('unchanged');
        expect(await service.applyIssue(repo, issue({ open: false }))).toBe('unchanged');
        expect(await items.count()).toBe(0);
    });

    it('accepts the label in any case', async () => {
        await service.applyIssue(repo, issue({ labels: ['GILDE:REFINE'] }));
        expect(await items.count()).toBe(1);
    });

    it('withdraws on unlabel or close and sets new again on relabel or reopen', async () => {
        await service.applyIssue(repo, issue());
        expect(await service.applyIssue(repo, issue({ labels: [] }))).toBe('withdrawn');
        expect((await all())[0]!.status).toBe('withdrawn');
        expect(await service.applyIssue(repo, issue({ labels: [] }))).toBe('unchanged');
        expect(await service.applyIssue(repo, issue())).toBe('updated');
        expect((await all())[0]!.status).toBe('new');
        expect(await service.applyIssue(repo, issue({ open: false }))).toBe('withdrawn');
        expect(await service.applyIssue(repo, issue())).toBe('updated');
        expect((await all())[0]!.status).toBe('new');
    });

    it('sets new again only when title or body changed, and resets error and attempts', async () => {
        await service.applyIssue(repo, issue());
        await items.update({ number: 7 }, { status: 'drafted', refinedSha256: issueSha('Add X', 'Please add X'), refineAttempts: 2, lastError: 'boom' });
        expect(await service.applyIssue(repo, issue())).toBe('unchanged');
        expect((await all())[0]!.status).toBe('drafted');

        expect(await service.applyIssue(repo, issue({ title: 'Add X please' }))).toBe('updated');
        let item = (await all())[0]!;
        expect(item).toMatchObject({ status: 'new', title: 'Add X please', lastError: null, refineAttempts: 0 });
        expect(item.bodySha256).toBe(issueSha('Add X please', 'Please add X'));

        await items.update({ number: 7 }, { status: 'refining' });
        await service.applyIssue(repo, issue({ title: 'Add X please', body: 'new body' }));
        item = (await all())[0]!;
        expect(item).toMatchObject({ status: 'new', body: 'new body' });
    });

    it('treats an edit that only changes labels as no status change', async () => {
        await service.applyIssue(repo, issue());
        await items.update({ number: 7 }, { status: 'drafted' });
        expect(await service.applyIssue(repo, issue({ labels: ['gilde:refine', 'bug'] }))).toBe('updated');
        const item = (await all())[0]!;
        expect(item.status).toBe('drafted');
        expect(item.labels).toEqual(['gilde:refine', 'bug']);
    });

    it('keeps an item ignored by a human ignored, also when edited, but still stores the new text', async () => {
        await service.applyIssue(repo, issue());
        await items.update({ number: 7 }, { status: 'ignored' });
        expect(await service.applyIssue(repo, issue())).toBe('unchanged');
        expect(await service.applyIssue(repo, issue({ body: 'edited' }))).toBe('ignored');
        expect((await all())[0]).toMatchObject({ status: 'ignored', body: 'edited' });
    });
});

describe('issues webhook', () => {
    it.each(['opened', 'edited', 'labeled', 'unlabeled', 'closed', 'reopened'])('handles %s', async (action) => {
        const result = await webhook.handle('issues', payload(action));
        expect(result).toContain('intake');
        expect(result).not.toContain('ignored');
    });

    it('ignores other actions, pull requests and unregistered repos, and stores nothing', async () => {
        expect(await webhook.handle('issues', payload('assigned'))).toContain('ignored: issues assigned');
        expect(await webhook.handle('issues', payload('opened', { pull_request: {} }))).toContain('pull request');
        expect(await webhook.handle('issues', payload('opened', {}, 'o/unknown'))).toContain('unknown repo');
        expect(await webhook.handle('issues', { action: 'opened', repository: { full_name: 'o/r' } })).toContain('ignored');
        expect(await items.count()).toBe(0);
    });

    it('follows the label, close and reopen rules and finds the repo in any case', async () => {
        await webhook.handle('issues', payload('opened', {}, 'O/R'));
        expect((await all())[0]!.status).toBe('new');
        await webhook.handle('issues', payload('unlabeled', { labels: [] }));
        expect((await all())[0]!.status).toBe('withdrawn');
        await webhook.handle('issues', payload('labeled'));
        expect((await all())[0]!.status).toBe('new');
        await webhook.handle('issues', payload('closed', { state: 'closed' }));
        expect((await all())[0]!.status).toBe('withdrawn');
        await webhook.handle('issues', payload('reopened'));
        expect((await all())[0]!.status).toBe('new');
    });

    it('does not store an unlabelled opened issue, and a redelivery changes nothing', async () => {
        await webhook.handle('issues', payload('opened', { labels: [{ name: 'bug' }] }));
        expect(await items.count()).toBe(0);
        await webhook.handle('issues', payload('opened'));
        await webhook.handle('issues', payload('opened'));
        expect(await items.count()).toBe(1);
    });

    it('edited with no change keeps the status, with a change sets new', async () => {
        await webhook.handle('issues', payload('opened'));
        await items.update({ number: 7 }, { status: 'drafted' });
        await webhook.handle('issues', payload('edited'));
        expect((await all())[0]!.status).toBe('drafted');
        await webhook.handle('issues', payload('edited', { body: 'changed' }));
        expect((await all())[0]!.status).toBe('new');
    });
});

describe('issue comments', () => {
    const commentPayload = (action: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, issueOver: Record<string, unknown> = {}) => ({
        action,
        repository: { full_name: 'o/r' },
        issue: { number: 7, html_url: 'https://github.com/o/r/issues/7', ...issueOver },
        comment: { id: 501, body: 'Answers: 1. semicolons', author_association: 'MEMBER', user: { login: 'maint', type: 'User' }, created_at: '2026-10-29T10:00:00Z', ...over },
        sender: { type: 'User' },
        ...extra,
    });
    const settle = async (status: IntakeItem['status'], over: Partial<IntakeItem> = {}) => items.update({ number: 7 }, { status, refinedSha256: 'x', ...over });

    beforeEach(async () => { await service.applyIssue(repo, issue()); await settle('drafted'); });

    it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('stores a %s comment and sets the item back to new', async (association) => {
        const result = await webhook.handle('issue_comment', commentPayload('created', { author_association: association }));
        expect(result).toBe('intake comment stored for issue #7');
        const [item] = await all();
        expect(item).toMatchObject({ status: 'new', refineAttempts: 0, lastError: null });
        expect(item!.comments).toEqual([{ id: '501', author: 'maint', body: 'Answers: 1. semicolons', createdAt: '2026-10-29T10:00:00.000Z' }]);
    });

    it.each(['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', undefined])('ignores a %s commenter and stores nothing', async (association) => {
        const result = await webhook.handle('issue_comment', commentPayload('created', { author_association: association }));
        expect(result).toContain('ignored');
        const [item] = await all();
        expect(item!.comments).toEqual([]);
        expect(item!.status).toBe('drafted');
    });

    it('ignores comments of the app itself and of other bots, even with a trusted association', async () => {
        expect(await webhook.handle('issue_comment', commentPayload('created', { author_association: 'MEMBER', performed_via_github_app: { id: 4242 } }))).toContain('ignored');
        expect(await webhook.handle('issue_comment', commentPayload('edited', { author_association: 'OWNER', user: { login: 'gilde[bot]', type: 'Bot' } }, { sender: { type: 'Bot' } }))).toContain('bot');
        const [item] = await all();
        expect(item).toMatchObject({ comments: [], status: 'drafted' });
    });

    it('ignores comments on issues without an intake item, on withdrawn items, and other actions', async () => {
        expect(await webhook.handle('issue_comment', commentPayload('created', {}, {}, { number: 99 }))).toContain('ignored');
        await settle('withdrawn');
        expect(await webhook.handle('issue_comment', commentPayload('created'))).toContain('ignored');
        const [item] = await all();
        expect(item).toMatchObject({ comments: [], status: 'withdrawn' });
    });

    it('syncs the status comment when a counted comment is stored, not for an unchanged re-delivery or an ignored item', async () => {
        await webhook.handle('issue_comment', commentPayload('created'));
        expect(syncSpy).toHaveBeenCalledTimes(1);
        await webhook.handle('issue_comment', commentPayload('created'));
        expect(syncSpy).toHaveBeenCalledTimes(1);
        await settle('ignored');
        await webhook.handle('issue_comment', commentPayload('created', { id: 502 }));
        expect(syncSpy).toHaveBeenCalledTimes(1);
    });

    it('deleting a stored comment removes it and re-queues the item, and the sha loses the answer', async () => {
        await webhook.handle('issue_comment', commentPayload('created'));
        await webhook.handle('issue_comment', commentPayload('created', { id: 502, body: 'second' }));
        await settle('drafted');
        syncSpy.mockClear();
        expect(await webhook.handle('issue_comment', commentPayload('deleted'))).toBe('intake comment removed for issue #7');
        const [item] = await all();
        expect(item!.comments.map((c) => c.id)).toEqual(['502']);
        expect(item).toMatchObject({ status: 'new', refineAttempts: 0 });
        expect(syncSpy).toHaveBeenCalledTimes(1);
    });

    it('deleting an unknown id, an untrusted comment, or on an ignored or withdrawn item changes nothing', async () => {
        await webhook.handle('issue_comment', commentPayload('created'));
        await settle('drafted');
        syncSpy.mockClear();
        expect(await webhook.handle('issue_comment', commentPayload('deleted', { id: 999 }))).toBe('intake comment unchanged for issue #7');
        expect(await webhook.handle('issue_comment', commentPayload('deleted', { id: 999, author_association: 'NONE' }))).toBe('intake comment unchanged for issue #7');
        expect(await webhook.handle('issue_comment', commentPayload('deleted', { id: 999 }, {}, { number: 99 }))).toContain('ignored');
        expect((await all())[0]).toMatchObject({ status: 'drafted' });
        await settle('ignored');
        await webhook.handle('issue_comment', commentPayload('deleted'));
        const [ignored] = await all();
        expect(ignored).toMatchObject({ status: 'ignored', comments: [] });
        await settle('withdrawn');
        expect(await webhook.handle('issue_comment', commentPayload('deleted'))).toContain('ignored');
        expect(syncSpy).not.toHaveBeenCalled();
    });

    it('keeps an ignored item ignored but stores the comment', async () => {
        await settle('ignored');
        await webhook.handle('issue_comment', commentPayload('created'));
        const [item] = await all();
        expect(item).toMatchObject({ status: 'ignored' });
        expect(item!.comments).toHaveLength(1);
    });

    it('replaces an edited comment by id, and an unchanged re-delivery changes nothing', async () => {
        await webhook.handle('issue_comment', commentPayload('created'));
        await settle('drafted', { refinedSha256: refineSha((await all())[0]!) });
        expect(await webhook.handle('issue_comment', commentPayload('created'))).toBe('intake comment unchanged for issue #7');
        expect((await all())[0]!.status).toBe('drafted');

        expect(await webhook.handle('issue_comment', commentPayload('edited', { body: 'Answers: 1. tabs' }))).toBe('intake comment stored for issue #7');
        const [item] = await all();
        expect(item!.comments).toHaveLength(1);
        expect(item!.comments[0]!.body).toBe('Answers: 1. tabs');
        expect(item!.status).toBe('new');
    });

    it('caps a body at 4000 characters, keeps the 20 most recent oldest first', async () => {
        await webhook.handle('issue_comment', commentPayload('created', { id: 1, body: 'x'.repeat(INTAKE_COMMENT_LIMIT + 50) }));
        expect((await all())[0]!.comments[0]!.body).toHaveLength(INTAKE_COMMENT_LIMIT);
        for (let i = 2; i <= INTAKE_COMMENT_MAX + 5; i++) {
            await webhook.handle('issue_comment', commentPayload('created', { id: i, body: `c${i}`, created_at: new Date(Date.UTC(2026, 9, 29, 10, i)).toISOString() }));
        }
        const comments = (await all())[0]!.comments;
        expect(comments).toHaveLength(INTAKE_COMMENT_MAX);
        expect(comments.map((c) => c.id)).toEqual(Array.from({ length: INTAKE_COMMENT_MAX }, (_, i) => String(i + 6)));
    });

    it('includes the comments in the refine sha: a new answer changes it, the same data does not', async () => {
        const [before] = await all();
        expect(refineSha(before!)).toBe(before!.bodySha256);
        await webhook.handle('issue_comment', commentPayload('created'));
        const sha1 = refineSha((await all())[0]!);
        expect(sha1).not.toBe(before!.bodySha256);
        await webhook.handle('issue_comment', commentPayload('created'));
        expect(refineSha((await all())[0]!)).toBe(sha1);
        await webhook.handle('issue_comment', commentPayload('created', { id: 502 }));
        expect(refineSha((await all())[0]!)).not.toBe(sha1);
    });

    it('does not select a refined item again for an unchanged comment, but does after a new one', async () => {
        const refiner = new IntakeRefineService(items, ds.getRepository(IntakeRefineRun));
        await webhook.handle('issue_comment', commentPayload('created'));
        expect((await refiner.nextPerProject()).map((i) => i.number)).toEqual([7]);
        await items.update({ number: 7 }, { status: 'drafted', refinedSha256: refineSha((await all())[0]!) });
        await webhook.handle('issue_comment', commentPayload('created'));
        await items.update({ number: 7 }, { status: 'new' });
        expect(await refiner.nextPerProject()).toEqual([]);
        await webhook.handle('issue_comment', commentPayload('created', { id: 777, body: 'more' }));
        expect((await refiner.nextPerProject()).map((i) => i.number)).toEqual([7]);
    });
});

describe('sweep', () => {
    it('upserts labelled open issues and is idempotent', async () => {
        pages.set('o/r', { issues: [ghIssue(), ghIssue({ nodeId: 'I_2', number: 8, title: 'Other' })], complete: true });
        expect(await service.sweep()).toEqual({ repos: 1, skipped: 0, upserted: 2, withdrawn: 0 });
        expect(await service.sweep()).toEqual({ repos: 1, skipped: 0, upserted: 0, withdrawn: 0 });
        expect((await all()).map((i) => i.number)).toEqual([7, 8]);
    });

    it('withdraws items missing from a complete list, but not from an incomplete one', async () => {
        pages.set('o/r', { issues: [ghIssue(), ghIssue({ nodeId: 'I_2', number: 8 })], complete: true });
        await service.sweep();
        pages.set('o/r', { issues: [ghIssue()], complete: false });
        expect((await service.sweep()).withdrawn).toBe(0);
        pages.set('o/r', { issues: [ghIssue()], complete: true });
        expect((await service.sweep()).withdrawn).toBe(1);
        expect((await all()).map((i) => i.status)).toEqual(['new', 'withdrawn']);
    });

    it('skips repos the app is not installed on and repos GitHub cannot read', async () => {
        const other = await repos.save(repos.create({ projectId: repo.projectId, fullName: 'o/no-app' }));
        const broken = await repos.save(repos.create({ projectId: repo.projectId, fullName: 'o/broken' }));
        await ds.getRepository(GithubInstallation).save({ fullName: other.fullName, installed: false });
        pages.set('o/broken', new Error('GitHub GET failed: 403'));
        pages.set('o/r', { issues: [ghIssue()], complete: true });
        expect(await service.sweep()).toEqual({ repos: 1, skipped: 2, upserted: 1, withdrawn: 0 });
        expect(broken.id).toBeDefined();
        expect(await items.count()).toBe(1);
    });

    it('does nothing without GitHub credentials', async () => {
        configured = false;
        expect(await service.sweep()).toEqual({ repos: 0, skipped: 0, upserted: 0, withdrawn: 0 });
    });
});

describe('ignore and retry', () => {
    const human = { id: 'u1', credential: 'jwt' } as AuthUser;
    const apiKey = { id: 'u1', credential: 'api_key' } as AuthUser;
    const seed = async (status: IntakeItem['status']) => {
        await service.applyIssue(repo, issue());
        await items.update({ number: 7 }, { status, lastError: 'boom', refineAttempts: 2, refinedSha256: 'abc' });
        return (await all())[0]!.id;
    };

    it('requires a verified human for writes', async () => {
        const id = await seed('failed');
        await expect(service.ignore(id, apiKey)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.retry(id, undefined)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.sweepAs(apiKey)).rejects.toBeInstanceOf(ForbiddenException);
        expect((await all())[0]!.status).toBe('failed');
    });

    it('retry sets new and clears the error; only failed or ignored items qualify', async () => {
        const id = await seed('failed');
        const dto = await service.retry(id, human);
        expect(dto).toMatchObject({ status: 'new', lastError: null, refineAttempts: 0, refinedSha256: null });
        await expect(service.retry(id, human)).rejects.toBeInstanceOf(ConflictException);
        await items.update({ id }, { status: 'ignored' });
        expect((await service.retry(id, human)).status).toBe('new');
    });

    it('ignore sets ignored, except for refining, ignored and withdrawn items', async () => {
        const id = await seed('drafted');
        expect((await service.ignore(id, human)).status).toBe('ignored');
        await expect(service.ignore(id, human)).rejects.toBeInstanceOf(ConflictException);
        await items.update({ id }, { status: 'refining' });
        await expect(service.ignore(id, human)).rejects.toBeInstanceOf(ConflictException);
    });

    it('syncs the status comment on ignore, retry, close, relabel and unlabel', async () => {
        const id = await seed('drafted');
        await service.ignore(id, human);
        await service.retry(id, human);
        expect(syncSpy).toHaveBeenCalledTimes(2);
        syncSpy.mockClear();
        expect(await service.applyIssue(repo, issue({ open: false }))).toBe('withdrawn');
        expect(await service.applyIssue(repo, issue({ open: false }))).toBe('unchanged');
        expect(syncSpy).toHaveBeenCalledTimes(1);
        await service.applyIssue(repo, issue());
        expect(syncSpy).toHaveBeenCalledTimes(2);
        await service.applyIssue(repo, issue({ labels: [] }));
        expect(syncSpy).toHaveBeenCalledTimes(3);
    });

    it('lists by status with the repo name and hides the body in the list', async () => {
        await seed('failed');
        await service.applyIssue(repo, issue({ nodeId: 'I_2', number: 8 }));
        const list = await service.list(repo.projectId, {});
        expect(list).toHaveLength(2);
        expect(list[0]).toMatchObject({ repoFullName: 'o/r' });
        expect(list[0]).not.toHaveProperty('body');
        expect((await service.list(repo.projectId, { status: 'failed' }))).toHaveLength(1);
        expect(await service.getById(list[0]!.id)).toHaveProperty('body');
    });
});
