import { describe, expect, it } from 'vitest';

import { ManifestSchema } from './manifest.schema.js';

const valid = { stacks: ['nestjs'], testCommands: ['pnpm test'] };

describe('ManifestSchema', () => {
    it('accepts a valid manifest', () => {
        const parsed = ManifestSchema.parse({ name: 'gilde', ...valid, skills: { include: ['a'], exclude: [] } });
        expect(parsed).toEqual({ name: 'gilde', ...valid, skills: { include: ['a'], exclude: [] } });
    });

    it('rejects empty stacks or testCommands', () => {
        expect(ManifestSchema.safeParse({ ...valid, stacks: [] }).success).toBe(false);
        expect(ManifestSchema.safeParse({ ...valid, testCommands: [] }).success).toBe(false);
        expect(ManifestSchema.safeParse({ ...valid, testCommands: [''] }).success).toBe(false);
    });

    it('rejects an unknown stack', () => {
        expect(ManifestSchema.safeParse({ ...valid, stacks: ['cobol'] }).success).toBe(false);
    });

    it('allows extra keys', () => {
        expect(ManifestSchema.safeParse({ ...valid, other: 1, skills: { extra: true } }).success).toBe(true);
    });
});
