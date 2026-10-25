import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GITHUB_PORT, type GitHubFile, type GitHubPort } from '../github/github.port.js';

import { ManifestSchema, type Manifest } from './manifest.schema.js';
import type { RepoResponseDto } from './repo.dto.js';
import { Repo } from './repo.entity.js';
import { RepoMapper } from './repo.mapper.js';

export const MANIFEST_PATH = '.gilde.json';

/** Caches each repo's .gilde.json (stacks, test commands, skills) on the repo row. */
@Injectable()
export class RepoManifestService {
    private readonly logger = new Logger(RepoManifestService.name);

    constructor(
        private readonly repoMapper: RepoMapper,
        @InjectRepository(Repo) private readonly repoRepository: Repository<Repo>,
        @Inject(GITHUB_PORT) private readonly github: GitHubPort,
    ) { }

    @Cron(CronExpression.EVERY_HOUR)
    async refreshAll(): Promise<void> {
        if (!this.github.isConfigured()) return;
        const repos = await this.repoRepository.find({ select: { id: true } });
        for (const { id } of repos) await this.refreshQuietly(id);
    }

    /** Like `refresh`, but never throws: for callers where the manifest is a side effect. */
    async refreshQuietly(repoId: string): Promise<void> {
        try {
            await this.refresh(repoId);
        } catch (e) {
            this.logger.warn(`Manifest refresh for repo ${repoId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Reads .gilde.json from the default branch. On success the values are cached; on any failure the last
     * good values are kept and only manifestError is set.
     */
    async refresh(repoId: string): Promise<RepoResponseDto> {
        const repo = await this.repoRepository.findOneBy({ id: repoId });
        if (!repo) throw new NotFoundException(`Repo ${repoId} not found`);

        const result = await this.load(repo);
        if ('error' in result) {
            repo.manifestError = result.error;
        } else {
            const { manifest, sha } = result;
            repo.stacks = manifest.stacks;
            repo.testCommands = manifest.testCommands;
            repo.skills = manifest.skills ?? null;
            repo.manifestSha = sha;
            repo.manifestSyncedAt = new Date();
            repo.manifestError = null;
        }
        return this.repoMapper.toDTO(await this.repoRepository.save(repo));
    }

    private async load(repo: Repo): Promise<{ error: string } | { manifest: Manifest; sha: string }> {
        let file: GitHubFile | null;
        try {
            file = await this.github.getFileContent(repo.fullName, MANIFEST_PATH, repo.defaultBranch);
        } catch (e) {
            return { error: `Could not read ${MANIFEST_PATH}: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (!file) return { error: `${MANIFEST_PATH} not found on ${repo.defaultBranch}` };

        let json: unknown;
        try {
            json = JSON.parse(file.content);
        } catch (e) {
            return { error: `${MANIFEST_PATH} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
        }
        const parsed = ManifestSchema.safeParse(json);
        if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
            return { error: `${MANIFEST_PATH} is invalid: ${issues}` };
        }
        return { manifest: parsed.data, sha: file.sha };
    }
}
