import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { User } from '../user/user.entity.js';

import { Executor } from './executor.entity.js';
import { ExecutorMapper } from './executor.mapper.js';
import { ExecutorService } from './executor.service.js';

describe('ExecutorService.markExhausted', () => {
    let ds: DataSource;
    let repo: Repository<Executor>;
    let service: ExecutorService;
    let executor: Executor;

    beforeEach(async () => {
        ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [User, Executor], synchronize: true }).initialize();
        repo = ds.getRepository(Executor);
        service = new ExecutorService(repo, new ExecutorMapper(), {} as never, {} as never, {} as never);
        const owner = await ds.getRepository(User).save({ email: 'a@example.com', name: 'A', password: 'x' });
        executor = await repo.save(repo.create({ ownerId: owner.id, name: 'e', fireUrl: 'https://f', repoIds: [], maxConcurrent: 1, dailyRunLimit: null, enabled: true, tokenLast4: 'oken' }));
    });
    afterEach(() => ds.destroy());

    it('sets the given reset time and reports it only for the call that started the exhaustion', async () => {
        const now = new Date('2026-10-28T10:00:00Z');
        const reset = new Date('2026-10-28T12:00:00Z');
        expect(await service.markExhausted(executor.id, reset, now)).toEqual(reset);
        expect((await repo.findOneByOrFail({ id: executor.id })).exhaustedUntil).toEqual(reset);
        expect(await service.markExhausted(executor.id, new Date('2026-10-28T15:00:00Z'), now)).toBeNull();
        expect((await repo.findOneByOrFail({ id: executor.id })).exhaustedUntil).toEqual(reset);
    });

    it('falls back to now + the default backoff and exhausts again once the time has passed', async () => {
        const now = new Date('2026-10-28T10:00:00Z');
        expect(await service.markExhausted(executor.id, null, now)).toEqual(new Date('2026-10-28T11:00:00Z'));
        const later = new Date('2026-10-28T11:00:01Z');
        expect(await service.markExhausted(executor.id, null, later)).toEqual(new Date('2026-10-28T12:00:01Z'));
    });

    it('honours EXECUTOR_EXHAUSTED_BACKOFF_MINUTES and fails closed on an invalid value', async () => {
        const previous = process.env.EXECUTOR_EXHAUSTED_BACKOFF_MINUTES;
        try {
            process.env.EXECUTOR_EXHAUSTED_BACKOFF_MINUTES = '5';
            const short = new ExecutorService(repo, new ExecutorMapper(), {} as never, {} as never, {} as never);
            const now = new Date('2026-10-28T10:00:00Z');
            expect(await short.markExhausted(executor.id, null, now)).toEqual(new Date('2026-10-28T10:05:00Z'));
            process.env.EXECUTOR_EXHAUSTED_BACKOFF_MINUTES = 'soon';
            expect(() => new ExecutorService(repo, new ExecutorMapper(), {} as never, {} as never, {} as never)).toThrow(/EXECUTOR_EXHAUSTED_BACKOFF_MINUTES/);
        } finally {
            if (previous === undefined) delete process.env.EXECUTOR_EXHAUSTED_BACKOFF_MINUTES;
            else process.env.EXECUTOR_EXHAUSTED_BACKOFF_MINUTES = previous;
        }
    });
});
