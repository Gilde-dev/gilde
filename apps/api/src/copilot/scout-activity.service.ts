import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';

import { ProjectService } from '../project/project.service.js';
import type { UserService } from '../user/user.service.js';

import { utcDayOf, utcWeekStartDay } from './scout-suggestion.service.js';
import { ScoutSuggestion } from './scout-suggestion.entity.js';
import type { ScoutWakeReader } from './scout-wake.reader.js';

export const ScoutActivityQuerySchema = z.object({ projectId: z.string().uuid() });

export const ScoutActivityResponseSchema = z.object({
    projectId: z.string().uuid(),
    enabled: z.boolean(),
    model: z.string().nullable(),
    /** Id of the configured scout user when it resolves (also while the scout is off), for comparing with a job's creator. Never the bot's email. */
    scoutUserId: z.string().uuid().nullable(),
    /** Suggestions of this project since Monday 00:00 UTC of the current week. */
    suggestionsThisWeek: z.number().int(),
    /** The UTC day (`YYYY-MM-DD`) of that Monday. */
    weekStart: z.string(),
    /** The actual most recent wake of the scout in this project, or null if it never woke. */
    lastWakeAt: z.string().datetime().nullable(),
});
export type ScoutActivityDto = z.infer<typeof ScoutActivityResponseSchema>;

/** Read side of the scout's activity. Works while the scout is off, so history stays visible. */
@Injectable()
export class ScoutActivityService {
    constructor(
        @InjectRepository(ScoutSuggestion) private readonly suggestions: Repository<ScoutSuggestion>,
        private readonly wakes: Pick<ScoutWakeReader, 'lastWakeAt'>,
        private readonly projects: Pick<ProjectService, 'getById'>,
        private readonly users: Pick<UserService, 'findByEmail'>,
        private readonly scout: { enabled: boolean; model: string | null; userId: string | null },
        private readonly userEmail: () => string | undefined = () => process.env.SCOUT_USER_EMAIL,
        private readonly clock: () => Date = () => new Date(),
    ) { }

    /** Counts the project's whole history in the database, not any list the board loaded. 404 for an unknown project. */
    async get(projectId: string): Promise<ScoutActivityDto> {
        await this.projects.getById(projectId);
        const now = this.clock();
        const weekStart = utcWeekStartDay(now);
        const [suggestionsThisWeek, lastWake, scoutUserId] = await Promise.all([
            this.suggestions.createQueryBuilder('s')
                .where('s.projectId = :projectId AND s.day >= :weekStart AND s.day <= :today', { projectId, weekStart, today: utcDayOf(now) })
                .getCount(),
            this.wakes.lastWakeAt(projectId),
            this.resolveUserId(),
        ]);
        return { projectId, enabled: this.scout.enabled, model: this.scout.model, scoutUserId, suggestionsThisWeek, weekStart, lastWakeAt: lastWake?.toISOString() ?? null };
    }

    private async resolveUserId(): Promise<string | null> {
        if (this.scout.userId) return this.scout.userId;
        const email = this.userEmail()?.trim();
        if (!email) return null;
        try {
            return (await this.users.findByEmail(email))?.id ?? null;
        } catch {
            return null;
        }
    }
}
