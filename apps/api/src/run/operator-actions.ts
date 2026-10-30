import { z } from 'zod';

import { isRequiredAction, OPERATOR_ACTION_KINDS, OPERATOR_ACTION_WHEN, type OperatorAction } from '../webhook/pr-body.js';

/** An operator action as stored on a run: the agent's entry plus who marked it done. */
export interface StoredOperatorAction extends OperatorAction {
    doneAt?: string | null;
    doneById?: string | null;
}

export const OperatorActionStateSchema = z.object({
    kind: z.enum(OPERATOR_ACTION_KINDS),
    when: z.enum(OPERATOR_ACTION_WHEN),
    instruction: z.string(),
    name: z.string().nullable(),
    where: z.string().nullable(),
    /** True unless the agent said it was optional. */
    required: z.boolean(),
    doneAt: z.string().datetime().nullable(),
    doneById: z.string().uuid().nullable(),
});
export type OperatorActionStateDto = z.infer<typeof OperatorActionStateSchema>;

export function toOperatorActionDtos(actions: StoredOperatorAction[] | null | undefined): OperatorActionStateDto[] {
    return (actions ?? []).map((a) => ({
        kind: a.kind,
        when: a.when,
        instruction: a.instruction,
        name: a.name ?? null,
        where: a.where ?? null,
        required: isRequiredAction(a),
        doneAt: a.doneAt ?? null,
        doneById: a.doneById ?? null,
    }));
}

const sameAction = (a: OperatorAction, b: OperatorAction) =>
    a.kind === b.kind && a.when === b.when && a.instruction === b.instruction && (a.name ?? null) === (b.name ?? null) && (a.where ?? null) === (b.where ?? null);

/**
 * The actions to store after the PR body was (re)parsed: the body is the source of truth for the list, and an action that is
 * unchanged keeps its done state. Null when the body has none.
 */
export function mergeOperatorActions(existing: StoredOperatorAction[] | null | undefined, incoming: OperatorAction[] | undefined): StoredOperatorAction[] | null {
    if (!incoming?.length) return null;
    const left = [...(existing ?? [])];
    return incoming.map((a) => {
        const i = left.findIndex((e) => sameAction(e, a));
        const prev = i >= 0 ? left.splice(i, 1)[0] : null;
        return prev?.doneAt ? { ...a, doneAt: prev.doneAt, doneById: prev.doneById ?? null } : { ...a };
    });
}

/** True when at least one action is not done yet. */
export const hasOpenOperatorActions = (actions: ReadonlyArray<{ doneAt?: string | null }> | null | undefined) =>
    !!actions?.some((a) => !a.doneAt);
