import { describe, expect, it } from 'vitest';

import { hasOpenOperatorActions, mergeOperatorActions, toOperatorActionDtos } from './operator-actions.js';

const env = { kind: 'env', when: 'before_deploy', instruction: 'Generate a key', name: 'K' } as const;
const cli = { kind: 'cli', when: 'after_deploy', instruction: 'Backfill', required: false } as const;

describe('operator actions', () => {
    it('reads required as true unless the agent said false, and nulls absent fields', () => {
        expect(toOperatorActionDtos([env, cli])).toEqual([
            { ...env, where: null, required: true, doneAt: null, doneById: null },
            { ...cli, name: null, where: null, required: false, doneAt: null, doneById: null },
        ]);
        expect(toOperatorActionDtos(null)).toEqual([]);
    });

    it('keeps done state of unchanged actions when merging and drops it for changed ones', () => {
        const done = { ...env, doneAt: '2026-01-01T00:00:00.000Z', doneById: 'u1' };
        expect(mergeOperatorActions([done, cli], [env, { ...cli, instruction: 'Backfill v2' }])).toEqual([done, { ...cli, instruction: 'Backfill v2' }]);
        expect(mergeOperatorActions([done], undefined)).toBeNull();
        expect(mergeOperatorActions(null, [env])).toEqual([env]);
    });

    it('needs operator action while any action is not done', () => {
        expect(hasOpenOperatorActions(undefined)).toBe(false);
        expect(hasOpenOperatorActions([])).toBe(false);
        expect(hasOpenOperatorActions([{ doneAt: 'x' }, { doneAt: null }])).toBe(true);
        expect(hasOpenOperatorActions([{ doneAt: 'x' }])).toBe(false);
    });
});
