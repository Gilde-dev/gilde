import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@nestjs/common';
import { LibSQLStore } from '@mastra/libsql';
import type { Mastra } from '@mastra/core/mastra';

import { createMastra } from './copilot.mastra.js';
import { CopilotThreadsService, toChatMessages, UNTITLED_THREAD } from './copilot-threads.service.js';

describe('CopilotThreadsService', () => {
    let dir: string;
    let mastra: Mastra;
    let service: CopilotThreadsService;
    let store: any;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'gilde-threads-'));
        mastra = createMastra({ enabled: true, model: 'openai/test-model' }, {} as never, new LibSQLStore({ id: 'threads', url: `file:${join(dir, 'm.db')}` }));
        service = new CopilotThreadsService(mastra);
        store = await mastra.getStorage()!.getStore('memory');
        const thread = (id: string, resourceId: string, title: string, updatedAt: string) =>
            store.saveThread({ thread: { id, resourceId, title, createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt), metadata: {} } });
        await thread('old', 'alice', 'Named', '2026-01-01T00:00:00Z');
        await thread('new', 'alice', '', '2026-03-01T00:00:00Z');
        await thread('empty', 'alice', 'New Thread 2026', '2026-02-01T00:00:00Z');
        await thread('bobs', 'bob', 'Bob', '2026-04-01T00:00:00Z');
        await thread('verkenner:p1', 'alice', 'Scout', '2026-05-01T00:00:00Z');
        const msg = (id: string, threadId: string, role: 'user' | 'assistant', parts: unknown[], at: string) => ({
            id, threadId, resourceId: 'alice', role, createdAt: new Date(at), content: { format: 2 as const, parts: parts as never },
        });
        await store.saveMessages({
            messages: [
                msg('m1', 'new', 'user', [{ type: 'text', text: `  ${'x'.repeat(80)}\nsecond line` }], '2026-03-01T00:00:01Z'),
                msg('m2', 'new', 'assistant', [{ type: 'text', text: 'Looking' }, { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'c1', toolName: 'listJobs', args: { a: 1 }, result: { ok: true } } }], '2026-03-01T00:00:02Z'),
                msg('m3', 'empty', 'assistant', [{ type: 'text', text: 'hi' }], '2026-02-01T00:00:01Z'),
            ] as never,
        });
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('lists only the caller\'s threads, newest first, without the scout\'s', async () => {
        const list = await service.list('alice');
        expect(list.map((t) => t.id)).toEqual(['new', 'empty', 'old']);
        expect(await service.list('bob')).toHaveLength(1);
        expect(await service.list('nobody')).toEqual([]);
    });

    it('titles: Mastra title, else the first user message cut to 60 characters, else untitled', async () => {
        const byId = Object.fromEntries((await service.list('alice')).map((t) => [t.id, t.title]));
        expect(byId.old).toBe('Named');
        expect(byId.new).toHaveLength(60);
        expect(byId.new.endsWith('…')).toBe(true);
        expect(byId.new).not.toContain('\n');
        expect(byId.empty).toBe(UNTITLED_THREAD);
    });

    it('returns the messages of an own thread as chat history', async () => {
        const res = await service.messages('alice', 'new');
        expect(res.thread.id).toBe('new');
        expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
        expect(res.messages[1]).toMatchObject({ content: 'Looking', toolCalls: [{ id: 'c1', name: 'listJobs', arguments: '{"a":1}' }] });
        expect(res.messages[2]).toMatchObject({ toolCallId: 'c1', content: '{"ok":true}' });
    });

    it.each([['another user', 'bob', 'new'], ['the scout thread', 'alice', 'verkenner:p1'], ['an unknown id', 'alice', 'nope']])('404 for %s', async (_n, user, id) => {
        await expect(service.messages(user, id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('drops empty and system messages when converting', () => {
        const base = { createdAt: new Date(), content: { format: 2 as const, parts: [] } };
        expect(toChatMessages([{ ...base, id: 'a', role: 'assistant' }, { ...base, id: 'b', role: 'system' }] as never)).toEqual([]);
    });
});
