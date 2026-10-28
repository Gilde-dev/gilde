import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Mastra } from '@mastra/core/mastra';
import type { MastraDBMessage } from '@mastra/core/agent';

import type { CopilotThreadDto, CopilotThreadMessageDto, CopilotThreadMessagesDto } from './copilot.dto.js';
import { COPILOT_MASTRA } from './copilot.tokens.js';
import { SCOUT_AGENT_ID } from './verkenner.config.js';

const SCOUT_THREAD_PREFIX = `${SCOUT_AGENT_ID}:`;
export const UNTITLED_THREAD = 'Untitled conversation';
const TITLE_LENGTH = 60;
/** Mastra's placeholder title for a thread nobody has named. */
const PLACEHOLDER_TITLE = /^new thread\b/i;

const clip = (text: string) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > TITLE_LENGTH ? `${oneLine.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : oneLine;
};

function textOf(message: MastraDBMessage): string {
    const { content } = message;
    const parts = (content.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : []));
    if (parts.length > 0) return parts.join('');
    return typeof content.content === 'string' ? content.content : '';
}

/** Mastra stores one assistant turn as one message with tool-invocation parts; the chat wants calls and results apart. */
export function toChatMessages(messages: MastraDBMessage[]): CopilotThreadMessageDto[] {
    const out: CopilotThreadMessageDto[] = [];
    for (const m of messages) {
        if (m.role === 'user') {
            const content = textOf(m);
            if (content) out.push({ id: m.id, role: 'user', content });
        } else if (m.role === 'assistant') {
            const invocations = (m.content.parts ?? []).flatMap((p) => (p.type === 'tool-invocation' ? [p.toolInvocation] : []));
            const content = textOf(m);
            if (!content && invocations.length === 0) continue;
            out.push({
                id: m.id,
                role: 'assistant',
                content,
                ...(invocations.length > 0 && { toolCalls: invocations.map((t) => ({ id: t.toolCallId, name: t.toolName, arguments: JSON.stringify(t.args ?? {}) })) }),
            });
            for (const t of invocations) {
                if (t.state !== 'result') continue;
                out.push({ id: `${m.id}:${t.toolCallId}`, role: 'tool', toolCallId: t.toolCallId, content: typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? null) });
            }
        }
    }
    return out;
}

/**
 * Read side of the human co-pilot's conversations: the caller's own Mastra memory threads (resourceId = user id).
 * Threads of other users, and the scout's (`verkenner:` ids, owned by a bot user), are never returned; both look like
 * a missing thread.
 */
@Injectable()
export class CopilotThreadsService {
    constructor(@Inject(COPILOT_MASTRA) private readonly mastra: Mastra) { }

    private async store() {
        const store = await this.mastra.getStorage()?.getStore('memory');
        if (!store) throw new NotFoundException('Conversations are not available');
        return store;
    }

    /** The user's conversations, most recently active first. */
    async list(userId: string): Promise<CopilotThreadDto[]> {
        const store = await this.store();
        const { threads } = await store.listThreads({ filter: { resourceId: userId }, perPage: false });
        const own = threads.filter((t) => t.resourceId === userId && !t.id.startsWith(SCOUT_THREAD_PREFIX));
        own.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return Promise.all(own.map((t) => this.summarize(store, t)));
    }

    async messages(userId: string, threadId: string): Promise<CopilotThreadMessagesDto> {
        const store = await this.store();
        const thread = await store.getThreadById({ threadId });
        if (!thread || thread.resourceId !== userId || thread.id.startsWith(SCOUT_THREAD_PREFIX)) throw new NotFoundException('Conversation not found');
        const { messages } = await store.listMessages({ threadId, resourceId: userId, perPage: false });
        messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const title = await this.titleOf(store, thread);
        return { thread: toDto(thread, title), messages: toChatMessages(messages) };
    }

    private async summarize(store: Awaited<ReturnType<CopilotThreadsService['store']>>, thread: Thread): Promise<CopilotThreadDto> {
        return toDto(thread, await this.titleOf(store, thread));
    }

    private async titleOf(store: Awaited<ReturnType<CopilotThreadsService['store']>>, thread: Thread): Promise<string> {
        const set = thread.title?.trim();
        if (set && !PLACEHOLDER_TITLE.test(set)) return set;
        const { messages } = await store.listMessages({ threadId: thread.id, resourceId: thread.resourceId, perPage: false, orderBy: { field: 'createdAt', direction: 'ASC' } });
        const first = messages.find((m) => m.role === 'user' && textOf(m).trim());
        return first ? clip(textOf(first)) : UNTITLED_THREAD;
    }
}

type Thread = { id: string; title?: string; resourceId: string; createdAt: Date; updatedAt: Date };

function toDto(thread: Thread, title: string): CopilotThreadDto {
    return { id: thread.id, title, createdAt: new Date(thread.createdAt).toISOString(), updatedAt: new Date(thread.updatedAt).toISOString() };
}
