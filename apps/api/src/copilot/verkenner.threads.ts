import { Logger } from '@nestjs/common';
import type { Mastra } from '@mastra/core/mastra';

import type { CopilotUser } from './copilot.context.js';
import { SCOUT_AGENT_ID } from './verkenner.config.js';
import { scoutStreamOptions, scoutThreadId } from './verkenner.context.js';

/**
 * Server-owned memory threads of the scout: one per project (`verkenner:<projectId>`), always under the bot user as
 * resource. Notifications can create a thread by waking an idle one, but `sendStateSignal` needs it to exist first
 * (verified in verkenner.signals.spike.spec.ts), so whatever publishes into a project thread calls `ensureThread` first.
 */
export class ScoutThreads {
    private readonly logger = new Logger('Verkenner');

    constructor(
        private readonly mastra: Mastra,
        readonly user: CopilotUser,
        /** Throws NotFoundException for an unknown project id. */
        private readonly projects: { getById(id: string): Promise<unknown> },
    ) { }

    get resourceId(): string {
        return this.user.id;
    }

    threadId(projectId: string): string {
        return scoutThreadId(projectId);
    }

    /** Creates the project thread when it is missing and returns its target. Refuses a thread owned by anyone else. */
    async ensureThread(projectId: string): Promise<{ resourceId: string; threadId: string }> {
        await this.projects.getById(projectId);
        const memory = await this.mastra.getAgent(SCOUT_AGENT_ID).getMemory();
        if (!memory) throw new Error('The scout has no memory');
        const target = { resourceId: this.user.id, threadId: scoutThreadId(projectId) };

        const existing = await memory.getThreadById({ threadId: target.threadId });
        if (existing) {
            if (existing.resourceId !== target.resourceId) throw new Error(`Thread ${target.threadId} belongs to another resource`);
            return target;
        }
        try {
            await memory.createThread({ ...target, title: `Verkenner ${projectId}`, metadata: { projectId } });
        } catch (error) {
            // A concurrent caller may have created it between the read and the write.
            const created = await memory.getThreadById({ threadId: target.threadId });
            if (created?.resourceId !== target.resourceId) throw error;
            this.logger.debug(`Thread ${target.threadId} was created concurrently`);
        }
        return target;
    }

    /** Options for a run on the project thread: the memory thread and the server-issued binding. */
    streamOptions(projectId: string) {
        return scoutStreamOptions(this.user, projectId);
    }
}
