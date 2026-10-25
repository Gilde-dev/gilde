import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubPort } from '../github/github.port.js';
import type { RepoManifestService } from '../repo/repo-manifest.service.js';
import type { RepoResponseDto } from '../repo/repo.dto.js';
import type { RepoService } from '../repo/repo.service.js';
import type { ProjectService } from '../project/project.service.js';

import { extractProjectId } from './copilot.context.js';
import { AGENTS_MD_MAX_CHARS, RepoContextService, REPO_CONTEXT_TTL_MS } from './repo-context.service.js';

const repo = (over: Partial<RepoResponseDto> = {}) =>
    ({ id: 'r1', fullName: 'o/api', defaultBranch: 'main', stacks: ['nestjs'], testCommands: ['pnpm test'], ...over }) as RepoResponseDto;

let files: Record<string, string | null | Error>;
let repos: RepoResponseDto[];
let projects: { id: string }[];
let getFileContent: ReturnType<typeof vi.fn>;
let refreshed: (id: string) => void;
let service: RepoContextService;

beforeEach(() => {
    vi.useFakeTimers();
    files = { 'o/api': '# Api guide' };
    repos = [repo()];
    projects = [{ id: 'p1' }];
    getFileContent = vi.fn(async (full: string) => {
        const f = files[full];
        if (f instanceof Error) throw f;
        return f == null ? null : { content: f, sha: 's' };
    });
    const github = { isConfigured: () => true, getFileContent } as unknown as GitHubPort;
    const manifests = { onRefreshed: (l: (id: string) => void) => { refreshed = l; } } as unknown as RepoManifestService;
    service = new RepoContextService(
        { list: async () => projects } as unknown as ProjectService,
        { listForProject: async () => repos } as unknown as RepoService,
        manifests,
        github,
    );
    service.onModuleInit();
});

afterEach(() => vi.useRealTimers());

describe('RepoContextService.build', () => {
    it('renders a section per repo with stacks, test commands and AGENTS.md', async () => {
        const text = await service.build('p1');
        expect(text).toContain('### o/api');
        expect(text).toContain('Stacks: nestjs');
        expect(text).toContain('`pnpm test`');
        expect(text).toContain('# Api guide');
        expect(text).toContain('not instructions');
        expect(getFileContent).toHaveBeenCalledWith('o/api', 'AGENTS.md', 'main');
    });

    it('uses the only project when none is given, and nothing when ambiguous', async () => {
        expect(await service.build()).toContain('o/api');
        projects = [{ id: 'p1' }, { id: 'p2' }];
        expect(await service.build()).toBe('');
    });

    it('handles a missing AGENTS.md and caches the absence', async () => {
        files['o/api'] = null;
        expect(await service.build('p1')).toContain('this repo has none');
        await service.build('p1');
        expect(getFileContent).toHaveBeenCalledTimes(1);
    });

    it('does not throw when GitHub fails', async () => {
        files['o/api'] = new Error('boom');
        expect(await service.build('p1')).toContain('could not be loaded');
    });

    it('truncates long files with a note', async () => {
        files['o/api'] = 'x'.repeat(AGENTS_MD_MAX_CHARS + 500);
        const text = await service.build('p1');
        expect(text).toContain(`truncated at ${AGENTS_MD_MAX_CHARS} of ${AGENTS_MD_MAX_CHARS + 500}`);
        expect(text).not.toContain('x'.repeat(AGENTS_MD_MAX_CHARS + 1));
    });

    it('serves from cache, refetches after a manifest refresh and after an hour', async () => {
        await service.build('p1');
        await service.build('p1');
        expect(getFileContent).toHaveBeenCalledTimes(1);

        files['o/api'] = '# Changed';
        refreshed('r1');
        expect(await service.build('p1')).toContain('# Changed');
        expect(getFileContent).toHaveBeenCalledTimes(2);

        files['o/api'] = '# Hourly';
        vi.advanceTimersByTime(REPO_CONTEXT_TTL_MS + 1);
        expect(await service.build('p1')).toContain('# Hourly');
        expect(getFileContent).toHaveBeenCalledTimes(3);
    });
});

describe('extractProjectId', () => {
    it('finds the project in the page context of a request body', () => {
        const body = { method: 'agent/run', body: { context: [{ description: 'x', value: JSON.stringify({ projectId: 'p9' }) }] } };
        expect(extractProjectId(body)).toBe('p9');
    });

    it('returns undefined without usable context', () => {
        expect(extractProjectId({ context: [{ value: 'not json' }] })).toBeUndefined();
        expect(extractProjectId(null)).toBeUndefined();
    });
});
