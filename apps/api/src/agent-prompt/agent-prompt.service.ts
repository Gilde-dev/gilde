import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AgentSettingsService } from '../agent/agent-settings.service.js';
import { isAgentId, type AgentId } from '../agent/agent-ids.js';
import { copilotInstructions } from '../copilot/copilot.instructions.js';
import { RepoContextService } from '../copilot/repo-context.service.js';
import { refinePrompt, VERFIJNER_INSTRUCTIONS } from '../copilot/verfijner.instructions.js';
import { VERKENNER_INSTRUCTIONS } from '../copilot/verkenner.instructions.js';
import { planPrompt, WERKMEESTER_INSTRUCTIONS } from '../copilot/werkmeester.instructions.js';
import { AgentInstructionsService } from '../execution/agent-instructions.service.js';
import { ExecutionError } from '../execution/execution.error.js';
import { describePromptAssembly } from '../execution/job-prompt.js';
import { ProjectService } from '../project/project.service.js';

import type { AgentPromptDto } from './agent-prompt.dto.js';

/** The repository the prompt files are linked in. */
const DEFAULT_SOURCE_REPO = 'Gilde-dev/gilde';
const DEFAULT_BRANCH = 'main';

/** Environment variables that may hold the commit of the running build, in the order they are tried. */
export const COMMIT_ENV_VARS = ['GILDE_COMMIT_SHA', 'SOURCE_COMMIT', 'GIT_COMMIT_SHA', 'GITHUB_SHA'] as const;

/** The source file of each agent's instructions. */
export const PROMPT_SOURCE_FILES: Partial<Record<AgentId, string>> = {
    gilde: 'apps/api/src/copilot/copilot.instructions.ts',
    verkenner: 'apps/api/src/copilot/verkenner.instructions.ts',
    verfijner: 'apps/api/src/copilot/verfijner.instructions.ts',
    werkmeester: 'apps/api/src/copilot/werkmeester.instructions.ts',
};
const CODING_FILE = 'docs/agent-instructions.md';

/** The example binding of the unattended agents' run prompts. */
const EXAMPLE_ITEM = {
    repoFullName: 'example-org/example-repo', number: 123, url: 'https://github.com/example-org/example-repo/issues/123',
    title: 'Example issue title', body: 'Example issue body.', bodyTruncated: false, specId: null,
};
const EXAMPLE_SPEC = {
    slug: 'example-spec', title: 'Example spec', version: 1, body: '## Goal\nExample goal.',
    criteria: [{ id: 'AC-1', text: 'Example acceptance criterion.' }],
    repos: [{ id: '00000000-0000-0000-0000-000000000000', fullName: 'example-org/example-repo', isSpecRepo: true, stacks: ['nestjs'], testCommands: ['pnpm test'] }],
};
const EXAMPLE_NONCE = 'EXAMPLE-NONCE';

const text = (label: string, value: string) => ({
    label,
    text: value,
    version: createHash('sha256').update(value).digest('hex').slice(0, 12),
    length: value.length,
});

/**
 * What each agent receives as instructions, rendered by the same functions the agents are built with. Read-only: prompts live
 * in code (ADR 0017), nothing here or elsewhere changes one.
 */
@Injectable()
export class AgentPromptService {
    constructor(
        private readonly agentSettings: AgentSettingsService,
        private readonly projects: ProjectService,
        private readonly instructions: AgentInstructionsService,
        @Optional() private readonly repoContext?: RepoContextService,
    ) { }

