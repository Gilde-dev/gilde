import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitAuthHeader, RepoWorkspaceService, type WorkspaceRepo } from './repo-workspace.service.js';

const TOKEN = 'ghp_supersecrettoken123';
const TOKEN_B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

let tmp: string;
let remote: string;
let outside: string;
let repo: WorkspaceRepo;
let calls: string[][];

const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** Uses a local repository as the remote and records every git invocation. */
class TestWorkspace extends RepoWorkspaceService {
    protected override remoteUrl(): string {
        return remote;
    }
    protected override git(args: string[], opts: { cwd?: string; auth?: boolean } = {}): Promise<string> {
        calls.push(args);
        // The local remote needs no auth header; keep the real one out of the file transport.
        return super.git(args, opts);
    }
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gilde-ws-'));
    remote = join(tmp, 'remote');
    outside = join(tmp, 'outside');
    mkdirSync(remote);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    sh(remote, 'init', '-q', '-b', 'main');
    mkdirSync(join(remote, 'src'));
    writeFileSync(join(remote, 'src', 'jobs.ts'), 'one\ntwo\nexport function retryOrParkJob() {}\nfour\nfive\n');
    writeFileSync(join(remote, 'README.md'), 'hello\n');
    writeFileSync(join(remote, '.env'), 'retryOrParkJob=secret\n');
    writeFileSync(join(remote, 'tls.pem'), 'retryOrParkJob\n');
    symlinkSync(outside, join(remote, 'escape'));
    symlinkSync(join(outside, 'secret.txt'), join(remote, 'link.txt'));
    sh(remote, 'add', '.');
    sh(remote, 'commit', '-qm', 'init');
    process.env.GILDE_WORKSPACE_DIR = join(tmp, 'ws');
    process.env.GITHUB_TOKEN = TOKEN;
    repo = { id: 'r1', fullName: 'o/r', defaultBranch: 'main' };
    calls = [];
});

