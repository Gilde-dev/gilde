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
        expect(LESSON_STATUSES).toHaveLength(3);
    });
});
