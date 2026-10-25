import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentInstructionsService } from './agent-instructions.service.js';
import { ExecutionError } from './execution.error.js';

describe('AgentInstructionsService', () => {
    let dir: string;
    let file: string;
    const service = new AgentInstructionsService();

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'instructions-'));
        file = join(dir, 'agent-instructions.md');
        process.env.AGENT_INSTRUCTIONS_PATH = file;
    });
    afterEach(() => {
        delete process.env.AGENT_INSTRUCTIONS_PATH;
        rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to no instructions when the variable is unset', () => {
        delete process.env.AGENT_INSTRUCTIONS_PATH;
        expect(service.get()).toEqual({ text: null, version: null });
    });

    it('returns the text with a 12 char sha256 version', () => {
        writeFileSync(file, 'hello');
        expect(service.get()).toEqual({ text: 'hello', version: '2cf24dba5fb0' });
    });

    it('picks up edits without a restart', () => {
        writeFileSync(file, 'one');
        const first = service.get();
        writeFileSync(file, 'two');
        utimesSync(file, new Date(), new Date(Date.now() + 5000));
        const second = service.get();
        expect(second.text).toBe('two');
        expect(second.version).not.toBe(first.version);
    });

    it('treats a missing file as a config error', () => {
        expect(() => service.get()).toThrow(ExecutionError);
        try { service.get(); } catch (e) { expect((e as ExecutionError).kind).toBe('config'); }
    });

    it('treats an empty file as a config error', () => {
        writeFileSync(file, '  \n');
        try { service.get(); expect.unreachable(); } catch (e) {
            expect((e as ExecutionError).kind).toBe('config');
            expect((e as ExecutionError).message).toContain('empty');
        }
    });

    it('resolves relative paths against the working directory', () => {
        writeFileSync(file, 'rel');
        process.env.AGENT_INSTRUCTIONS_PATH = file.replace(process.cwd(), '.');
        expect(service.get().text).toBe('rel');
    });
});
