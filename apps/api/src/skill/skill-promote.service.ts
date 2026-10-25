import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { JobService } from '../job/job.service.js';
import { ProjectService } from '../project/project.service.js';
import { RepoService } from '../repo/repo.service.js';

import { desiredSkills } from './desired-skills.js';
import { FolderSkillLibrary } from './folder-skill-library.js';
import { RepoSkillsReader, REPO_SKILLS_DIR } from './repo-skills.js';
import { MAX_PROMOTE_CHARS, type PromoteSkillDto, type PromoteSkillResponseDto } from './skill.dto.js';
import { SkillLibraryResolver } from './skill-library.resolver.js';
import type { SkillFile } from './skill-library.js';

/** Moves a repo-owned skill into the project's skills library. */
@Injectable()
export class SkillPromoteService {
    constructor(
        private readonly projects: ProjectService,
        private readonly repos: RepoService,
        private readonly resolver: SkillLibraryResolver,
        private readonly jobs: JobService,
        private readonly reader: RepoSkillsReader,
    ) { }

    async promote(repoId: string, name: string, dto: PromoteSkillDto): Promise<PromoteSkillResponseDto> {
        const repo = await this.repos.getById(repoId);
        const project = await this.projects.getById(repo.projectId);
        if (project.skillsLibrary === 'none') throw new ConflictException('This project has no skills library to promote to');

        const skill = (await this.reader.read(repo)).find((s) => s.name === name);
        if (!skill) throw new NotFoundException(`Repo ${repo.fullName} has no skill '${name}'`);
        if (skill.source !== 'repo') throw new ConflictException(`Skill '${name}' is managed (${skill.managedBy}) and cannot be promoted`);

        const { kind, library } = await this.resolver.resolve(project);
        const catalog = await library.getCatalog();
        if (catalog.some((s) => s.name === name)) throw new ConflictException(`The library already has a skill named '${name}'`);

        const chars = skill.files.reduce((n, f) => n + f.content.length, 0);
        if (chars > MAX_PROMOTE_CHARS) {
            throw new BadRequestException(`Skill '${name}' is ${chars} characters; at most ${MAX_PROMOTE_CHARS} can be promoted`);
        }

        const entry = { name, scope: dto.scope, ...(dto.scope === 'stack' ? { stacks: dto.stacks } : {}) };
        let libraryJobId: string | null = null;
        if (kind === 'folder') {
            await (library as FolderSkillLibrary).addSkill(entry, skill.files);
        } else {
            const libraryRepoId = project.skillsLibraryRepoId!;
            const job = await this.jobs.create(libraryRepoId, {
                title: `Add skill ${name} to the skills library`,
                task: libraryTask(name, skill.files, dto),
                acceptanceCriteria: [
                    `skills/${name}/ contains exactly the given files, unchanged`,
                    `registry.yaml has an entry for ${name} with scope ${dto.scope}${dto.scope === 'stack' ? ` and stacks ${dto.stacks!.join(', ')}` : ''}`,
                    'The repo test commands pass',
                ],
            });
            libraryJobId = job.id;
        }

        const covered = desiredSkills(repo, [...catalog, entry]).includes(name);
        const cleanup = await this.jobs.create(repo.id, {
            title: `Remove promoted skill ${name}`,
            task: cleanupTask(name, covered, repo.skills?.exclude?.includes(name) ?? false),
            acceptanceCriteria: [
                `.claude/skills/${name}/ no longer exists`,
                covered ? '.gilde.json is unchanged' : `.gilde.json lists ${name} in skills.include`,
            ],
            ...(libraryJobId ? { dependsOn: [libraryJobId] } : {}),
        });
        return { libraryJobId, cleanupJobId: cleanup.id };
    }
}

/** A code fence longer than any backtick run in the content, so the content can't close it. */
function fence(content: string): string {
    const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((m) => m.length));
    return '`'.repeat(longest + 1);
}

function libraryTask(name: string, files: SkillFile[], dto: PromoteSkillDto): string {
    const embedded = files
        .map((f) => {
            const f3 = fence(f.content);
            return `File: ${f.path}\n${f3}\n${f.content}\n${f3}`;
        })
        .join('\n\n');
    const scope = dto.scope === 'stack' ? `scope stack and stacks [${dto.stacks!.join(', ')}]` : 'scope global';
    return [
        `Add the skill '${name}' to this skills library. Add the files below as skills/${name}/ unchanged (same paths, same content), and add an entry for '${name}' to registry.yaml with ${scope}.`,
        'Follow this repo\'s AGENTS.md and run its test commands.',
        embedded,
    ].join('\n\n');
}

function cleanupTask(name: string, covered: boolean, excluded: boolean): string {
    const manifest = covered
        ? `The repo manifest already gets '${name}' from the library, so leave .gilde.json unchanged.`
        : `Add '${name}' to skills.include in .gilde.json${excluded ? ` and remove it from skills.exclude` : ''}.`;
    return [
        `The skill '${name}' was promoted to the skills library. Delete ${REPO_SKILLS_DIR}/${name}/.`,
        manifest,
        `This task explicitly allows changing ${REPO_SKILLS_DIR}/${name}/ and .gilde.json. The next skills sync brings the skill back as a managed skill.`,
    ].join('\n\n');
}