    async get(rawId: string, projectId?: string): Promise<AgentPromptDto> {
        if (rawId === 'slack') {
            return this.none('slack', 'The Slack bot has no prompt of its own. Chat messages are answered by the co-pilot (see its Prompt); notifications are formatted without an LLM.');
        }
        if (!isAgentId(rawId)) throw new NotFoundException(`Unknown agent ${rawId}`);
        const id = rawId;
        const settings = (await this.agentSettings.get(id)).settings;
        switch (id) {
            case 'gilde': return this.copilot(settings, projectId);
            case 'verkenner':
                return this.llm(id, settings, text('Instructions', VERKENNER_INSTRUCTIONS), null, null,
                    'The scout is woken by notifications; its run message is the notification of the thread, so it has no further prompt. Its project is bound by the server.');
            case 'verfijner':
                return this.llm(id, settings, text('Instructions', VERFIJNER_INSTRUCTIONS), text('Run prompt', refinePrompt(EXAMPLE_ITEM, EXAMPLE_NONCE)),
                    'Example binding: a made-up intake item. A real run uses the labelled GitHub issue and a random nonce for the boundary lines.', null);
            case 'werkmeester':
                return this.llm(id, settings, text('Instructions', WERKMEESTER_INSTRUCTIONS), text('Run prompt', planPrompt(EXAMPLE_SPEC, EXAMPLE_NONCE)),
                    'Example binding: a made-up approved spec version. A real run uses the spec version of the queued planning run and a random nonce for the boundary lines.', null);
            case 'mcp':
                return this.none(id, 'The MCP server has no LLM and no prompt: operators\' own clients call its tools. See Tools for the tool descriptions.');
            case 'coding':
                return this.coding(settings);
        }
    }

    private async copilot(settings: AgentPromptDto['settings'], projectId?: string): Promise<AgentPromptDto> {
        const project = projectId ? { id: projectId } : (await this.projects.list())[0];
        const reference = project && this.repoContext ? await this.repoContext.build(project.id) : '';
        const binding = reference
            ? `Example binding: the repo reference material of ${projectId ? 'the chosen project' : 'the first project'}, which a run gets for the project selected in the page.`
            : 'Example binding: no project selected or no repos; a run gets repo reference material appended for the selected project.';
        return this.llm('gilde', settings, text('Instructions', copilotInstructions(reference)), null, binding, null);
    }

    private llm(id: AgentId, settings: AgentPromptDto['settings'], instructions: AgentPromptDto['instructions'], runPrompt: AgentPromptDto['runPrompt'], exampleBinding: string | null, note: string | null): AgentPromptDto {
        return { agent: id, kind: 'instructions', exampleBinding, instructions, runPrompt, file: this.file(PROMPT_SOURCE_FILES[id]!), settings, coding: null, note };
    }

    private none(agent: string, note: string): AgentPromptDto {
        return { agent, kind: 'none', exampleBinding: null, instructions: null, runPrompt: null, file: null, settings: {}, coding: null, note };
    }

    private coding(settings: AgentPromptDto['settings']): AgentPromptDto {
        const configured = process.env.AGENT_INSTRUCTIONS_PATH ?? null;
        let loaded: AgentPromptDto['instructions'] = null;
        let loadError: string | null = null;
        try {
            const value = this.instructions.get();
            if (value.text !== null) loaded = { label: 'Instructions', text: value.text, version: value.version ?? text('', value.text).version, length: value.text.length };
        } catch (e) {
            loadError = e instanceof ExecutionError ? e.message : 'The instructions file could not be loaded';
        }
        const assembly = describePromptAssembly();
        return {
            agent: 'coding', kind: 'instructions', exampleBinding: null, instructions: loaded, runPrompt: null,
            // Only a file called docs/agent-instructions.md is linked: any other path is not a file of this repository.
            file: configured && resolve(configured).endsWith(`/${CODING_FILE}`) ? this.file(CODING_FILE) : null,
            settings,
            coding: { instructionsPath: configured, loadError, limit: assembly.limit, layout: assembly.layout, payloadKeys: assembly.payloadKeys, limits: assembly.limits, trimmingOrder: assembly.trimmingOrder },
            note: 'Every job run gets these instructions followed by the job payload. The routine itself is configured per executor; Gilde sends only this text.',
        };
    }

    private file(path: string): NonNullable<AgentPromptDto['file']> {
        const repo = process.env.GILDE_SOURCE_REPO || DEFAULT_SOURCE_REPO;
        const name = COMMIT_ENV_VARS.find((n) => /^[0-9a-f]{7,64}$/i.test(process.env[n] ?? ''));
        const ref = name ? process.env[name]! : DEFAULT_BRANCH;
        return {
            path,
            url: `https://github.com/${repo}/blob/${ref}/${path}`,
            ref,
            refKind: name ? 'commit' : 'branch',
            refSource: name
                ? `the commit of the running build, from ${name}`
                : `the branch ${DEFAULT_BRANCH}: the build's commit is unknown (set ${COMMIT_ENV_VARS[0]}, the image takes it from the GILDE_COMMIT_SHA build argument)`,
        };
    }
}
