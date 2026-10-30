import { Logger } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationMapper } from './notification.mapper.js';
import { Notification } from './notification.entity.js';
import { NotificationService, sanitizeReason } from './notification.service.js';

let ds: DataSource;
let repo: Repository<Notification>;
let service: NotificationService;
let errorLog: ReturnType<typeof vi.spyOn>;

const base = { kind: 'job.parked', title: 'T', repos: ['o/r'], reason: 'why' } as const;
const input = (key: string, extra = {}) => ({ ...base, occurrenceKey: key, ...extra });
const q = (extra = {}) => ({ limit: 20, ...extra });

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Notification], synchronize: true }).initialize();
    repo = ds.getRepository(Notification);
    service = new NotificationService(repo, new NotificationMapper());
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
    errorLog.mockRestore();
    await ds.destroy();
});

describe('recordQuietly', () => {
    it('records one row and treats a duplicate key as already recorded', async () => {
        expect(await service.recordQuietly(input('k1'))).toBe(true);
        expect(await service.recordQuietly(input('k1', { title: 'other' }))).toBe(false);
        expect(await repo.count()).toBe(1);
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('records nothing when the source function has nothing to record', async () => {
        expect(await service.recordQuietly(() => null)).toBe(false);
        expect(await repo.count()).toBe(0);
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('records at most once under concurrent attempts', async () => {
        await Promise.all(Array.from({ length: 5 }, () => service.recordQuietly(input('same'))));
        expect(await repo.count()).toBe(1);
    });

    it('swallows and logs other insert errors', async () => {
        vi.spyOn(repo, 'insert').mockRejectedValue(new Error('disk is gone'));
        expect(await service.recordQuietly(input('k2'))).toBe(false);
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('k2'));
    });

    it('swallows and logs a failing enrichment function', async () => {
        expect(await service.recordQuietly(() => { throw new Error('enrich boom'); })).toBe(false);
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('enrich boom'));
        expect(await repo.count()).toBe(0);
    });

    it('accepts an async envelope function', async () => {
        expect(await service.recordQuietly(async () => input('k3'))).toBe(true);
    });
});

describe('listDue', () => {
    it('returns pending and due failed rows only, filtered by kind', async () => {
        await service.recordQuietly(input('pending'));
        await service.recordQuietly(input('other-kind', { kind: 'revision.waiting' }));
        await service.recordQuietly(input('due'));
        await service.recordQuietly(input('later'));
        await service.recordQuietly(input('permanent'));
        await service.recordQuietly(input('done'));
        const id = async (key: string) => (await repo.findOneByOrFail({ occurrenceKey: key })).id;
        const now = new Date();
        await service.markFailed(await id('due'), { reason: 'x', retryAfterSeconds: 1 }, new Date(now.getTime() - 60_000));
        await service.markFailed(await id('later'), { reason: 'x', retryAfterSeconds: 3600 }, now);
        await service.markFailed(await id('permanent'), { reason: 'x', retryable: false });
        await service.markDelivered(await id('done'));

        const all = (await service.listDue(q(), now)).map((n) => n.occurrenceKey);
        expect([...all].sort()).toEqual(['due', 'other-kind', 'pending']);
        const parked = (await service.listDue(q({ kinds: ['job.parked'] }), now)).map((n) => n.occurrenceKey);
        expect([...parked].sort()).toEqual(['due', 'pending']);
    });

    it('orders stably and bounds the batch', async () => {
        const at = new Date('2026-01-01T00:00:00Z');
        for (const key of ['a', 'b', 'c']) await repo.insert({ ...base, occurrenceKey: key, occurredAt: at, repos: [], prLinks: [], createdAt: at });
        const first = (await service.listDue(q({ limit: 2 }))).map((n) => n.occurrenceKey);
        const again = (await service.listDue(q({ limit: 2 }))).map((n) => n.occurrenceKey);
        expect(first).toHaveLength(2);
        expect(again).toEqual(first);
    });
});

describe('delivery transitions', () => {
    const create = async () => {
        await service.recordQuietly(input('t'));
        return (await repo.findOneByOrFail({ occurrenceKey: 't' })).id;
    };

    it('persists failure with attempts, retry time and sanitized reason', async () => {
        const id = await create();
        const now = new Date('2026-01-01T00:00:00Z');
        const r = await service.markFailed(id, { reason: 'Bearer xoxb-secret  failed\nbadly', retryAfterSeconds: 120 }, now);
        expect(r).toMatchObject({ status: 'failed', attempts: 1, nextRetryAt: '2026-01-01T00:02:00.000Z', lastError: 'Bearer [redacted] failed badly' });
        const r2 = await service.markFailed(id, { reason: 'again' }, now);
        expect(r2.attempts).toBe(2);
        expect(r2.nextRetryAt).toBe('2026-01-01T00:01:00.000Z');
        expect((await repo.findOneByOrFail({ id })).attempts).toBe(2);
    });

    it('permanent failure has no next retry', async () => {
        const r = await service.markFailed(await create(), { reason: 'bad channel', retryable: false });
        expect(r).toMatchObject({ status: 'failed', nextRetryAt: null });
    });

    it('delivered is idempotent and terminal', async () => {
        const id = await create();
        const first = await service.markDelivered(id);
        const second = await service.markDelivered(id);
        expect(first.status).toBe('delivered');
        expect(second.deliveredAt).toBe(first.deliveredAt);
        const after = await service.markFailed(id, { reason: 'late failure' });
        expect(after).toMatchObject({ status: 'delivered', attempts: 0, lastError: null, deliveredAt: first.deliveredAt });
    });

    it('answers 404 for unknown ids', async () => {
        await expect(service.markDelivered('00000000-0000-4000-8000-000000000000')).rejects.toThrow('not found');
    });
});

describe('sanitizeReason', () => {
    it('bounds length', () => {
        expect(sanitizeReason('x'.repeat(2000))).toHaveLength(500);
    });
});

describe('deliveries', () => {
    it('lists delivered and failed rows newest first, in pages, without pending ones', async () => {
        for (const key of ['a', 'b', 'c', 'd']) await service.recordQuietly(input(key));
        const rows = await repo.find({ order: { createdAt: 'ASC', id: 'ASC' } });
        await service.markDelivered(rows[0].id);
        await service.markFailed(rows[1].id, { reason: 'Bearer abc123 refused', retryable: false });
        await service.markDelivered(rows[2].id);
        // rows[3] stays pending
        const all = await service.deliveries({});
        expect(all).toMatchObject({ page: 1, pageSize: 25, total: 3 });
        expect(all.items.map((i) => i.status).sort()).toEqual(['delivered', 'delivered', 'failed']);
        expect(all.items.find((i) => i.status === 'failed')?.lastError).toBe('Bearer [redacted] refused');
        expect(all.items.find((i) => i.id === rows[3].id)).toBeUndefined();
        const second = await service.deliveries({ page: 2, pageSize: 2 });
        expect(second.items).toHaveLength(1);
        expect(second.total).toBe(3);
    });
});
