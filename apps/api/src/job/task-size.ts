/** Most characters of a job's task plus all its acceptance criteria; keeps the prompt well under the routine limit. */
export const TASK_CONTENT_LIMIT = 40_000;

/** task.length + sum(criterion.length), in characters. */
export function taskContentSize(task: string, acceptanceCriteria: readonly string[] = []): number {
    return acceptanceCriteria.reduce((sum, c) => sum + c.length, task.length);
}

/** A readable problem when the task and criteria together exceed TASK_CONTENT_LIMIT (exactly the limit is fine); null otherwise. */
export function taskContentProblem(task: string, acceptanceCriteria: readonly string[] = [], subject = 'The task and acceptance criteria'): string | null {
    const size = taskContentSize(task, acceptanceCriteria);
    if (size <= TASK_CONTENT_LIMIT) return null;
    return `${subject} are ${size} characters together (task ${task.length} plus ${acceptanceCriteria.length} criteria ${size - task.length}), over the ${TASK_CONTENT_LIMIT} limit; shorten the task or split the work into several jobs`;
}
