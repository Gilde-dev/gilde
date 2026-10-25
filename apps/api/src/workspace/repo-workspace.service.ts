import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { cleanRepoPath, isSecretPath } from './repo-path.js';

export const MAX_GREP_MATCHES = 50;
export const GREP_CONTEXT_LINES = 2;
/** A clone is refreshed on demand at most this often. */
export const REFRESH_INTERVAL_MS = 10 * 60_000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60_000;
const GIT_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 2_000_000;

export interface WorkspaceRepo {
    id: string;
    fullName: string;
    defaultBranch: string;
}

export interface WorkspaceStatus {
    cloned: boolean;
    headSha: string | null;
    fetchedAt: string | null;
    error: string | null;
}

export interface GrepLine {
    line: number;
    text: string;
}

export interface GrepMatch {
    path: string;
    line: number;
    text: string;
    context: GrepLine[];
}

export interface GrepResult {
    matches: GrepMatch[];
    /** True when there were more than MAX_GREP_MATCHES matches. */
    truncated: boolean;
}

export interface DirEntry {
    name: string;
    path: string;
    type: 'file' | 'dir';
}

interface State {
    headSha: string | null;
    fetchedAt: Date | null;
    attemptedAt: number;
    error: string | null;
}

/**
 * Keeps one read-only, depth-1 clone of every registered repo under GILDE_WORKSPACE_DIR and answers
 * grep / list / read questions from it. Gilde never commits, pushes or checks out other branches in a clone.
 * The GitHub token is handed to git per command and is never stored or logged.
 */
@Injectable()
export class RepoWorkspaceService {
    private readonly logger = new Logger(RepoWorkspaceService.name);
    private readonly state = new Map<string, State>();
    private readonly locks = new Map<string, Promise<unknown>>();

    /** The directory with all clones: GILDE_WORKSPACE_DIR, default .gilde-workspace in the working directory. */
    get root(): string {
        return resolve(process.env.GILDE_WORKSPACE_DIR || '.gilde-workspace');
    }

