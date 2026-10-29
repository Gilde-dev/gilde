import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Feature } from '../feature/feature.entity.js';
import { Feedback } from '../feedback/feedback.entity.js';
import { GitHubRequestError, type GitHubPort } from '../github/github.port.js';
import { Job } from '../job/job.entity.js';
import { Notification } from '../notification/notification.entity.js';
import { Project } from '../project/project.entity.js';
import { GithubInstallation } from '../repo/github-installation.entity.js';
import { Repo } from '../repo/repo.entity.js';
import { JobRun } from '../run/run.entity.js';
import { SpecApproval } from '../spec/spec-approval.entity.js';
import { SpecRecording } from '../spec/spec-recording.entity.js';
import { SpecVersion } from '../spec/spec-version.entity.js';
import { Spec } from '../spec/spec.entity.js';
import { User } from '../user/user.entity.js';
import { WebhookDelivery } from '../webhook/webhook-delivery.entity.js';
import { commentMarker, renderStatusComment, safeCommentError, type IntakeCommentView } from './intake-comment.js';
import { IntakeCommentService } from './intake-comment.service.js';
import { refineSha } from './intake-issue.js';
import { IntakeItem } from './intake-item.entity.js';

const SECRET_BODY = 'FULL-SPEC-BODY-SECRET sk-live-123';
const view = (over: Partial<IntakeCommentView> = {}): IntakeCommentView => ({
    itemId: 'item-1', status: 'waiting for answers', failure: null,
    spec: {
        title: 'Export [CSV]', version: 2, link: 'http://web.test/specs/s1?project=p1', criteria: 3, summary: 'Export the list as CSV.',
        openQuestions: ['Which delimiter?', 'Include headers?'],
    },
    ...over,
});

describe('renderStatusComment', () => {
    it('starts with the hidden marker and shows link, version, status, criteria and the numbered questions verbatim', () => {
        const text = renderStatusComment(view());
        expect(text.startsWith(commentMarker('item-1'))).toBe(true);
        expect(text).toContain('[Export \\[CSV\\]](http://web.test/specs/s1?project=p1)');
        expect(text).toContain('version 2');
        expect(text).toContain('**waiting for answers**');
        expect(text).toContain('3 acceptance criteria: Export the list as CSV.');
        expect(text).toContain('1. Which delimiter?\n2. Include headers?');
        expect(text).toContain('Reply to this issue with your answers (for example `1. …`); Gilde will update the spec.');
    });

    it.each(['draft', 'ready to approve', 'approved', 'planned'] as const)('renders status %s without questions or instructions to answer', (status) => {
        const text = renderStatusComment(view({ status, spec: { ...view().spec!, openQuestions: [] } }));
        expect(text).toContain(`**${status}**`);
        expect(text).not.toContain('Open questions');
        expect(text).not.toContain('Reply to this issue');
    });

    it('renders a failed refine with its safe reason and without a spec', () => {
        const text = renderStatusComment({ itemId: 'item-1', status: 'refine failed', spec: null, failure: 'Gilde could not draft a spec. The run failed.' });
        expect(text).toContain('**refine failed**');
        expect(text).toContain('The run failed.');
    });

    it('never carries a spec body, even if one leaks into the view fields it does not use', () => {
        expect(renderStatusComment({ ...view(), ...{ body: SECRET_BODY } } as IntakeCommentView)).not.toContain('SECRET');
    });

    it('renders answers received with the previous questions marked as being updated', () => {
        const text = renderStatusComment(view({ status: 'answers received' }));
        expect(text).toContain('**answers received**');
        expect(text).toContain('Answers received, updating the spec.');
        expect(text).toContain('Previous open questions (being updated)');
        expect(text).toContain('1. Which delimiter?');
        expect(text).not.toContain('Reply to this issue');
    });

    it('renders a withdrawn item with its reason and no spec details', () => {
        const text = renderStatusComment({ itemId: 'item-1', status: 'no longer refined', spec: view().spec, failure: null, reason: 'label removed' });
        expect(text.startsWith(commentMarker('item-1'))).toBe(true);
        expect(text).toContain('This issue is no longer being refined by Gilde (label removed).');
        expect(text).not.toContain('Which delimiter');
    });

    it('maps errors to short safe sentences', () => {
        expect(safeCommentError(new GitHubRequestError('GitHub POST x failed: 403', 403))).toContain('Issues: write');
        expect(safeCommentError(new GitHubRequestError('GitHub POST x failed: 502', 502))).toBe('GitHub could not write the status comment (HTTP 502).');
        expect(safeCommentError(new Error('Bearer ghs_secret exploded'))).toBe('The status comment could not be written.');
        expect(safeCommentError(new Error('the Gilde GitHub App is not installed on o/r'))).toContain('not installed');
    });
});

