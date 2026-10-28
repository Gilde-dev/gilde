import { Inject, Injectable } from '@nestjs/common';

import { GITHUB_PORT, type GitHubPort } from '../github/github.port.js';
import { buildRunContext, type RunContext } from '../run/run-context.js';

import { RepoSkillsReader } from './repo-skills.js';

export const GILDEBOEK_VERSION_PATH = '.claude/skills/.gildeboek-version';
const MAX_CACHE = 200;
const MAX_ERROR_LENGTH = 200;

export type RunContextCapture = { context: RunContext; contextError: null } | { context: null; contextError: string };

/**
 * Reads what an agent will have in a repo (skills, gildeboek version, AGENTS.md) from the default branch through
 * GitHubPort and the existing skill reader. Never throws: a failure becomes `context: null` plus a short `contextError`.
 * Cached per repo and default-branch commit, so a burst of fires reads GitHub once.
 */
@Injectable()
export class RunContextService {
    private readonly cache = new Map<string, Promise<RunContext>>();

    constructor(
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
        private readonly reader: RepoSkillsReader,
    ) { }

    async capture(repo: { id: string; fullName: string; defaultBranch: string }): Promise<RunContextCapture> {
        try {
            if (!this.github.isConfigured()) throw new Error('GitHub is not configured');
            const sha = await this.github.getBranchHeadSha(repo.fullName, repo.defaultBranch);
            const key = `${repo.id}:${sha}`;
            let pending = this.cache.get(key);
            if (!pending) {
                pending = this.read(repo);
                this.cache.set(key, pending);
                if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
                // A failed read must not stay cached.
                pending.catch(() => this.cache.delete(key));
            }
            return { context: await pending, contextError: null };
        } catch (e) {
            return { context: null, contextError: describe(e) };
        }
    }

    private async read(repo: { id: string; fullName: string; defaultBranch: string }): Promise<RunContext> {
        // The reader's own cache is time based; the commit moved (or we would not be here), so read fresh.
        this.reader.invalidate(repo.id);
        const [skills, version, agents] = await Promise.all([
            this.reader.read(repo),
            this.github.getFileContent(repo.fullName, GILDEBOEK_VERSION_PATH, repo.defaultBranch),
            this.github.getFileContent(repo.fullName, 'AGENTS.md', repo.defaultBranch),
        ]);
        return buildRunContext({
            skills,
            gildeboekVersion: version ? version.content.trim() : null,
            agentsMd: agents?.content ?? null,
            capturedAt: new Date(),
        });
    }
}

/** Adapter errors never carry headers or tokens, but keep the text short and single-line anyway. */
function describe(e: unknown): string {
    const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    return message.slice(0, MAX_ERROR_LENGTH) || 'Unknown error';
}
