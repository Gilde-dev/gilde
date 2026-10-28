import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { ScoutActivityDto } from './copilot.dto.js';
import { ProjectService } from '../project/project.service.js';
import type { UserService } from '../user/user.service.js';

import { utcDayOf, utcWeekStartDay } from './scout-suggestion.service.js';
import { ScoutSuggestion } from './scout-suggestion.entity.js';
import type { ScoutWakeReader } from './scout-wake.reader.js';


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
