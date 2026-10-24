export const FEATURE_STATUSES = ['draft', 'active', 'done', 'cancelled'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export type FeatureEvent =
    | 'start'   // draft → active
    | 'done'    // active → done
    | 'cancel'  // draft or active → cancelled
    | 'reopen'; // done → active

const TRANSITIONS: Record<FeatureStatus, Partial<Record<FeatureEvent, FeatureStatus>>> = {
    draft: { start: 'active', cancel: 'cancelled' },
    active: { done: 'done', cancel: 'cancelled' },
    done: { reopen: 'active' },
    cancelled: {},
};

/** The next status, or null if the event isn't allowed from this status. */
export function nextFeatureStatus(current: FeatureStatus, event: FeatureEvent): FeatureStatus | null {
    return TRANSITIONS[current][event] ?? null;
}

/** Statuses that no longer accept new jobs or edits. */
export const FEATURE_CLOSED: readonly FeatureStatus[] = ['done', 'cancelled'];
