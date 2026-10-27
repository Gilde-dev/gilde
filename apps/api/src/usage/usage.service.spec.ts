import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copilotDefaultOptions } from '../copilot/copilot.mastra.js';
import { COPILOT_USER_KEY } from '../copilot/copilot.context.js';
import { User } from '../user/user.entity.js';

import { usageUser, withEmbeddingUsage } from './usage-context.js';
import { computeCost, parsePrices } from './usage-pricing.js';
import { LlmUsage } from './usage.entity.js';
import { UsageService } from './usage.service.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const PRICES = JSON.stringify({ 'openai/chat-x': { input: 2, cachedInput: 1, output: 10 }, 'embed-y': { input: 0.5 } });

let ds: DataSource;
let service: UsageService;
let user: User;

beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [User, LlmUsage], synchronize: true }).initialize();
    service = new UsageService(ds.getRepository(LlmUsage));
    user = await ds.getRepository(User).save(ds.getRepository(User).create({ name: 'Ann', email: 'a@x.nl', password: 'x' }));
    process.env.LLM_PRICES = PRICES;
});

afterEach(async () => {
    delete process.env.LLM_PRICES;
    await ds.destroy();
});

describe('pricing', () => {
    it('computes cost from LLM_PRICES, splitting cached input', () => {
        const prices = parsePrices(PRICES);
        // 600 uncached * 2 + 400 cached * 1 + 100 output * 10 = 2600 per million
        expect(computeCost(prices, 'openai/chat-x', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 })).toBeCloseTo(0.0026);
        expect(computeCost(prices, 'openai/embed-y', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(0.5);
    });

    it('is null without a price, and for missing or invalid LLM_PRICES', () => {
        const tokens = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 };
        expect(computeCost(parsePrices(PRICES), 'openai/unknown', tokens)).toBeNull();
        expect(computeCost(parsePrices(undefined), 'openai/chat-x', tokens)).toBeNull();
        expect(computeCost(parsePrices('not json'), 'openai/chat-x', tokens)).toBeNull();
    });
});

describe('recording', () => {
    it('stores a co-pilot run with the acting user, model and cost', async () => {
        const { onFinish } = copilotDefaultOptions(30, { log: vi.fn(), warn: vi.fn() }, { service, model: 'openai/chat-x' });
        const ctx = new Map<string, unknown>([[COPILOT_USER_KEY, { id: user.id }], ['threadId', 't-1']]);
        onFinish({ steps: [{}, {}], totalUsage: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 20 }, requestContext: ctx });
        await vi.waitFor(async () => expect(await ds.getRepository(LlmUsage).count()).toBe(1));
        const row = await ds.getRepository(LlmUsage).findOneByOrFail({ kind: 'chat' });
        expect(row).toMatchObject({ userId: user.id, threadId: 't-1', agent: 'gilde', model: 'openai/chat-x', steps: 2, inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 20 });
        expect(row.costUsd).toBeCloseTo(0.0026);
    });

    it('stores an embedding batch with the request user, or none for indexing', async () => {
        const model = { specificationVersion: 'v2', doEmbed: vi.fn(async () => ({ embeddings: [[1]], usage: { tokens: 42 } })) };
        const wrapped = withEmbeddingUsage(model, 'embed-y', service);
        expect(wrapped.specificationVersion).toBe('v2');
        await usageUser.run({ userId: user.id }, () => wrapped.doEmbed({} as never));
        await wrapped.doEmbed({} as never);
        await vi.waitFor(async () => expect(await ds.getRepository(LlmUsage).count()).toBe(2));
        const rows = await ds.getRepository(LlmUsage).find({ order: { createdAt: 'ASC' } });
        expect(rows.map((r) => r.kind)).toEqual(['embedding', 'embedding']);
        expect(rows.map((r) => r.inputTokens)).toEqual([42, 42]);
        expect(rows.map((r) => r.userId).sort()).toEqual([null, user.id].sort());
        expect(rows[0].costUsd).toBeCloseTo(0.000021);
    });

    it('stores null cost for a model without a price', async () => {
        await service.record({ kind: 'chat', model: 'openai/other', inputTokens: 5 });
        expect((await ds.getRepository(LlmUsage).findOneByOrFail({ model: 'openai/other' })).costUsd).toBeNull();
    });

    it('swallows recording failures', async () => {
        await ds.destroy();
        await expect(service.record({ kind: 'chat', model: 'm' })).resolves.toBeUndefined();
        await ds.initialize();
    });

    it('does not affect the embedding or the chat when recording fails', async () => {
        const failing = { record: vi.fn(async () => { throw new Error('db down'); }) };
        const model = { doEmbed: vi.fn(async () => ({ embeddings: [[1]], usage: { tokens: 1 } })) };
        await expect(withEmbeddingUsage(model, 'm', failing as never).doEmbed({} as never)).resolves.toMatchObject({ embeddings: [[1]] });
    });
});

