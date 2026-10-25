import { describe, expect, it } from 'vitest';

import { desiredSkills } from './desired-skills.js';

const registry = [
    { name: 'g', scope: 'global' as const },
    { name: 'nest', scope: 'stack' as const, stacks: ['nestjs'] },
    { name: 'spring', scope: 'stack' as const, stacks: ['spring-boot', 'java'] },
    { name: 'extra', scope: 'stack' as const, stacks: ['other'] },
];

describe('desiredSkills', () => {
    it('gives global skills', () => {
        expect(desiredSkills({ stacks: [] }, registry)).toEqual(['g']);
    });

    it('adds skills whose stacks include any manifest stack', () => {
        expect(desiredSkills({ stacks: ['java', 'nestjs'] }, registry).sort()).toEqual(['g', 'nest', 'spring']);
    });

    it('adds included skills', () => {
        expect(desiredSkills({ stacks: ['nestjs'], skills: { include: ['extra'] } }, registry).sort()).toEqual(['extra', 'g', 'nest']);
    });

    it('removes excluded skills, even global ones', () => {
        expect(desiredSkills({ stacks: ['nestjs'], skills: { exclude: ['g', 'nest'] } }, registry)).toEqual([]);
    });

    it('lets exclude win over include', () => {
        expect(desiredSkills({ stacks: [], skills: { include: ['extra'], exclude: ['extra'] } }, registry)).toEqual(['g']);
    });
});
