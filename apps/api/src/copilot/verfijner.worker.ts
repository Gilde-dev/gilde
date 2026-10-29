import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Mastra } from '@mastra/core/mastra';

import type { BudgetService } from '../budget/budget.service.js';
import type { IntakeItem } from '../intake/intake-item.entity.js';
import { refineSha } from '../intake/intake-issue.js';
import type { IntakeCommentService } from '../intake/intake-comment.service.js';
import type { IntakeRefineService } from '../intake/intake-refine.service.js';

import type { RefineSetup } from './copilot.mastra.js';
import { REFINE_AGENT_ID } from './verfijner.config.js';
import { issueRefineBinding, refineOutcome, refineStreamOptions } from './verfijner.context.js';
import { refinePrompt } from './verfijner.instructions.js';

/** A run that takes longer than this is abandoned and counts as a failed attempt. */
const RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * Every minute: refines the next intake item of each project, one item at a time per project. An item is picked when it is
 * `new`, its body differs from the last refined one, the project is under its daily limit and neither the project's nor
 * the global budget is hard (an unreadable budget counts as hard). The run is bound to exactly that item by a binding
 * the server issues here; the agent can save a draft for it and nothing else. After a run the item is `drafted` when
 * the agent saved a spec, otherwise it goes back to `new` for a second attempt and is `failed` after two.
 */
export class VerfijnerWorker {
    private readonly logger = new Logger('Verfijner');
    private running = false;

    constructor(
        private readonly setup: RefineSetup,
        private readonly mastra: Pick<Mastra, 'getAgent'>,
        private readonly refine: IntakeRefineService,
        private readonly budget: Pick<BudgetService, 'status'>,
        private readonly comments?: Pick<IntakeCommentService, 'sync'>,
    ) { }

    @Cron('0 * * * * *')
    async scheduled(): Promise<void> {
        try {
            await this.tick();
        } catch (error) {
            this.logger.error(`Verfijner tick failed: ${message(error)}`);
        }
    }

    /** One pass over all projects; an overlapping pass returns at once. Returns the ids of the items it ran. */
    async tick(now: Date = new Date()): Promise<string[]> {
        if (this.running) return [];
        this.running = true;
        const ran: string[] = [];
        try {
            for (const candidate of await this.refine.nextPerProject()) {
                if (!(await this.allowed(candidate.projectId, now))) continue;
                const item = await this.refine.begin(candidate);
                if (!item) continue; // edited, ignored or taken in the meantime
                ran.push(item.id);
                await this.run(item);
            }
        } finally {
            this.running = false;
        }
        return ran;
    }

    private async allowed(projectId: string, now: Date): Promise<boolean> {
        if ((await this.refine.runsToday(projectId, now)) >= this.setup.config.dailyLimit) return false;
        try {
            return !(await this.budget.status(projectId)).hardBlocked;
        } catch (error) {
            this.logger.warn(`Budget of project ${projectId} could not be read, not refining: ${message(error)}`);
            return false;
        }
    }

    private async run(item: IntakeItem): Promise<void> {
        const binding = issueRefineBinding(this.setup.user.id, item, item.refineAttempts);
        try {
            const prompt = refinePrompt({
                repoFullName: item.repo?.fullName ?? item.repoId, number: item.number, url: item.url, title: item.title,
                body: item.body, bodyTruncated: item.bodyTruncated, specId: item.specId, comments: item.comments ?? [],
            }, randomBytes(8).toString('hex'));
            const output = await this.mastra.getAgent(REFINE_AGENT_ID).stream(prompt, {
                ...refineStreamOptions(this.setup.user, binding),
                abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
            } as never);
            await (output as { consumeStream(): Promise<void> }).consumeStream();
            if (refineOutcome(binding).saves === 0) throw new Error('The agent finished without saving a spec');
            if (!(await this.refine.drafted(item.id, refineSha(item)))) this.logger.log(`Item ${item.id} changed during its refine run; it stays as it is.`);
        } catch (error) {
            const status = await this.refine.failed(item.id, message(error));
            this.logger.warn(`Refining item ${item.id} failed (${status ?? 'item changed'}): ${message(error)}`);
        }
        await this.comments?.sync(item.id); // never throws: a comment problem is recorded on the item
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
