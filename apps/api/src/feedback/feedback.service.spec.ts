import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feedback } from './feedback.entity.js';
import { FeedbackMapper } from './feedback.mapper.js';
import { FeedbackService, type NewFeedback } from './feedback.service.js';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const R1 = '33333333-3333-4333-8333-333333333333';
const R2 = '44444444-4444-4444-8444-444444444444';
const J1 = '55555555-5555-4555-8555-555555555555';

let ds: DataSource;
let service: FeedbackService;

const make = (githubId: string, over: Partial<NewFeedback> = {}): NewFeedback => ({
    jobId: J1, projectId: P1, repoId: R1, prNumber: 1, kind: 'comment', githubId, author: 'a', authorAssociation: 'OWNER',
    state: null, reviewId: null, path: null, line: null, body: '', url: 'u', createdAt: new Date('2026-10-01T10:00:00Z'), ...over,
});

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Feedback], synchronize: true }).initialize();
    service = new FeedbackService(new FeedbackMapper(), ds.getRepository(Feedback));
});
afterEach(() => ds.destroy());

describe('FeedbackService', () => {
    it('stores a (kind, githubId) pair once, but the same id for another kind', async () => {
        expect(await service.record(make('1'))).toBe(true);
        expect(await service.record(make('1'))).toBe(false);
        expect(await service.record(make('1', { kind: 'review' }))).toBe(true);
    });

    it('filters by projectId, repoId and since', async () => {
        await service.record(make('1', { createdAt: new Date('2026-10-01T10:00:00Z') }));
        await service.record(make('2', { createdAt: new Date('2026-10-02T10:00:00Z') }));
        await service.record(make('3', { projectId: P2, repoId: R2, createdAt: new Date('2026-10-03T10:00:00Z') }));
        const ids = async (q: Parameters<FeedbackService['list']>[0]) => (await service.list(q)).map((f) => f.githubId);
        expect(await ids({})).toEqual(['1', '2', '3']);
        expect(await ids({ projectId: P1 })).toEqual(['1', '2']);
        expect(await ids({ repoId: R2 })).toEqual(['3']);
        expect(await ids({ since: '2026-10-02T00:00:00.000Z' })).toEqual(['2', '3']);
        expect(await ids({ projectId: P1, since: '2026-10-02T00:00:00.000Z' })).toEqual(['2']);
    });

    it('lists a job\'s feedback ordered by createdAt', async () => {
        await service.record(make('late', { createdAt: new Date('2026-10-02T10:00:00Z') }));
        await service.record(make('early', { createdAt: new Date('2026-10-01T10:00:00Z') }));
        expect((await service.listForJob(J1)).map((f) => f.githubId)).toEqual(['early', 'late']);
    });
});
