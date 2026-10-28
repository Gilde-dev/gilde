import { ConflictException, HttpException } from '@nestjs/common';

import type { IntakeRefineService } from '../intake/intake-refine.service.js';
import type { SpecService } from '../spec/spec.service.js';
import { parseSpec } from '../spec/spec-parser.js';

import type { CopilotUser } from './copilot.context.js';
import { refineOutcome, type RefineBinding } from './verfijner.context.js';

export type SaveRefinedSpecResult =
    | { saved: true; specId: string; version: number; created: boolean; status: 'draft' }
    | { saved: false; errors: string[] };

/** kebab-case slug, at most 64 characters: `issue-<number>-<title words>`. */
export function refineSlug(number: number, title: string, suffix = ''): string {
    const words = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const tail = suffix ? `-${suffix}` : '';
    const head = `issue-${number}${words ? `-${words}` : ''}`.slice(0, 64 - tail.length).replace(/-+$/, '');
    return `${head}${tail}`;
}

const MAX_SLUG_TRIES = 20;

/**
 * The Verfijner's only write. The item, project and repo come from the server-issued binding, never from the tool input:
 * the input is just a title and a body. It creates the spec of the item, or adds a draft version to the spec the item is
 * already linked to, through SpecService as the bot user. Nothing here can approve, plan or queue.
 */
export class RefinedSpecWriter {
    constructor(
        private readonly specs: Pick<SpecService, 'create' | 'saveVersion' | 'getDetail'>,
        private readonly refine: Pick<IntakeRefineService, 'get' | 'linkSpec'>,
        private readonly actor: Pick<CopilotUser, 'id'>,
    ) { }

    async save(binding: RefineBinding, input: { title: string; body: string }): Promise<SaveRefinedSpecResult> {
        const item = await this.refine.get(binding.itemId);
        if (!item || item.projectId !== binding.projectId || item.repoId !== binding.repoId) return { saved: false, errors: ['The intake item of this run no longer exists.'] };
        if (item.status !== 'refining') return { saved: false, errors: [`The intake item is ${item.status}, not being refined any more; stop.`] };

        const errors = parseSpec(input.body).issues.map((i) => (i.line === null ? i.message : `line ${i.line}: ${i.message}`));
        if (!input.body.includes(item.url)) errors.push(`The Context section must contain the issue URL ${item.url}`);
        if (errors.length) return { saved: false, errors };

        try {
            const result = item.specId ? await this.addVersion(item.specId, input) : await this.create(binding, item, input);
            refineOutcome(binding).saves++;
            return result;
        } catch (e) {
            if (e instanceof HttpException && e.getStatus() < 500) return { saved: false, errors: httpErrors(e) };
            throw e;
        }
    }

    private async addVersion(specId: string, input: { title: string; body: string }): Promise<SaveRefinedSpecResult> {
        const current = await this.specs.getDetail(specId, null);
        const detail = await this.specs.saveVersion(specId, { title: input.title, body: input.body, expectedVersion: current.currentVersion }, this.actor);
        return { saved: true, specId: detail.id, version: detail.currentVersion, created: false, status: 'draft' };
    }

    private async create(binding: RefineBinding, item: { id: string; number: number }, input: { title: string; body: string }): Promise<SaveRefinedSpecResult> {
        for (let n = 1; n <= MAX_SLUG_TRIES; n++) {
            try {
                const detail = await this.specs.create(binding.projectId, {
                    repoId: binding.repoId, slug: refineSlug(item.number, input.title, n === 1 ? '' : String(n)), title: input.title, body: input.body, expectedVersion: 0,
                }, this.actor);
                await this.refine.linkSpec(item.id, detail.id);
                return { saved: true, specId: detail.id, version: detail.currentVersion, created: true, status: 'draft' };
            } catch (e) {
                if (!(e instanceof ConflictException)) throw e; // a taken slug: try the next one
            }
        }
        return { saved: false, errors: ['No free slug for this spec in the repo.'] };
    }
}

function httpErrors(e: HttpException): string[] {
    const response = e.getResponse();
    if (typeof response === 'object' && response !== null) {
        const { message, issues } = response as { message?: unknown; issues?: { message?: string }[] };
        const lines = (issues ?? []).flatMap((i) => (i.message ? [i.message] : []));
        if (lines.length) return lines;
        if (typeof message === 'string') return [message];
    }
    return [e.message];
}
