/**
 * The owner of a job: its creator when that is a non-bot human, otherwise the human who queued it. Capacity is personal,
 * so only the owner's executors may run the job. Null when neither is known.
 */
export function jobOwnerId(job: { createdById: string | null; queuedById: string | null }, creatorIsBot: boolean): string | null {
    if (job.createdById && !creatorIsBot) return job.createdById;
    return job.queuedById ?? null;
}
