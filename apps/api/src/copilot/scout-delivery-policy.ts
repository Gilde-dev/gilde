import { Logger } from '@nestjs/common';
import { defaultNotificationDeliveryDecision, type NotificationDeliveryPolicyDecider } from '@mastra/core/notifications';

import type { CopilotUser } from './copilot.context.js';
import { SCOUT_SIGNAL_SOURCE } from './scout-signal.envelope.js';
import { scoutProjectOfThread, scoutStreamOptions } from './verkenner.context.js';

/**
 * What the scout's delivery policy needs from the signal service. It is bound after the Mastra instance exists (the
 * service needs the instance, the instance needs the policy); until then, and when the scout is off, nothing is allowed
 * to wake the agent.
 */
export interface ScoutDispatchHooks {
    /** The service clock; the same clock that dates the budgets. */
    now(): Date;
    /** First summary moment after `now`. */
    summaryAt(now: Date): Date;
    /** Claims the project's daily summary and sends the board state before it; false keeps the records pending. */
    allowSummary(projectId: string): Promise<boolean>;
}

export class ScoutDispatchGate {
    private hooks: ScoutDispatchHooks | null = null;

    bind(hooks: ScoutDispatchHooks | null): void {
        this.hooks = hooks;
    }

    get bound(): ScoutDispatchHooks | null {
        return this.hooks;
    }
}

const logger = new Logger('Verkenner');

/**
 * Native delivery policy of the scout. Nothing wakes the model except what the application's durable budget allowed:
 *
 * - A record sent with `metadata.wake = 'granted'` (a high event whose wake was claimed) is delivered at once.
 * - Everything else (medium, low, high over budget) is scheduled for the next summary moment and stays pending.
 * - When the dispatcher finds such a record due, the policy claims the project's one daily summary (and its wake, from the
 *   same daily cap) and sends the board state first; if the claim is refused (before the summary hour, already sent today,
 *   cap spent) the record is `hold`en, i.e. stays pending without a delivery attempt.
 *
 * Every decision carries the server-issued project binding as stream options, so a deferred run still knows its project.
 */
export function scoutDeliveryDecider(user: CopilotUser, gate: ScoutDispatchGate): NotificationDeliveryPolicyDecider {
    return async (input) => {
        const { record } = input;
        const projectId = scoutProjectOfThread(record.threadId);
        if (!projectId) return undefined;
        // A live view of the bot user has no id while the scout is off (or has no valid bot user): nothing is delivered then.
        if (!user.id) return { action: 'persist', hold: true, reason: 'the scout is off' };
        const streamOptions = scoutStreamOptions(user, projectId) as never;
        const hooks = gate.bound;

        if (record.source !== SCOUT_SIGNAL_SOURCE) return { ...defaultNotificationDeliveryDecision(input), streamOptions };
        if (record.metadata?.wake === 'granted') return { action: 'deliver', streamOptions, reason: 'wake within the daily budget' };
        if (!hooks) return { action: 'persist', streamOptions, hold: true, reason: 'scout signals are not bound' };

        const now = hooks.now();
        const due = record.summaryAt !== undefined && record.summaryAt.getTime() <= now.getTime();
        if (!due) return { action: 'summarize', summaryAt: hooks.summaryAt(now), streamOptions, reason: 'daily summary' };

        // Dispatch time for a record whose summary moment has come.
        let allowed = false;
        try {
            allowed = await hooks.allowSummary(projectId);
        } catch (error) {
            logger.warn(`Summary claim for project ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { action: 'summarize', summaryAt: record.summaryAt, streamOptions, hold: !allowed, reason: allowed ? 'daily summary' : 'summary not allowed now' };
    };
}
