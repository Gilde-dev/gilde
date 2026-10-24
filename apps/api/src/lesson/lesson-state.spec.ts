import { describe, expect, it } from 'vitest';

import { LESSON_STATUSES, nextLessonStatus } from './lesson-state.js';

describe('lesson state machine', () => {
    it('allows the documented transitions', () => {
        expect(nextLessonStatus('candidate', 'approve')).toBe('approved');
        expect(nextLessonStatus('candidate', 'reject')).toBe('rejected');
        expect(nextLessonStatus('approved', 'reopen')).toBe('candidate');
        expect(nextLessonStatus('approved', 'reject')).toBe('rejected');
        expect(nextLessonStatus('rejected', 'reopen')).toBe('candidate');
    });

    it('rejects everything else', () => {
        expect(nextLessonStatus('candidate', 'reopen')).toBeNull();
        expect(nextLessonStatus('approved', 'approve')).toBeNull();
        expect(nextLessonStatus('rejected', 'approve')).toBeNull();
        expect(nextLessonStatus('rejected', 'reject')).toBeNull();
        expect(nextLessonStatus('applying', 'approve')).toBeNull();
        expect(nextLessonStatus('applying', 'reject')).toBeNull();
        expect(nextLessonStatus('applying', 'mark_applied')).toBeNull();
        expect(nextLessonStatus('candidate', 'apply')).toBeNull();
        expect(nextLessonStatus('candidate', 'mark_applied')).toBeNull();
        expect(LESSON_STATUSES).toHaveLength(5);
    });

    it('moves approved lessons through applying to applied', () => {
        expect(nextLessonStatus('approved', 'apply')).toBe('applying');
        expect(nextLessonStatus('applying', 'job_merged')).toBe('applied');
        expect(nextLessonStatus('applying', 'job_failed')).toBe('approved');
        expect(nextLessonStatus('approved', 'mark_applied')).toBe('applied');
    });

    it('treats applied as final', () => {
        for (const e of ['approve', 'reject', 'reopen', 'apply', 'job_merged', 'job_failed', 'mark_applied'] as const) {
            expect(nextLessonStatus('applied', e)).toBeNull();
        }
    });
});
