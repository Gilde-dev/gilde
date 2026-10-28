import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobService } from '../job/job.service.js';
import type { ProjectService } from '../project/project.service.js';
import type { SkillLibraryResolver } from '../skill/skill-library.resolver.js';
import { Lesson } from './lesson.entity.js';
import { LessonMapper } from './lesson.mapper.js';
import { LessonService, RETRO_REJECT_NOTE } from './lesson.service.js';
import { LessonSource, type LessonSourceKind } from './lesson-source.entity.js';
import type { LessonStatus } from './lesson-state.js';
import { J1, P1, memoryDb } from './lesson.fixture.js';
import { Job } from '../job/job.entity.js';
import { Repo } from '../repo/repo.entity.js';

let ds: DataSource;
let service: LessonService;
let n = 0;

beforeEach(async () => {
    ds = await memoryDb();
    service = new LessonService(
        new LessonMapper(), ds.getRepository(Lesson), ds.getRepository(LessonSource), ds.getRepository(Job), ds.getRepository(Repo),
        {} as JobService, {} as ProjectService, {} as SkillLibraryResolver,
    );
});
afterEach(() => ds.destroy());

async function lesson(status: LessonStatus, kinds: LessonSourceKind[]): Promise<string> {
    const l = await ds.getRepository(Lesson).save({ projectId: P1, text: 't', status });
    for (const kind of kinds) {
        await ds.getRepository(LessonSource).save({ lessonId: l.id, sourceKey: `${kind}:${++n}`, kind, jobId: J1, excerpt: 'e' });
    }
    return l.id;
}
const get = (id: string) => ds.getRepository(Lesson).findOneByOrFail({ id });

describe('LessonService.rejectRetroCandidates', () => {
    it('rejects retro-only candidates with the note and leaves everything else alone', async () => {
        const retro = await lesson('candidate', ['retro']);
        const retros = await lesson('candidate', ['retro', 'retro']);
        const mixed = await lesson('candidate', ['retro', 'suggested_lesson']);
        const fb = await lesson('candidate', ['feedback']);
        const approved = await lesson('approved', ['retro']);
        const applying = await lesson('applying', ['retro']);
        const applied = await lesson('applied', ['retro']);
        const rejected = await lesson('rejected', ['retro']);

        expect((await service.rejectRetroCandidates(false)).sort()).toEqual([retro, retros].sort());

        for (const id of [retro, retros]) expect(await get(id)).toMatchObject({ status: 'rejected', note: RETRO_REJECT_NOTE });
        expect((await get(mixed)).status).toBe('candidate');
        expect((await get(fb)).status).toBe('candidate');
        expect((await get(approved)).status).toBe('approved');
        expect((await get(applying)).status).toBe('applying');
        expect((await get(applied)).status).toBe('applied');
        expect(await get(rejected)).toMatchObject({ status: 'rejected', note: null });
    });

    it('is idempotent', async () => {
        await lesson('candidate', ['retro']);
        expect(await service.rejectRetroCandidates(false)).toHaveLength(1);
        expect(await service.rejectRetroCandidates(false)).toEqual([]);
    });

    it('writes nothing on a dry run', async () => {
        const id = await lesson('candidate', ['retro']);
        expect(await service.rejectRetroCandidates(true)).toEqual([id]);
        expect(await get(id)).toMatchObject({ status: 'candidate', note: null });
    });
});
