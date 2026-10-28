import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFireUrl } from './fire-url';
import { ROUTINE_DESCRIPTION } from './routine-description';

// The same examples as apps/api/src/executor/executor.dto.spec.ts.
const OK = ['https://api.anthropic.com/v1/claude_code/routines/trig_01AbC-d_9/fire'];
const BAD = [
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
];

describe('isFireUrl', () => {
  it('accepts and rejects the same examples as the API FireUrlSchema', () => {
    for (const ok of OK) expect(isFireUrl(ok), ok).toBe(true);
    for (const bad of BAD) expect(isFireUrl(bad), bad).toBe(false);
    expect(isFireUrl(`  ${OK[0]}  `)).toBe(true);
  });
});

describe('ROUTINE_DESCRIPTION', () => {
  it('is the text README "Agent instructions" gives for the routine', () => {
    const readme = readFileSync(resolve(process.cwd(), '../../README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Agent instructions'));
    expect(section).toContain(`> ${ROUTINE_DESCRIPTION}`);
  });
});
