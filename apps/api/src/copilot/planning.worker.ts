import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import type { AgentRunRecorder } from '../agent-run/agent-run.recorder.js';
import type { BudgetService } from '../budget/budget.service.js';
import type { NotificationCaptureService } from '../notification/notification-capture.service.js';
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
    /** The setup of the pass in progress: read again at the start of every tick. */
    private setup: PlanSetup;
    private readonly source: () => Promise<PlanSetup | null>;

    /**
     * `setup` is read on each tick when it is a function (null: the Werkmeester is not on, queued runs wait), so a changed
     * setting or a newly created bot user needs no restart. A plain setup is used as it is.
     */
    constructor(
        setup: PlanSetup | (() => Promise<PlanSetup | null>),
        private readonly werkmeester: Pick<WerkmeesterService, 'bind' | 'plan'>,
        private readonly planning: SpecPlanningService,
        private readonly budget: Pick<BudgetService, 'status'>,
        private readonly notifications?: Pick<NotificationCaptureService, 'specPlanned' | 'specPlanFailed'>,
        private readonly runLog?: Pick<AgentRunRecorder, 'begin'>,
    ) {
        this.source = typeof setup === 'function' ? setup : async () => setup;
        this.setup = typeof setup === 'function' ? (undefined as never) : setup;
    }

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
            const setup = await this.source();
            if (!setup) return ran;
            this.setup = setup;
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

    /** The run log entry of this planning run. Best effort: a problem here never touches the planning. */
    private startLog(run: SpecPlanningRun) {
        try {
            return this.runLog?.begin({
                agentId: 'werkmeester', triggerKind: 'spec_version', triggerRefType: 'spec', triggerRefId: run.specId, actorUserId: this.setup.user.id,
                projectId: run.projectId, model: this.setup.config.model, linkedTable: 'spec_planning_runs', linkedId: run.id, managed: true,
            });
        } catch {
            return undefined;
        }
    }

    private async run(run: SpecPlanningRun): Promise<void> {
        const log = this.startLog(run);
        try {
            const pinned = await this.planning.pinnedFeature(run.specId, run.version);
            if (pinned) {
                await this.planning.skipped(run.id, `Version ${run.version} is already planned: feature "${pinned.title}" is pinned to it`, pinned.id);
                log?.end({ outcome: 'skipped', reason: `Version ${run.version} is already planned` });
                return;
            }
            const binding = await this.werkmeester.bind({ projectId: run.projectId, specId: run.specId, version: run.version, approvalId: run.approvalId }, run.attempts);
            const result = await this.werkmeester.plan(binding, log);
            if (result.outcome === 'planned') {
                if (await this.planning.planned(run.id, result.featureId)) await this.notifications?.specPlanned(run, result.featureId);
                log?.end({ outcome: 'ok' });
            }
            else if (result.outcome === 'skipped') {
                await this.planning.skipped(run.id, result.reason);
                log?.end({ outcome: 'skipped', reason: result.reason });
            }
            else {
                await this.finishFailed(run, result.reason);
                log?.end({ outcome: 'error', reason: result.reason });
            }
        } catch (error) {
            log?.end({ outcome: 'error', reason: message(error) });
            await this.finishFailed(run, message(error));
        }
    }

    private async finishFailed(run: SpecPlanningRun, reason: string): Promise<void> {
        const status = await this.planning.failed(run.id, reason);
        this.logger.warn(`Planning spec ${run.specId} v${run.version} failed (${status ?? 'run changed'}): ${reason}`);
        if (status === 'failed') await this.notifications?.specPlanFailed(run, await this.planning.specTitle(run.specId).catch(() => run.specId), run.version, reason);
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
