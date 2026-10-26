import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const PALETTE = /\b[\w:/[\]-]*?(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/;
const RAW = /\b(?:bg-white|bg-black|text-white|text-black)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return relative(root, p) === join('components', 'ui') ? [] : files(p);
    return /\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('design tokens', () => {
  it('uses no Tailwind palette colours or raw white/black in components and app', () => {
    const offenders = [...files(join(root, 'components')), ...files(join(root, 'app'))].flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (PALETTE.test(line) || RAW.test(line) ? [`${relative(root, f)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
