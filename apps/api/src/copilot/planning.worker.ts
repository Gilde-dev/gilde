import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import type { BudgetService } from '../budget/budget.service.js';
import type { SpecPlanningRun } from '../spec/spec-planning-run.entity.js';
import type { SpecPlanningService } from '../spec/spec-planning.service.js';

import type { PlanSetup } from './copilot.mastra.js';
import type { WerkmeesterService } from './werkmeester.service.js';

/**
 * Every minute: runs the next queued planning run of each project, one run at a time per project. A run is picked when the
 * project is under its daily limit and neither the project's nor the global budget is hard (an unreadable budget counts as
 * hard). A version that already has a pinned feature is skipped without calling the agent. After a run it is `planned`,
 * `skipped`, back to `queued` for a second attempt, or `failed` after two.
 */
export class PlanningWorker {
    private readonly logger = new Logger('Werkmeester');
    private running = false;

    constructor(
        private readonly setup: PlanSetup,
        private readonly werkmeester: Pick<WerkmeesterService, 'bind' | 'plan'>,
        private readonly planning: SpecPlanningService,
        private readonly budget: Pick<BudgetService, 'status'>,
    ) { }

    @Cron('0 * * * * *')
    async scheduled(): Promise<void> {
        try {
            await this.tick();
        } catch (error) {
            this.logger.error(`Planning tick failed: ${message(error)}`);
        }
    }

    /** One pass over all projects; an overlapping pass returns at once. Returns the ids of the runs it started. */
    async tick(now: Date = new Date()): Promise<string[]> {
        if (this.running) return [];
        this.running = true;
        const ran: string[] = [];
        try {
            await this.planning.recoverStale(now);
            for (const candidate of await this.planning.nextPerProject()) {
                if (!(await this.allowed(candidate.projectId, now))) continue;
                const run = await this.planning.begin(candidate, now);
                if (!run) continue;
                ran.push(run.id);
                await this.run(run);
            }
        } finally {
            this.running = false;
        }
        return ran;
    }

    private async allowed(projectId: string, now: Date): Promise<boolean> {
        if ((await this.planning.runsToday(projectId, now)) >= this.setup.config.dailyLimit) return false;
        try {
            return !(await this.budget.status(projectId)).hardBlocked;
        } catch (error) {
            this.logger.warn(`Budget of project ${projectId} could not be read, not planning: ${message(error)}`);
            return false;
        }
    }

    private async run(run: SpecPlanningRun): Promise<void> {
        try {
            const pinned = await this.planning.pinnedFeature(run.specId, run.version);
            if (pinned) {
                await this.planning.skipped(run.id, `Version ${run.version} is already planned: feature "${pinned.title}" is pinned to it`, pinned.id);
                return;
            }
            const binding = this.werkmeester.bind({ projectId: run.projectId, specId: run.specId, version: run.version, approvalId: run.approvalId }, run.attempts);
            const result = await this.werkmeester.plan(binding);
            if (result.outcome === 'planned') await this.planning.planned(run.id, result.featureId);
            else if (result.outcome === 'skipped') await this.planning.skipped(run.id, result.reason);
            else await this.finishFailed(run, result.reason);
        } catch (error) {
            await this.finishFailed(run, message(error));
        }
    }

    private async finishFailed(run: SpecPlanningRun, reason: string): Promise<void> {
        const status = await this.planning.failed(run.id, reason);
        this.logger.warn(`Planning spec ${run.specId} v${run.version} failed (${status ?? 'run changed'}): ${reason}`);
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
