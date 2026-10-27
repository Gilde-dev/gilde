import { Injectable, Logger } from '@nestjs/common';

import type { ScoutEvent } from './scout-signal.events.js';

/** Receives published events; implemented by the co-pilot's ScoutSignalService when the scout is on. */
export type ScoutEventSink = (projectId: string, event: ScoutEvent) => Promise<void>;

const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * The decoupled boundary between the event producers (jobs, features, lessons, feedback, notifications) and the
 * scout. It imports nothing from the domains, so producers can depend on it without a cycle through the co-pilot,
 * which depends on them. Without a registered sink (the scout is off) `publish` does nothing. It never throws and never
 * waits for longer than a few seconds: a failing or slow scout must not break the recording caller.
 */
@Injectable()
export class ScoutSignalPublisher {
    private readonly logger = new Logger('Verkenner');
    private sink: ScoutEventSink | null = null;

    register(sink: ScoutEventSink | null): void {
        this.sink = sink;
    }

    get active(): boolean {
        return this.sink !== null;
    }

    async publish(projectId: string, event: ScoutEvent): Promise<void> {
        const sink = this.sink;
        if (!sink) return;
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                sink(projectId, event),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), PUBLISH_TIMEOUT_MS); }),
            ]);
        } catch (error) {
            this.logger.warn(`Publishing ${event.type} to the scout failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