describe('IntakeCommentService', () => {
    let ds: DataSource;
    let items: Repository<IntakeItem>;
    let item: IntakeItem;
    let spec: Spec;
    let upsert: ReturnType<typeof vi.fn>;
    let service: IntakeCommentService;
    let clock: Date;

    const specBody = (questions: string) => `## Goal\n\nExport the list as CSV.\n\n## Context\n\nFrom the issue.\n\n## Behaviour\n\nA button. ${SECRET_BODY}\n\n## Acceptance criteria\n\n- AC-1: Downloads a CSV.\n- AC-2: Has a header row.\n\n## Out of scope\n\nOther formats.\n\n## Open questions\n\n${questions}\n`;

    beforeEach(async () => {
        process.env.WEB_ORIGIN = 'http://web.test/';
        ds = await new DataSource({
            type: 'better-sqlite3', database: ':memory:', synchronize: true,
            entities: [User, Project, Repo, Job, JobRun, Feedback, Feature, Notification, GithubInstallation, WebhookDelivery, IntakeItem, Spec, SpecVersion, SpecApproval, SpecRecording],
        }).initialize();
        items = ds.getRepository(IntakeItem);
        const project = await ds.getRepository(Project).save(ds.getRepository(Project).create({ slug: 'p', name: 'P' }));
        const repo = await ds.getRepository(Repo).save(ds.getRepository(Repo).create({ projectId: project.id, fullName: 'o/r' }));
        spec = await ds.getRepository(Spec).save(ds.getRepository(Spec).create({ projectId: project.id, repoId: repo.id, slug: 'issue-7', title: 'Export CSV', status: 'draft', currentVersion: 1, approvedVersion: null }));
        await ds.getRepository(SpecVersion).save(ds.getRepository(SpecVersion).create({ specId: spec.id, version: 1, title: 'Export CSV', body: specBody('1. Which delimiter?\n2. Include headers?'), bodySha256: 'x'.repeat(64), criteriaNumbers: [1, 2] }));
        item = await items.save(items.create({
            projectId: project.id, repoId: repo.id, source: 'github_issue', externalId: 'I_1', number: 7, url: 'https://github.com/o/r/issues/7',
            title: 'Export', body: 'b', bodySha256: 'a'.repeat(64), status: 'drafted', specId: spec.id,
        }));
        upsert = vi.fn(async (_repo: string, number: number) => ({ id: '9001', htmlUrl: `https://github.com/o/r/issues/${number}#issuecomment-9001` }));
        service = new IntakeCommentService(items, ds.getRepository(Spec), ds.getRepository(SpecVersion), ds.getRepository(Feature), { isConfigured: () => true, upsertIssueComment: upsert } as unknown as GitHubPort);
        clock = new Date('2026-10-29T10:00:00Z');
        service.now = () => clock;
    });
    afterEach(async () => { delete process.env.WEB_ORIGIN; await ds.destroy(); });

    const reload = () => items.findOneByOrFail({ id: item.id });
    const setBody = (body: string) => ds.query('UPDATE spec_versions SET body = ? WHERE spec_id = ?', [body, spec.id]);
    const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

    it('posts one comment with the link from WEB_ORIGIN, the questions and no body, and stores its id and url', async () => {
        await service.sync(item.id);
        expect(upsert).toHaveBeenCalledTimes(1);
        const [fullName, number, input] = upsert.mock.calls[0];
        expect([fullName, number]).toEqual(['o/r', 7]);
        expect(input).toMatchObject({ marker: commentMarker(item.id), commentId: null });
        expect(input.body).toContain(`http://web.test/specs/${spec.id}?project=${item.projectId}`);
        expect(input.body).toContain('**waiting for answers**');
        expect(input.body).toContain('1. Which delimiter?\n2. Include headers?');
        expect(input.body).toContain('2 acceptance criteria: Export the list as CSV.');
        expect(input.body).not.toContain('SECRET');
        expect(await reload()).toMatchObject({ statusCommentId: '9001', statusCommentUrl: 'https://github.com/o/r/issues/7#issuecomment-9001', commentError: null });
    });

    it('does not write again when the rendered content is unchanged', async () => {
        await service.sync(item.id);
        advance(5 * 60_000);
        await service.sync(item.id);
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('updates the stored comment in place when the content changed, passing its id', async () => {
        await service.sync(item.id);
        await setBody(specBody('None'));
        advance(2 * 60_000);
        await service.sync(item.id);
        expect(upsert).toHaveBeenCalledTimes(2);
        expect(upsert.mock.calls[1][2]).toMatchObject({ commentId: '9001' });
        expect(upsert.mock.calls[1][2].body).toContain('**ready to approve**');
    });

    it('says approved and planned', async () => {
        await ds.getRepository(Spec).update({ id: spec.id }, { status: 'approved', approvedVersion: 1 });
        await service.sync(item.id);
        expect(upsert.mock.calls[0][2].body).toContain('**approved**');
        await ds.getRepository(Feature).save(ds.getRepository(Feature).create({ projectId: item.projectId, title: 'F', spec: 's', acceptanceCriteria: [], specId: spec.id, specVersion: 1 }));
        advance(2 * 60_000);
        await service.sync(item.id);
        expect(upsert.mock.calls[1][2].body).toContain('**planned**');
    });

    it('holds a second different write inside a minute back, then writes it from the pending flush', async () => {
        await service.sync(item.id);
        await setBody(specBody('None'));
        advance(10_000);
        await service.sync(item.id);
        expect(upsert).toHaveBeenCalledTimes(1);
        expect((await reload()).statusCommentPending).toBe(true);
        await service.flushPending();
        expect(upsert).toHaveBeenCalledTimes(1); // still within the minute
        advance(60_000);
        await service.flushPending();
        expect(upsert).toHaveBeenCalledTimes(2);
        expect((await reload()).statusCommentPending).toBe(false);
    });

    it('posts a failed refine with a safe reason and nothing from lastError', async () => {
        await items.update({ id: item.id }, { status: 'failed', lastError: 'Bearer ghs_topsecret exploded' });
        await service.sync(item.id);
        const body = upsert.mock.calls[0][2].body as string;
        expect(body).toContain('**refine failed**');
        expect(body).not.toContain('ghs_topsecret');
    });

    it('says nothing for an item without a draft that did not fail', async () => {
        await items.update({ id: item.id }, { specId: null });
        await service.sync(item.id);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('records a short commentError when GitHub refuses, keeps the item and retries on the next outcome', async () => {
        upsert.mockRejectedValueOnce(new GitHubRequestError('GitHub POST failed: 403', 403));
        await expect(service.sync(item.id)).resolves.toBeUndefined();
        const failed = await reload();
        expect(failed.commentError).toContain('Issues: write');
        expect(failed.status).toBe('drafted');
        expect(failed.specId).toBe(spec.id);
        advance(2 * 60_000);
        await service.sync(item.id);
        expect(await reload()).toMatchObject({ commentError: null, statusCommentId: '9001' });
    });

    it('syncForSpec refreshes the items of that spec and never throws', async () => {
        await service.syncForSpec(spec.id);
        expect(upsert).toHaveBeenCalledTimes(1);
        upsert.mockRejectedValue(new Error('boom'));
        advance(2 * 60_000);
        await setBody(specBody('None'));
        await expect(service.syncForSpec(spec.id)).resolves.toBeUndefined();
    });

    describe('answers, withdrawn and ignored', () => {
        const answer = { id: '1', author: 'maint', body: 'semicolons', createdAt: '2026-10-29T09:00:00Z' };
        const texts = () => upsert.mock.calls.map((c) => c[2].body as string);

        it('says answers received right away, no-ops on a repeat, and the refine outcome replaces it', async () => {
            await service.sync(item.id);
            await items.update({ id: item.id }, { status: 'new', refinedSha256: 'old', comments: [answer] });
            advance(2 * 60_000);
            await service.sync(item.id);
            expect(texts()[1]).toContain('Answers received, updating the spec.');
            expect(texts()[1]).toContain('Previous open questions (being updated)');
            advance(2 * 60_000);
            await service.sync(item.id);
            expect(upsert).toHaveBeenCalledTimes(2);
            await setBody(specBody('None'));
            await items.update({ id: item.id }, { status: 'drafted', refinedSha256: refineSha(await reload()) });
            advance(2 * 60_000);
            await service.sync(item.id);
            expect(texts()[2]).toContain('**ready to approve**');
            expect(texts()[2]).not.toContain('Answers received');
        });

        it('holds the answers received update to one write per minute', async () => {
            await service.sync(item.id);
            await items.update({ id: item.id }, { status: 'new', refinedSha256: 'old', comments: [answer] });
            advance(10_000);
            await service.sync(item.id);
            expect(upsert).toHaveBeenCalledTimes(1);
            expect((await reload()).statusCommentPending).toBe(true);
        });

        it.each([
            ['withdrawn', ['gilde:refine'], 'issue closed'],
            ['withdrawn', [], 'label removed'],
            ['ignored', ['gilde:refine'], 'ignored in Gilde'],
        ] as const)('updates the comment once for %s (%s) and returns to the normal status afterwards', async (status, labels, reason) => {
            await service.sync(item.id);
            await items.update({ id: item.id }, { status, labels: [...labels] });
            advance(2 * 60_000);
            await service.sync(item.id);
            await service.sync(item.id);
            expect(upsert).toHaveBeenCalledTimes(2);
            expect(texts()[1]).toContain(`This issue is no longer being refined by Gilde (${reason}).`);
            expect(upsert.mock.calls[1][2]).toMatchObject({ commentId: '9001', marker: commentMarker(item.id) });
            await items.update({ id: item.id }, { status: 'drafted', labels: ['gilde:refine'] });
            advance(2 * 60_000);
            await service.sync(item.id);
            expect(texts()[2]).toContain('**waiting for answers**');
        });

        it.each(['withdrawn', 'ignored'] as const)('writes no comment for a %s item that never had one', async (status) => {
            await items.update({ id: item.id }, { status });
            await service.sync(item.id);
            expect(upsert).not.toHaveBeenCalled();
        });

        it('records commentError instead of throwing when the withdrawn update fails', async () => {
            await service.sync(item.id);
            await items.update({ id: item.id }, { status: 'withdrawn' });
            upsert.mockRejectedValueOnce(new GitHubRequestError('GitHub PATCH failed: 403', 403));
            advance(2 * 60_000);
            await expect(service.sync(item.id)).resolves.toBeUndefined();
            expect(await reload()).toMatchObject({ status: 'withdrawn', commentError: expect.stringContaining('Issues: write') });
        });
    });

    it('does nothing without GitHub credentials', async () => {
        const off = new IntakeCommentService(items, ds.getRepository(Spec), ds.getRepository(SpecVersion), ds.getRepository(Feature), { isConfigured: () => false, upsertIssueComment: upsert } as unknown as GitHubPort);
        await off.sync(item.id);
        expect(upsert).not.toHaveBeenCalled();
    });
});
