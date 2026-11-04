import type { Job } from '../job/job.entity.js';
import type { Repo } from '../repo/repo.entity.js';

import { BOOTSTRAP_NOTE, buildJobPayload } from './job-payload.js';

const job = { id: 'j', title: 't', task: 'x', acceptanceCriteria: [], prNumber: null, branch: null } as unknown as Job;
const repo = (over: Partial<Repo>) => ({ fullName: 'o/r', defaultBranch: 'main', testCommands: [], stacks: [], manifestStatus: null, ...over }) as Repo;

describe('buildJobPayload bootstrap note', () => {
    it('is added for a repo without .gilde.json and keeps empty test commands and stacks', () => {
        const p = buildJobPayload(job, repo({ manifestStatus: 'missing' }), null, 'r', 1);
        expect(p).toMatchObject({ testCommands: [], stacks: [], bootstrapNote: BOOTSTRAP_NOTE });
    });

    it('is absent for other repos', () => {
        expect(buildJobPayload(job, repo({ manifestStatus: 'ok', testCommands: ['pnpm test'] }), null, 'r', 1)).not.toHaveProperty('bootstrapNote');
        expect(buildJobPayload(job, repo({ manifestStatus: 'invalid' }), null, 'r', 1)).not.toHaveProperty('bootstrapNote');
    });
});
