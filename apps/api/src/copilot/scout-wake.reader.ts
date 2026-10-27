import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ScoutWakeDay } from './scout-wake-day.entity.js';

/**
 * Read side of the wake bookkeeping, available whether the scout is on or off (history stays visible while off).
 * Returns timestamps only, never inbox contents.
 */
@Injectable()
export class ScoutWakeReader {
    constructor(@InjectRepository(ScoutWakeDay) private readonly days: Repository<ScoutWakeDay>) { }

    /** The actual most recent wake of the project (immediate wake or summary), or null if it never woke. */
    async lastWakeAt(projectId: string): Promise<Date | null> {
        const rows = await this.days.find({ where: { projectId } });
        return rows.map((r) => r.lastWakeAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    }
}
