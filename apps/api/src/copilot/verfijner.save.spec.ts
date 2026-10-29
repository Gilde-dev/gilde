import { ConflictException } from '@nestjs/common';

import { issueRefineBinding, refineOutcome } from './verfijner.context.js';
import { MAX_OPEN_QUESTIONS } from './verfijner.instructions.js';
import { RefinedSpecWriter, refineSlug } from './verfijner.save.js';
import { validSpecBody } from './verfijner.testing.js';

const P1 = '3f2b8a4e-1c5d-4e7a-9b60-0d1e2f3a4b5c';
const REPO1 = '11111111-1111-4111-8111-111111111111';
const ITEM = '55555555-5555-4555-8555-555555555555';
const SPEC = '66666666-6666-4666-8666-666666666666';
const URL = 'https://github.com/o/r/issues/7';
const BOT = { id: 'bot-user' };

describe('refineSlug', () => {
    it('derives a kebab-case slug from the issue number and title, at most 64 characters', () => {
        expect(refineSlug(7, 'Export to CSV!')).toBe('issue-7-export-to-csv');
        expect(refineSlug(7, 'Ünïcode — title')).toBe('issue-7-unicode-title');
        expect(refineSlug(7, '!!!')).toBe('issue-7');
        expect(refineSlug(7, 'x'.repeat(200), '12')).toHaveLength(64);
        expect(refineSlug(7, 'x'.repeat(200), '12')).toMatch(/-12$/);
        expect(refineSlug(7, 'Export', '2')).toBe('issue-7-export-2');
    });
});

