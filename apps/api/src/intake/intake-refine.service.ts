import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';

import { IntakeItem } from './intake-item.entity.js';
import { refineSha } from './intake-issue.js';
import { IntakeRefineRun } from './intake-refine-run.entity.js';

/** A refine run fails this many times before the item is `failed`. */
export const MAX_REFINE_ATTEMPTS = 2;
const MAX_ERROR_LENGTH = 500;

const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * The state side of refining, without any agent: which item is next, the daily count, and the transitions
 * new → refining → drafted | new (retry) | failed. Every transition is conditional on the status it expects, so an item
 * that was edited, withdrawn or ignored while the agent ran is not overwritten. Internal: it returns entities.
 */
@Injectable()
export class IntakeRefineService {
    constructor(
        @InjectRepository(IntakeItem) private readonly items: Repository<IntakeItem>,
        @InjectRepository(IntakeRefineRun) private readonly runs: Repository<IntakeRefineRun>,
    ) { }

    async get(id: string): Promise<IntakeItem | null> {
        return this.items.findOne({ where: { id }, relations: { repo: true } });
    }

    /**
     * The next item to refine per project, oldest first: status `new`, its body differs from what was last refined, and the
     * project has no item `refining`. One entry per project at most.
     */
    async nextPerProject(): Promise<IntakeItem[]> {
        const waiting = await this.items.find({ where: { status: 'new' }, order: { createdAt: 'ASC', id: 'ASC' }, relations: { repo: true } });
        const busy = new Set((await this.items.find({ where: { status: 'refining' }, select: { id: true, projectId: true } })).map((i) => i.projectId));
        const next = new Map<string, IntakeItem>();
        for (const item of waiting) {
            if (item.archivedAt || busy.has(item.projectId) || next.has(item.projectId)) continue;
            if (item.refinedSha256 === refineSha(item)) continue;
            next.set(item.projectId, item);
        }
        return [...next.values()];
    }

    runsToday(projectId: string, now: Date = new Date()): Promise<number> {
        return this.runs.countBy({ projectId, startedAt: MoreThanOrEqual(utcDayStart(now)) });
    }

    /**
     * Moves a `new` item to `refining`, counts the attempt and the daily run. Null when another worker or an edit got
     * there first (the item is no longer `new`).
     */
    async begin(item: IntakeItem): Promise<IntakeItem | null> {
        const claimed = await this.items.update({ id: item.id, status: 'new' }, { status: 'refining', refineAttempts: item.refineAttempts + 1 });
        if (!claimed.affected) return null;
        await this.runs.insert({ projectId: item.projectId, itemId: item.id });
        return this.get(item.id);
    }

    /** The newest refine run row of an item (the one `begin` just wrote), for the agent run log. */
    async latestRunId(itemId: string): Promise<string | null> {
        const run = await this.runs.findOne({ where: { itemId }, order: { startedAt: 'DESC' } });
        return run?.id ?? null;
    }

    /** The draft was saved: `drafted`, remembering the body it was made from. No-op when the item changed meanwhile. */
    async drafted(id: string, sha: string): Promise<boolean> {
        const done = await this.items.update({ id, status: 'refining' }, { status: 'drafted', refinedSha256: sha, lastError: null });
        return !!done.affected;
    }

    /** A failed attempt: back to `new` for another try, `failed` once the attempts are used up. */
    async failed(id: string, error: string): Promise<'new' | 'failed' | null> {
        const item = await this.items.findOneBy({ id });
        if (!item || item.status !== 'refining') return null;
        const status = item.refineAttempts >= MAX_REFINE_ATTEMPTS ? 'failed' : 'new';
        const done = await this.items.update({ id, status: 'refining' }, { status, lastError: error.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH) });
        return done.affected ? status : null;
    }

    /** Links the item to the spec made for it. Only an item without a spec gets one. */
    async linkSpec(id: string, specId: string): Promise<boolean> {
        const done = await this.items.createQueryBuilder().update(IntakeItem).set({ specId }).where('id = :id AND spec_id IS NULL', { id }).execute();
        return !!done.affected;
    }
}
