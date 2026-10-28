import { describe, expect, it } from 'vitest';
import { DIFF_MAX_LINES, diffLines, diffStats } from './text-diff';
import { safeUrl } from './safe-url';

describe('diffLines', () => {
  it('marks added, removed and unchanged lines in order', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });

  it('handles empty sides and identical text', () => {
    expect(diffLines('', 'a')).toEqual([{ kind: 'add', text: 'a' }]);
    expect(diffLines('a', '')).toEqual([{ kind: 'del', text: 'a' }]);
    expect(diffStats(diffLines('a\nb', 'a\nb')!)).toEqual({ added: 0, removed: 0 });
  });

  it('gives up above the line limit instead of computing a huge table', () => {
    const big = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    expect(diffLines(big, 'x')).toBeNull();
  });
});

describe('safeUrl', () => {
  it('allows http, https, mailto and relative targets', () => {
    for (const ok of ['https://example.com/a', 'HTTP://example.com', 'mailto:a@b.c', '/specs/x', '#ac-1', '../x.md', 'docs/readme.md', '?a=1']) {
      expect(safeUrl(ok)).toBe(ok);
    }
  });

  it('refuses script-capable and unknown schemes, however they are disguised', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://x', '//evil.example/x', '', null, undefined]) {
      expect(safeUrl(bad as string)).toBeNull();
    }
  });
});