describe('RefinedSpecWriter', () => {
    let item: { id: string; projectId: string; repoId: string; number: number; url: string; status: string; specId: string | null };
    const specs = { create: vi.fn(), saveVersion: vi.fn(), getDetail: vi.fn() };
    const refine = { get: vi.fn(), linkSpec: vi.fn() };
    const writer = () => new RefinedSpecWriter(specs as never, refine as never, BOT);
    const binding = () => issueRefineBinding(BOT.id, { id: ITEM, projectId: P1, repoId: REPO1, specId: null }, 1);

    beforeEach(() => {
        vi.resetAllMocks();
        item = { id: ITEM, projectId: P1, repoId: REPO1, number: 7, url: URL, status: 'refining', specId: null };
        refine.get.mockImplementation(async () => item);
        refine.linkSpec.mockResolvedValue(true);
        specs.create.mockImplementation(async (_p: string, dto: { slug: string }) => ({ id: SPEC, slug: dto.slug, currentVersion: 1, status: 'draft' }));
        specs.getDetail.mockResolvedValue({ id: SPEC, currentVersion: 3 });
        specs.saveVersion.mockResolvedValue({ id: SPEC, currentVersion: 4, status: 'draft' });
    });

    it('creates the spec of the item as the bot user, in the item\'s project and repo, and links it', async () => {
        const b = binding();
        const result = await writer().save(b, { title: 'Export to CSV', body: validSpecBody(URL) });
        expect(result).toEqual({ saved: true, specId: SPEC, version: 1, created: true, status: 'draft' });
        expect(specs.create).toHaveBeenCalledWith(P1, expect.objectContaining({ repoId: REPO1, slug: 'issue-7-export-to-csv', expectedVersion: 0 }), BOT);
        expect(refine.linkSpec).toHaveBeenCalledWith(ITEM, SPEC);
        expect(refineOutcome(b).saves).toBe(1);
    });

    it('picks the next free slug when one is taken', async () => {
        specs.create.mockRejectedValueOnce(new ConflictException('slug taken')).mockRejectedValueOnce(new ConflictException('slug taken'));
        specs.create.mockImplementation(async (_p: string, dto: { slug: string }) => ({ id: SPEC, slug: dto.slug, currentVersion: 1 }));
        await writer().save(binding(), { title: 'Export to CSV', body: validSpecBody(URL) });
        expect(specs.create.mock.calls.map((c) => (c[1] as { slug: string }).slug)).toEqual(['issue-7-export-to-csv', 'issue-7-export-to-csv-2', 'issue-7-export-to-csv-3']);
    });

    it('adds a draft version to the linked spec with its current version as expectedVersion', async () => {
        item.specId = SPEC;
        const result = await writer().save(binding(), { title: 'Export to CSV', body: validSpecBody(URL) });
        expect(result).toEqual({ saved: true, specId: SPEC, version: 4, created: false, status: 'draft' });
        expect(specs.create).not.toHaveBeenCalled();
        expect(specs.saveVersion).toHaveBeenCalledWith(SPEC, expect.objectContaining({ expectedVersion: 3 }), BOT);
    });

    it('uses the spec the item links to now, not the one it had when the run started', async () => {
        const b = binding(); // issued while the item had no spec
        await writer().save(b, { title: 'Export to CSV', body: validSpecBody(URL) });
        item.specId = SPEC; // linked by the first save
        await writer().save(b, { title: 'Export to CSV', body: validSpecBody(URL) });
        expect(specs.create).toHaveBeenCalledTimes(1);
        expect(specs.saveVersion).toHaveBeenCalledTimes(1);
    });

    describe('open questions limit', () => {
        const withQuestions = (n: number) => validSpecBody(URL).replace('None\n', Array.from({ length: n }, (_, i) => `- Question ${i + 1}?`).join('\n') + '\n');

        it('accepts the maximum and rejects one more with a fixable error', async () => {
            expect(MAX_OPEN_QUESTIONS).toBe(5);
            expect(await writer().save(binding(), { title: 'T', body: withQuestions(5) })).toMatchObject({ saved: true });
            const result = await writer().save(binding(), { title: 'T', body: withQuestions(6) });
            expect(result).toEqual({ saved: false, errors: ['at most 5 open questions; turn the rest into stated assumptions'] });
        });

        it('counts None and an empty section as resolved', async () => {
            expect(await writer().save(binding(), { title: 'T', body: withQuestions(0) })).toMatchObject({ saved: true });
            expect(await writer().save(binding(), { title: 'T', body: validSpecBody(URL).replace('None\n', '') })).toMatchObject({ saved: true });
        });
    });

    it('returns parser errors so the agent can retry, and saves nothing', async () => {
        const result = await writer().save(binding(), { title: 'Export to CSV', body: '## Goal\n\nOnly a goal\n' });
        expect(result).toMatchObject({ saved: false, errors: expect.arrayContaining([expect.any(String)]) });
        expect(specs.create).not.toHaveBeenCalled();
    });

    it('requires the issue URL in the body', async () => {
        const result = await writer().save(binding(), { title: 'Export to CSV', body: validSpecBody('https://example.com/other') });
        expect(result).toMatchObject({ saved: false, errors: [expect.stringContaining(URL)] });
        expect(specs.create).not.toHaveBeenCalled();
    });

    it('turns a service rejection (stale version, criteria history) into errors, and lets server errors through', async () => {
        item.specId = SPEC;
        specs.saveVersion.mockRejectedValueOnce(new ConflictException('The spec changed in the meantime, reload and try again'));
        expect(await writer().save(binding(), { title: 'Export to CSV', body: validSpecBody(URL) })).toEqual({ saved: false, errors: ['The spec changed in the meantime, reload and try again'] });
        specs.saveVersion.mockRejectedValueOnce(new Error('db down'));
        await expect(writer().save(binding(), { title: 'Export to CSV', body: validSpecBody(URL) })).rejects.toThrow('db down');
    });

    it('refuses once the item is no longer being refined, or does not match its binding', async () => {
        item.status = 'withdrawn';
        expect(await writer().save(binding(), { title: 'Export to CSV', body: validSpecBody(URL) })).toMatchObject({ saved: false });
        item.status = 'refining';
        item.repoId = '99999999-9999-4999-8999-999999999999';
        expect(await writer().save(binding(), { title: 'Export to CSV', body: validSpecBody(URL) })).toMatchObject({ saved: false });
        expect(specs.create).not.toHaveBeenCalled();
    });
});
