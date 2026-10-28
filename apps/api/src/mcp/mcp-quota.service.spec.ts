import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

import { McpQuotaExceededError } from './mcp.errors.js';
import { McpQuotaService, utcDay } from './mcp-quota.service.js';
import { McpUsageDay } from './mcp-usage-day.entity.js';

@Entity({ name: 'quota_probe' })
class Probe {
    @PrimaryGeneratedColumn('uuid') id: string;
    @Column() label: string;
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('McpQuotaService (real SQLite)', () => {
    let dir: string;
    const sources: DataSource[] = [];
    const open = async (database = join(dir, 'q.db')) => {
        const ds = new DataSource({ type: 'better-sqlite3', database, entities: [McpUsageDay, Probe], synchronize: true });
        await ds.initialize();
        sources.push(ds);
        return ds;
    };
    const probes = (ds: DataSource) => ds.getRepository(Probe).count();

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-quota-')); });
    afterEach(async () => {
        for (const ds of sources.splice(0)) if (ds.isInitialized) await ds.destroy();
        rmSync(dir, { recursive: true, force: true });
    });

    it('allows up to the limit and then refuses, creating nothing', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 2, dailyFeatureLimit: 1 });
        const create = () => q.withReservation(USER, { jobs: 1 }, (m) => m.save(m.create(Probe, { label: 'job' })));
        await create();
        await create();
        await expect(create()).rejects.toBeInstanceOf(McpQuotaExceededError);
        expect(await probes(ds)).toBe(2);
        expect(await q.usage(USER)).toEqual({ jobs: 2, features: 0 });
    });

    it('rolls the reservation back when the creation fails', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 5, dailyFeatureLimit: 5 });
        await expect(q.withReservation(USER, { jobs: 3, features: 1 }, async (m) => {
            await m.save(m.create(Probe, { label: 'half' }));
            throw new Error('write failed');
        })).rejects.toThrow('write failed');
        expect(await probes(ds)).toBe(0);
        expect(await q.usage(USER)).toEqual({ jobs: 0, features: 0 });
    });

    it('refuses a reservation that does not fit as a whole and consumes nothing', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 4, dailyFeatureLimit: 5 });
        await q.withReservation(USER, { jobs: 2 }, async () => undefined);
        await expect(q.withReservation(USER, { jobs: 3, features: 1 }, async () => undefined)).rejects.toMatchObject({ kind: 'jobs', limit: 4 });
        expect(await q.usage(USER)).toEqual({ jobs: 2, features: 0 });
    });

    it('counts a planned feature (one feature plus all its jobs) against the same job allowance as single jobs', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 5, dailyFeatureLimit: 5 });
        await q.withReservation(USER, { jobs: 3, features: 1 }, async () => undefined);
        await q.withReservation(USER, { jobs: 1 }, async () => undefined);
        await expect(q.withReservation(USER, { jobs: 2, features: 1 }, async () => undefined)).rejects.toMatchObject({ kind: 'jobs' });
        await q.withReservation(USER, { jobs: 1 }, async () => undefined);
        await expect(q.withReservation(USER, { jobs: 1 }, async () => undefined)).rejects.toBeInstanceOf(McpQuotaExceededError);
        expect(await q.usage(USER)).toEqual({ jobs: 5, features: 1 });
    });

    it('enforces the feature limit separately', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 50, dailyFeatureLimit: 1 });
        await q.withReservation(USER, { jobs: 1, features: 1 }, async () => undefined);
        await expect(q.withReservation(USER, { jobs: 1, features: 1 }, async () => undefined)).rejects.toMatchObject({ kind: 'features', limit: 1 });
        expect(await q.usage(USER)).toEqual({ jobs: 1, features: 1 });
    });

    it('treats zero as disabled without touching the table', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 0, dailyFeatureLimit: 0 });
        const err = await q.withReservation(USER, { jobs: 1 }, async () => undefined).catch((e) => e);
        expect(err).toBeInstanceOf(McpQuotaExceededError);
        expect(err.message).toContain('disabled');
        await expect(q.withReservation(USER, { features: 1 }, async () => undefined)).rejects.toBeInstanceOf(McpQuotaExceededError);
        expect(await ds.getRepository(McpUsageDay).count()).toBe(0);
    });

    it('keeps users apart and counts one user once however many credentials they use', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 1, dailyFeatureLimit: 1 });
        // The quota is keyed by user id alone; two API keys or a JWT of the same user are the same user.
        await q.withReservation(USER, { jobs: 1 }, async () => undefined);
        await expect(q.withReservation(USER, { jobs: 1 }, async () => undefined)).rejects.toBeInstanceOf(McpQuotaExceededError);
        await q.withReservation(OTHER, { jobs: 1 }, async () => undefined);
    });

    it('starts a new allowance at the UTC day boundary', async () => {
        const ds = await open();
        let now = new Date('2026-03-01T23:59:59.000Z');
        const q = new McpQuotaService(ds, { dailyJobLimit: 1, dailyFeatureLimit: 1 }, () => now);
        await q.withReservation(USER, { jobs: 1 }, async () => undefined);
        await expect(q.withReservation(USER, { jobs: 1 }, async () => undefined)).rejects.toBeInstanceOf(McpQuotaExceededError);
        now = new Date('2026-03-02T00:00:00.000Z');
        await q.withReservation(USER, { jobs: 1 }, async () => undefined);
        expect(await q.usage(USER)).toEqual({ jobs: 1, features: 0 });
        expect(utcDay(new Date('2026-03-01T23:30:00-05:00'))).toBe('2026-03-02');
    });

    it('never lets concurrent creations exceed the limit', async () => {
        const ds = await open();
        const q = new McpQuotaService(ds, { dailyJobLimit: 5, dailyFeatureLimit: 5 });
        const results = await Promise.allSettled(Array.from({ length: 15 }, (_, i) =>
            q.withReservation(USER, { jobs: 1 }, (m) => m.save(m.create(Probe, { label: `c${i}` }))),
        ));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
        expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof McpQuotaExceededError)).toBe(true);
        expect(await probes(ds)).toBe(5);
        expect(await q.usage(USER)).toEqual({ jobs: 5, features: 0 });
    });

    it('survives a restart: a new process sees what the old one counted', async () => {
        const first = await open();
        const limits = { dailyJobLimit: 2, dailyFeatureLimit: 1 };
        const q1 = new McpQuotaService(first, limits);
        await q1.withReservation(USER, { jobs: 2 }, async () => undefined);
        await first.destroy();

        const second = await open();
        const q2 = new McpQuotaService(second, limits);
        expect(await q2.usage(USER)).toEqual({ jobs: 2, features: 0 });
        await expect(q2.withReservation(USER, { jobs: 1 }, async () => undefined)).rejects.toBeInstanceOf(McpQuotaExceededError);
    });
});
