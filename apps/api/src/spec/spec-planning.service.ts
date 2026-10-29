import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';

import { Feature } from '../feature/feature.entity.js';
import { Spec } from './spec.entity.js';

import { OPEN_PLANNING_STATUSES, SpecPlanningRun } from './spec-planning-run.entity.js';

/** A planning run fails this many times before it is `failed`. */
export const MAX_PLAN_ATTEMPTS = 2;
/** A `running` run untouched this long belongs to a process that died; it counts as a failed attempt. */
const STALE_RUNNING_MS = 15 * 60_000;
const MAX_REASON_LENGTH = 500;

const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);

/**
 * The state side of planning, without any agent: which run is next, the daily count and the transitions
 * queued → running → planned | skipped | queued (retry) | failed. Every transition is conditional on the status it
 * expects, so a run that someone else finished is not overwritten. Internal: it returns entities.
 */
@Injectable()
export class SpecPlanningService {
    constructor(
        @InjectRepository(SpecPlanningRun) private readonly runs: Repository<SpecPlanningRun>,
        @InjectRepository(Feature) private readonly features: Repository<Feature>,
    ) { }

    /** The oldest queued run per project, for projects that have no run `running`. */
    async nextPerProject(): Promise<SpecPlanningRun[]> {
        const queued = await this.runs.find({ where: { status: 'queued' }, order: { createdAt: 'ASC', id: 'ASC' } });
        if (!queued.length) return [];
        const busy = new Set((await this.runs.find({ where: { status: 'running' }, select: { id: true, projectId: true } })).map((r) => r.projectId));
        const next = new Map<string, SpecPlanningRun>();
        for (const run of queued) if (!busy.has(run.projectId) && !next.has(run.projectId)) next.set(run.projectId, run);
        return [...next.values()];
    }

    runsToday(projectId: string, now: Date = new Date()): Promise<number> {
        return this.runs.countBy({ projectId, startedAt: MoreThanOrEqual(utcDayStart(now)) });
    }

    /** Moves a `queued` run to `running` and counts the attempt. Null when another worker got there first. */
    async begin(run: SpecPlanningRun, now: Date = new Date()): Promise<SpecPlanningRun | null> {
        const claimed = await this.runs.update({ id: run.id, status: 'queued' }, { status: 'running', attempts: run.attempts + 1, startedAt: now });
        if (!claimed.affected) return null;
        return this.runs.findOneBy({ id: run.id });
    }

    /** The feature already pinned to this exact version, if any. */
    pinnedFeature(specId: string, version: number): Promise<Pick<Feature, 'id' | 'title'> | null> {
        return this.features.findOne({ where: { specId, specVersion: version }, select: { id: true, title: true } });
    }

    async planned(id: string, featureId: string): Promise<boolean> {
        const done = await this.runs.update({ id, status: 'running' }, { status: 'planned', featureId, reason: null });
        return !!done.affected;
    }

    async skipped(id: string, reason: string, featureId: string | null = null): Promise<boolean> {
        const done = await this.runs.update({ id, status: 'running' }, { status: 'skipped', reason: short(reason), featureId });
        return !!done.affected;
    }

    /** A failed attempt: back to `queued` for another try, `failed` once the attempts are used up. */
    async failed(id: string, reason: string): Promise<'queued' | 'failed' | null> {
        const run = await this.runs.findOneBy({ id });
        if (!run || run.status !== 'running') return null;
        const status = run.attempts >= MAX_PLAN_ATTEMPTS ? 'failed' : 'queued';
        const done = await this.runs.update({ id, status: 'running' }, { status, reason: short(reason) });
        return done.affected ? status : null;
    }

    /** Runs left `running` by a process that died count as failed attempts. Returns how many. */
    async recoverStale(now: Date = new Date()): Promise<number> {
        const stale = await this.runs.find({ where: { status: 'running', updatedAt: LessThan(new Date(now.getTime() - STALE_RUNNING_MS)) } });
        let recovered = 0;
        for (const run of stale) if (await this.failed(run.id, 'The planning run did not finish')) recovered++;
        return recovered;
    }

    /** The title of the planned spec, for notifications; the id when the spec is gone. */
    async specTitle(specId: string): Promise<string> {
        return (await this.runs.manager.findOne(Spec, { where: { id: specId }, select: { id: true, title: true } }))?.title ?? specId;
    }

    openRuns(specId: string): Promise<SpecPlanningRun[]> {
        return this.runs.find({ where: { specId, status: In(OPEN_PLANNING_STATUSES) } });
    }
}
