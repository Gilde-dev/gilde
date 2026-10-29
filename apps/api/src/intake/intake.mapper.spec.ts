import { describe, expect, it } from 'vitest';

import { INTAKE_COMMENT_LIMIT } from './intake-issue.js';
import type { IntakeItem } from './intake-item.entity.js';
import { IntakeMapper } from './intake.mapper.js';

describe('IntakeMapper.toDetailDTO', () => {
    const item = {
        id: 'i1', projectId: 'p', repoId: 'r', repo: null, source: 'github_issue', externalId: '1', number: 12, url: 'https://github.com/o/r/issues/12',
        title: 't', authorLogin: 'ann', labels: [], status: 'new', specId: null, lastError: null, statusCommentUrl: null, commentError: null,
        refineAttempts: 0, createdAt: new Date(0), updatedAt: new Date(0), body: 'b', bodyTruncated: false, bodySha256: 'x', refinedSha256: null,
        comments: [
            { id: '5', author: 'bob', body: 'a'.repeat(INTAKE_COMMENT_LIMIT + 10), createdAt: '2026-01-01T00:00:00.000Z' },
            { id: '6', author: 'cy', body: '<script>x</script>', createdAt: '2026-01-02T00:00:00.000Z' },
        ],
    } as unknown as IntakeItem;

    it('lists the stored comments in stored order, capped, with a link to each on GitHub', () => {
        const { comments } = new IntakeMapper().toDetailDTO(item);
        expect(comments.map((c) => c.id)).toEqual(['5', '6']);
        expect(comments[0].body).toHaveLength(INTAKE_COMMENT_LIMIT);
        expect(comments[0].url).toBe('https://github.com/o/r/issues/12#issuecomment-5');
        expect(comments[1]).toMatchObject({ author: 'cy', body: '<script>x</script>' });
    });
});