afterEach(() => {
    delete process.env.GILDE_WORKSPACE_DIR;
    delete process.env.GITHUB_TOKEN;
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('RepoWorkspaceService', () => {
    it('clones the default branch and fetches new commits', async () => {
        const ws = new TestWorkspace();
        const dir = await ws.ensure(repo);
        expect(dir).toBe(ws.cloneDir('o/r'));
        const first = ws.status(repo);
        expect(first).toMatchObject({ cloned: true, error: null, headSha: sh(remote, 'rev-parse', 'HEAD') });

        writeFileSync(join(remote, 'new.txt'), 'brand new\n');
        sh(remote, 'add', '.');
        sh(remote, 'commit', '-qm', 'second');
        await ws.sync(repo);
        expect(ws.status(repo).headSha).toBe(sh(remote, 'rev-parse', 'HEAD'));
        expect(await ws.readFile(dir!, 'new.txt')).toBe('brand new\n');
        // Only read-only operations: never commit, push or check out.
        expect(calls.flat().filter((a) => ['commit', 'push', 'checkout', 'switch'].includes(a))).toEqual([]);
    });

    it('refreshes on demand at most every 10 minutes', async () => {
        const ws = new TestWorkspace();
        await ws.ensure(repo);
        const n = calls.length;
        await ws.ensure(repo);
        expect(calls.length).toBe(n);
    });

    it('gitAuthHeader sends Basic auth with x-access-token, not Bearer', () => {
        const header = gitAuthHeader(TOKEN);
        expect(header).toBe(`Authorization: Basic ${TOKEN_B64}`);
        expect(header).not.toContain('Bearer');
        expect(Buffer.from(TOKEN_B64, 'base64').toString()).toBe(`x-access-token:${TOKEN}`);
    });

    it('serializes operations per repo', async () => {
        const ws = new TestWorkspace();
        await Promise.all([ws.sync(repo), ws.sync(repo), ws.sync(repo)]);
        expect(ws.status(repo)).toMatchObject({ cloned: true, error: null });
        expect(calls.filter((a) => a[0] === 'clone')).toHaveLength(1);
    });

    it('never stores the token in the clone config or logs it', async () => {
        const logs: string[] = [];
        for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void logs.push(String(m)));
        const ws = new TestWorkspace();
        const dir = (await ws.ensure(repo))!;
        await ws.sync(repo);
        for (const secret of [TOKEN, TOKEN_B64]) {
            expect(sh(dir, 'config', '--local', '--list')).not.toContain(secret);
            expect(sh(dir, 'remote', '-v')).not.toContain(secret);
            expect(logs.join('\n')).not.toContain(secret);
        }
        // The token is passed only as an http.extraHeader of the commands that talk to the remote.
        const withToken = calls.filter((a) => a.some((x) => x.includes(TOKEN) || x.includes(TOKEN_B64)));
        expect(withToken.length).toBe(0); // recorded args are pre-auth; the header is added inside git()
    });

    it('does not leak the token in errors or logs when the fetch fails', async () => {
        const logs: string[] = [];
        for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void logs.push(String(m)));
        const ws = new (class extends TestWorkspace {
            protected override remoteUrl(): string {
                return join(tmp, 'does-not-exist');
            }
        })();
        expect(await ws.ensure(repo)).toBeNull();
        const st = ws.status(repo);
        expect(st).toMatchObject({ cloned: false });
        expect(st.error).toBeTruthy();
        expect(`${st.error}${logs.join('')}`).not.toContain(TOKEN);
        expect(`${st.error}${logs.join('')}`).not.toContain(TOKEN_B64);
    });

    it('reports a missing clone, a missing token and unknown state', async () => {
        const ws = new TestWorkspace();
        expect(await ws.describe(repo)).toEqual({ cloned: false, headSha: null, fetchedAt: null, error: null });
        delete process.env.GITHUB_TOKEN;
        expect(await ws.ensure(repo)).toBeNull();
        expect(ws.status(repo).error).toContain('GITHUB_TOKEN');
    });

    it('rejects invalid repo names', () => {
        expect(() => new TestWorkspace().cloneDir('../x/y')).toThrow('Invalid repo name');
    });

    describe('with a clone', () => {
        let ws: TestWorkspace;
        let dir: string;
        beforeEach(async () => {
            ws = new TestWorkspace();
            dir = (await ws.ensure(repo))!;
        });

        it('finds code with a fixed string, with line number and context', async () => {
            const res = await ws.grep(dir, { query: 'retryOrParkJob' });
            expect(res.matches).toEqual([
                {
                    path: 'src/jobs.ts',
                    line: 3,
                    text: 'export function retryOrParkJob() {}',
                    context: [
                        { line: 1, text: 'one' },
                        { line: 2, text: 'two' },
                        { line: 4, text: 'four' },
                        { line: 5, text: 'five' },
                    ],
                },
            ]);
            expect(res.truncated).toBe(false);
        });

        it('treats the query as fixed text unless regex is set', async () => {
            expect((await ws.grep(dir, { query: 'retry.*Job' })).matches).toHaveLength(0);
            expect((await ws.grep(dir, { query: 'retry.*Job', regex: true })).matches).toHaveLength(1);
            // A query that looks like an option is still just a pattern.
            expect((await ws.grep(dir, { query: '--help' })).matches).toHaveLength(0);
        });

        it('limits the search to a path and returns nothing for no match', async () => {
            expect((await ws.grep(dir, { query: 'hello', path: 'src' })).matches).toHaveLength(0);
            expect((await ws.grep(dir, { query: 'hello', path: 'README.md' })).matches).toHaveLength(1);
        });

        it('caps matches at 50', async () => {
            const many = Array.from({ length: 80 }, (_, i) => `needle ${i}`).join('\n');
            writeFileSync(join(remote, 'many.txt'), many);
            sh(remote, 'add', '.');
            sh(remote, 'commit', '-qm', 'many');
            await ws.sync(repo);
            const res = await ws.grep(dir, { query: 'needle' });
            expect(res.matches).toHaveLength(50);
            expect(res.truncated).toBe(true);
        });

        it('leaves secret files out of search results and listings', async () => {
            const res = await ws.grep(dir, { query: 'retryOrParkJob' });
            expect(res.matches.map((m) => m.path)).toEqual(['src/jobs.ts']);
            expect((await ws.listDirectory(dir, ''))!.map((e) => e.path)).not.toEqual(expect.arrayContaining(['.env', 'tls.pem']));
        });

        it('lists directories and reads files', async () => {
            expect((await ws.listDirectory(dir, 'src'))).toEqual([{ name: 'jobs.ts', path: 'src/jobs.ts', type: 'file' }]);
            expect(await ws.listDirectory(dir, 'nope')).toBeNull();
            expect(await ws.readFile(dir, 'README.md')).toBe('hello\n');
            expect(await ws.readFile(dir, 'nope.md')).toBeNull();
        });

        it('refuses .., absolute paths, .git and secret files', async () => {
            await expect(ws.readFile(dir, '../outside/secret.txt')).rejects.toThrow('..');
            await expect(ws.readFile(dir, '/etc/passwd')).rejects.toThrow('Absolute');
            await expect(ws.readFile(dir, '.git/config')).rejects.toThrow('.git');
            await expect(ws.readFile(dir, '.env')).rejects.toThrow('secret');
            await expect(ws.readFile(dir, 'tls.pem')).rejects.toThrow('secret');
            await expect(ws.grep(dir, { query: 'x', path: '../outside' })).rejects.toThrow('..');
            await expect(ws.grep(dir, { query: 'x', path: '/etc' })).rejects.toThrow('Absolute');
        });

        it('refuses symlinks that lead outside the clone', async () => {
            await expect(ws.readFile(dir, 'link.txt')).rejects.toThrow('outside');
            await expect(ws.readFile(dir, 'escape/secret.txt')).rejects.toThrow('outside');
            await expect(ws.listDirectory(dir, 'escape')).rejects.toThrow('outside');
            await expect(ws.grep(dir, { query: 'secret', path: 'escape' })).rejects.toThrow('outside');
            expect((await ws.grep(dir, { query: 'top secret' })).matches).toEqual([]);
            expect((await ws.listDirectory(dir, ''))!.map((e) => e.name)).not.toContain('escape');
        });
    });
});