describe('summary', () => {
    it('returns totals, a daily series and breakdowns', async () => {
        const repo = ds.getRepository(LlmUsage);
        const mk = (over: Partial<LlmUsage>) => repo.save(repo.create({ kind: 'chat', model: 'm1', inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0, costUsd: null, ...over }));
        await mk({ userId: user.id, costUsd: 0.5, createdAt: new Date('2026-03-10T08:00:00Z') });
        await mk({ userId: user.id, model: 'm2', costUsd: 0.25, createdAt: new Date('2026-03-09T08:00:00Z') });
        await mk({ kind: 'embedding', model: 'e1', userId: null, outputTokens: 0, createdAt: new Date('2026-03-09T09:00:00Z') });
        await mk({ createdAt: new Date('2026-01-01T00:00:00Z') }); // outside window

        const res = await service.summary({ days: 3 }, NOW);
        expect(res.totals).toMatchObject({ inputTokens: 300, outputTokens: 20, totalTokens: 320, runs: 3, costUsd: 0.75 });
        expect(res.daily.map((d) => [d.date, d.runs])).toEqual([['2026-03-08', 0], ['2026-03-09', 2], ['2026-03-10', 1]]);
        expect(res.daily[0].costUsd).toBeNull();
        expect(res.byModel.map((m) => m.model).sort()).toEqual(['e1', 'm1', 'm2']);
        expect(res.byKind.find((k) => k.kind === 'embedding')?.runs).toBe(1);
        expect(res.byUser.find((u) => u.userId === user.id)).toMatchObject({ userName: 'Ann', runs: 2, costUsd: 0.75 });
        expect(res.byUser.find((u) => u.userId === null)).toMatchObject({ userName: null, runs: 1, costUsd: null });

        expect((await service.summary({ days: 3, kind: 'embedding' }, NOW)).totals.runs).toBe(1);
        expect((await service.summary({ days: 3, userId: user.id }, NOW)).totals.runs).toBe(2);
    });
});

describe('UsageService.costBetween', () => {
    let ds2: DataSource;
    let svc: UsageService;

    beforeEach(async () => {
        ds2 = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [User, LlmUsage], synchronize: true }).initialize();
        svc = new UsageService(ds2.getRepository(LlmUsage));
    });
    afterEach(() => ds2.destroy());

    const insert = (createdAt: string, costUsd: number | null, kind: 'chat' | 'embedding' = 'chat') =>
        ds2.getRepository(LlmUsage).insert({ kind, model: 'm', costUsd, createdAt: new Date(createdAt) });

    it('is zero without rows', async () => {
        expect(await svc.costBetween(new Date('2026-03-10T00:00:00Z'), new Date('2026-03-11T00:00:00Z'))).toEqual({ knownCostUsd: 0, pricedRows: 0, totalRows: 0, unpricedRows: 0 });
    });

    it('sums known costs over a half-open window, all kinds, and counts unpriced rows', async () => {
        await insert('2026-03-09T23:59:59.999Z', 100);
        await insert('2026-03-10T00:00:00.000Z', 0.25);
        await insert('2026-03-10T12:00:00.000Z', 0.5, 'embedding');
        await insert('2026-03-10T13:00:00.000Z', null);
        await insert('2026-03-11T00:00:00.000Z', 100);
        expect(await svc.costBetween(new Date('2026-03-10T00:00:00Z'), new Date('2026-03-11T00:00:00Z'))).toEqual({ knownCostUsd: 0.75, pricedRows: 2, totalRows: 3, unpricedRows: 1 });
    });

    it('keeps a true zero apart from unknown', async () => {
        await insert('2026-03-10T01:00:00Z', 0);
        await insert('2026-03-12T01:00:00Z', null);
        expect(await svc.costBetween(new Date('2026-03-10T00:00:00Z'), new Date('2026-03-11T00:00:00Z'))).toMatchObject({ knownCostUsd: 0, pricedRows: 1, totalRows: 1 });
        expect(await svc.costBetween(new Date('2026-03-12T00:00:00Z'), new Date('2026-03-13T00:00:00Z'))).toMatchObject({ knownCostUsd: 0, pricedRows: 0, totalRows: 1, unpricedRows: 1 });
    });
});
