import { TASK_CONTENT_LIMIT, taskContentProblem, taskContentSize } from './task-size.js';

describe('task content size', () => {
    it('is task.length plus the length of every criterion', () => {
        expect(taskContentSize('abcd', ['12', '345'])).toBe(9);
        expect(taskContentSize('abcd')).toBe(4);
        expect(taskContentSize('😀', [])).toBe(2);
    });

    it('accepts exactly the limit and rejects one more, counting criteria', () => {
        expect(TASK_CONTENT_LIMIT).toBe(40_000);
        expect(taskContentProblem('x'.repeat(39_999), [])).toBeNull();
        expect(taskContentProblem('x'.repeat(40_000), [])).toBeNull();
        expect(taskContentProblem('x'.repeat(39_000), ['y'.repeat(1_000)])).toBeNull();
        expect(taskContentProblem('x'.repeat(40_001), [])).toContain('40001 characters');
        expect(taskContentProblem('x'.repeat(39_999), ['yy'])).toMatch(/40001 characters together.*over the 40000 limit; shorten the task/);
    });
});