    /** Where the clone of `fullName` lives. */
    cloneDir(fullName: string): string {
        if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || fullName.includes('..')) throw new Error(`Invalid repo name: ${fullName}`);
        return join(this.root, fullName.replace('/', '__'));
    }

    /** Where git fetches from. Overridable so tests can use a local repository. */
    protected remoteUrl(fullName: string): string {
        return `https://github.com/${fullName}.git`;
    }

    /** Runs git with an argument array (no shell). The token is only ever part of the `-c` arguments of that one command. */
    protected git(args: string[], opts: { cwd?: string; auth?: boolean } = {}): Promise<string> {
        const token = process.env.GITHUB_TOKEN;
        const full = opts.auth && token ? ['-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args] : args;
        return new Promise((ok, fail) => {
            execFile(
                'git',
                full,
                {
                    cwd: opts.cwd,
                    timeout: GIT_TIMEOUT_MS,
                    maxBuffer: 16 * 1024 * 1024,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_CONFIG_NOSYSTEM: '1' },
                },
                (err, stdout, stderr) => {
                    if (!err) return ok(stdout);
                    // Exit code 1 is "no matches" for grep; callers handle it. Never include the arguments (token) in errors.
                    const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
                    const e = new Error(scrub(`git ${args[0]} failed${code !== undefined ? ` (${code})` : ''}: ${stderr.trim() || err.message}`, token)) as Error & { exitCode?: number | string };
                    e.exitCode = code;
                    fail(e);
                },
            );
        });
    }

    /** Serializes operations per repo. */
    private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
        this.locks.set(key, run);
        void run.finally(() => {
            if (this.locks.get(key) === run) this.locks.delete(key);
        }).catch(() => undefined);
        return run;
    }

    /** Clones or fetches the default branch and hard-resets to it. Never throws; the outcome is in `status`. */
    sync(repo: WorkspaceRepo): Promise<void> {
        return this.withLock(repo.id, () => this.doSync(repo));
    }

    private async doSync(repo: WorkspaceRepo): Promise<void> {
        const st = this.stateOf(repo.id);
        st.attemptedAt = Date.now();
        try {
            if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
            const dir = this.cloneDir(repo.fullName);
            const branch = repo.defaultBranch;
            if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error(`Invalid branch name: ${branch}`);
            const ref = `refs/remotes/origin/${branch}`;
            if (await exists(join(dir, '.git'))) {
                await this.git(['fetch', '--depth', '1', 'origin', `+refs/heads/${branch}:${ref}`], { cwd: dir, auth: true });
                await this.git(['reset', '--hard', ref], { cwd: dir });
            } else {
                await mkdir(dirname(dir), { recursive: true });
                await this.git(['clone', '--depth', '1', '--no-tags', '--branch', branch, this.remoteUrl(repo.fullName), dir], { auth: true });
            }
            st.headSha = (await this.git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
            st.fetchedAt = new Date();
            st.error = null;
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Workspace sync for ${repo.fullName} failed: ${st.error}`);
        }
    }

    /**
     * The clone directory when it is usable: refreshed at most every 10 minutes on demand.
     * Null when the clone is missing or the fetch failed.
     */
    async ensure(repo: WorkspaceRepo): Promise<string | null> {
        const st = this.stateOf(repo.id);
        const age = Date.now() - st.attemptedAt;
        const fresh = st.error === null ? age < REFRESH_INTERVAL_MS && st.fetchedAt !== null : age < RETRY_AFTER_FAILURE_MS;
        if (!fresh) await this.sync(repo);
        if (st.error !== null || st.fetchedAt === null) return null;
        const dir = this.cloneDir(repo.fullName);
        return (await exists(join(dir, '.git'))) ? dir : null;
    }

    status(repo: WorkspaceRepo): WorkspaceStatus {
        const st = this.state.get(repo.id);
        return { cloned: !!st?.fetchedAt, headSha: st?.headSha ?? null, fetchedAt: st?.fetchedAt?.toISOString() ?? null, error: st?.error ?? null };
    }

    /** Clone status including a clone found on disk from an earlier process. */
    async describe(repo: WorkspaceRepo): Promise<WorkspaceStatus> {
        const s = this.status(repo);
        if (s.cloned) return s;
        const dir = this.cloneDir(repo.fullName);
        if (!(await exists(join(dir, '.git')))) return s;
        const headSha = await this.git(['rev-parse', 'HEAD'], { cwd: dir }).then((o) => o.trim(), () => null);
        return { ...s, cloned: headSha !== null, headSha };
    }

    /** git grep over the clone: fixed string unless `regex`, at most 50 matches, 2 lines of context. */
    async grep(dir: string, opts: { query: string; regex?: boolean; path?: string }): Promise<GrepResult> {
        const scope = opts.path ? await this.resolveInside(dir, opts.path) : null;
        const args = ['grep', '-n', '-I', '--no-color', '-z', opts.regex ? '-E' : '-F', '-e', opts.query, '--'];
        args.push(scope ? scope.rel : '.');
        let out: string;
        try {
            out = await this.git(args, { cwd: dir });
        } catch (e) {
            if ((e as { exitCode?: unknown }).exitCode === 1) return { matches: [], truncated: false };
            throw e;
        }
        const rows = parseGrep(out).filter((r) => !isSecretPath(r.path));
        const matches: GrepMatch[] = [];
        const files = new Map<string, string[]>();
        for (const r of rows.slice(0, MAX_GREP_MATCHES)) {
            let lines = files.get(r.path);
            if (!lines) {
                lines = ((await this.readFile(dir, r.path).catch(() => null)) ?? '').split('\n');
                files.set(r.path, lines);
            }
            const context: GrepLine[] = [];
            for (let n = Math.max(1, r.line - GREP_CONTEXT_LINES); n <= Math.min(lines.length, r.line + GREP_CONTEXT_LINES); n++) {
                if (n !== r.line) context.push({ line: n, text: lines[n - 1] });
            }
            matches.push({ path: r.path, line: r.line, text: r.text, context });
        }
        return { matches, truncated: rows.length > MAX_GREP_MATCHES };
    }

    async listDirectory(dir: string, path: string): Promise<DirEntry[] | null> {
        const target = await this.resolveInside(dir, path, { allowRoot: true }).catch((e: Error) => {
            if ((e as { notFound?: boolean }).notFound) return null;
            throw e;
        });
        if (!target) return null;
        if (!(await stat(target.abs)).isDirectory()) throw new Error(`${path} is not a directory`);
        const names = (await readdir(target.abs, { withFileTypes: true })).filter((d) => d.name !== '.git' || target.rel !== '');
        const out: DirEntry[] = [];
        for (const d of names) {
            const p = target.rel ? `${target.rel}/${d.name}` : d.name;
            if (target.rel === '' && d.name === '.git') continue;
            if (isSecretPath(p)) continue;
            // Symlinks are listed only when they stay inside the clone.
            const inside = d.isSymbolicLink() ? await this.resolveInside(dir, p).then(() => true, () => false) : true;
            if (!inside) continue;
            const isDir = d.isDirectory() || (d.isSymbolicLink() && (await stat(join(dir, p)).catch(() => null))?.isDirectory());
            out.push({ name: d.name, path: p, type: isDir ? 'dir' : 'file' });
        }
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    async readFile(dir: string, path: string): Promise<string | null> {
        if (isSecretPath(path)) throw new Error('Refusing to read a secret file');
        const target = await this.resolveInside(dir, path).catch((e: Error) => {
            if ((e as { notFound?: boolean }).notFound) return null;
            throw e;
        });
        if (!target) return null;
        const info = await stat(target.abs);
        if (!info.isFile()) throw new Error(`${path} is not a file`);
        if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to read (${info.size} bytes)`);
        return readFile(target.abs, 'utf8');
    }

    /**
     * A repo-relative path resolved inside the clone. Rejects `..`, absolute paths, secret files, .git, and any
     * symlink that leads outside the clone. Throws an error with `notFound` when the path does not exist.
     */
    async resolveInside(dir: string, path: string, opts: { allowRoot?: boolean } = {}): Promise<{ abs: string; rel: string }> {
        const rel = cleanRepoPath(path);
        if (!rel && !opts.allowRoot) throw new Error('A path is required');
        if (rel === '.git' || rel.startsWith('.git/')) throw new Error('Paths inside .git are not allowed');
        if (rel && isSecretPath(rel)) throw new Error('Refusing to read a secret file');
        const rootReal = await realpath(dir);
        const abs = resolve(rootReal, rel);
        let real: string;
        try {
            real = await realpath(abs);
        } catch {
            // Not existing; a dangling symlink is also "not found", but never reads outside.
            const e = new Error(`${path} not found`) as Error & { notFound: boolean };
            e.notFound = true;
            throw e;
        }
        const back = relative(rootReal, real);
        if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Error('Path resolves outside the repo');
        if (back === '.git' || back.startsWith(`.git${sep}`)) throw new Error('Paths inside .git are not allowed');
        if (back && isSecretPath(back.split(sep).join('/'))) throw new Error('Refusing to read a secret file');
        return { abs: real, rel };
    }

    private stateOf(id: string): State {
        let st = this.state.get(id);
        if (!st) {
            st = { headSha: null, fetchedAt: null, attemptedAt: 0, error: null };
            this.state.set(id, st);
        }
        return st;
    }
}

async function exists(path: string): Promise<boolean> {
    return lstat(path).then(() => true, () => false);
}

function scrub(text: string, token: string | undefined): string {
    return token ? text.split(token).join('***') : text;
}

/** Parses `git grep -n -z` output: `path NUL line NUL text` per match. */
export function parseGrep(out: string): { path: string; line: number; text: string }[] {
    const rows: { path: string; line: number; text: string }[] = [];
    for (const raw of out.split('\n')) {
        const m = /^([^\0]+)\0(\d+)\0(.*)$/s.exec(raw);
        if (m) rows.push({ path: m[1], line: Number(m[2]), text: m[3] });
    }
    return rows;
}
