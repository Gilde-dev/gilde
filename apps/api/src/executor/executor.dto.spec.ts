import { CreateExecutorSchema, ExecutorTokenSchema, FireUrlSchema, ReplaceExecutorSchema } from './executor.dto.js';

const URL_OK = 'https://api.anthropic.com/v1/claude_code/routines/trig_01AbC-d_9/fire';
const REPO = '3f2b1c9e-5a4d-4e6f-8a7b-1c2d3e4f5a6b';
const valid = { name: 'Pascal', fireUrl: URL_OK, token: 'sk-ant-oat01-abcd1234', repoIds: [REPO] };

describe('executor DTOs', () => {
    it('accepts a routine fire URL and rejects everything else', () => {
        expect(FireUrlSchema.safeParse(URL_OK).success).toBe(true);
        for (const bad of [
            'http://api.anthropic.com/v1/claude_code/routines/abc/fire',
            'https://evil.example.com/v1/claude_code/routines/abc/fire',
            'https://api.anthropic.com.evil.com/v1/claude_code/routines/abc/fire',
            'https://user:pw@api.anthropic.com/v1/claude_code/routines/abc/fire',
            'https://api.anthropic.com:8443/v1/claude_code/routines/abc/fire',
            'https://api.anthropic.com/v1/claude_code/routines/abc/fire?x=1',
            'https://api.anthropic.com/v1/claude_code/routines/abc/fire#x',
            'https://api.anthropic.com/v1/claude_code/routines//fire',
            'https://api.anthropic.com/v1/claude_code/routines/a/b/fire',
            'https://api.anthropic.com/v1/messages',
            'not a url',
        ]) expect(FireUrlSchema.safeParse(bad).success, bad).toBe(false);
    });

    it('validates name, repos and limits on create', () => {
        expect(CreateExecutorSchema.safeParse(valid).success).toBe(true);
        expect(CreateExecutorSchema.safeParse({ ...valid, name: '  ' }).success).toBe(false);
        expect(CreateExecutorSchema.safeParse({ ...valid, name: 'x'.repeat(81) }).success).toBe(false);
        expect(CreateExecutorSchema.safeParse({ ...valid, name: 'x'.repeat(80) }).success).toBe(true);
        expect(CreateExecutorSchema.safeParse({ ...valid, repoIds: ['nope'] }).success).toBe(false);
        expect(CreateExecutorSchema.safeParse({ ...valid, maxConcurrent: 0 }).success).toBe(false);
        expect(CreateExecutorSchema.safeParse({ ...valid, maxConcurrent: 11 }).success).toBe(false);
        expect(CreateExecutorSchema.safeParse({ ...valid, maxConcurrent: 10 }).success).toBe(true);
        expect(CreateExecutorSchema.safeParse({ ...valid, dailyRunLimit: 0 }).success).toBe(false);
        expect(CreateExecutorSchema.safeParse({ ...valid, dailyRunLimit: null }).success).toBe(true);
        expect(CreateExecutorSchema.safeParse({ ...valid, token: '' }).success).toBe(false);
    });

    it('requires every updatable field on replace and has no token field', () => {
        const full = { name: 'n', fireUrl: URL_OK, repoIds: [], maxConcurrent: 1, dailyRunLimit: null, enabled: true };
        expect(ReplaceExecutorSchema.safeParse(full).success).toBe(true);
        expect(ReplaceExecutorSchema.safeParse({ ...full, enabled: undefined }).success).toBe(false);
        expect(ReplaceExecutorSchema.safeParse({ ...full, dailyRunLimit: undefined }).success).toBe(false);
        expect(Object.keys(ReplaceExecutorSchema.shape)).not.toContain('token');
    });

    it('rejects tokens with whitespace or control characters without echoing them', () => {
        const res = ExecutorTokenSchema.safeParse('sk secret');
        expect(res.success).toBe(false);
        expect(JSON.stringify(res.error?.issues)).not.toContain('sk secret');
        expect(ExecutorTokenSchema.safeParse('a\nb').success).toBe(false);
    });
});
