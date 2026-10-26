import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
// `var(--indigo-600)` style primitives live in CSS; components may only use the semantic classes.
const PALETTE = /\b[\w:/[\]-]*?(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|amethyst|eggplant)-\d+/;
const RAW = /\b(?:bg-white|bg-black|text-white|text-black)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [p] : [];
  });
}

const sources = [...files(join(root, 'components')), ...files(join(root, 'app')), ...files(join(root, 'lib'))];
const lines = (re: RegExp, only?: (f: string) => boolean) =>
  sources.flatMap((f) =>
    only && !only(f)
      ? []
      : readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) => (re.test(line) ? [`${relative(root, f)}:${i + 1}: ${line.trim()}`] : [])),
  );

describe('design tokens', () => {
  it('uses no Tailwind palette colours or raw white/black in components (including ui) and app', () => {
    const offenders = sources.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (PALETTE.test(line) || RAW.test(line) ? [`${relative(root, f)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });

  it('does not bring back Fraunces or Inter', () => {
    expect(lines(/Fraunces|\bInter\b\s*\(|\{\s*[^}]*\bInter\b[^}]*\}\s*from 'next\/font/)).toEqual([]);
  });

  it('renders lucide icons only through components/ui/icon.tsx', () => {
    const offenders = lines(/from 'lucide-react'/, (f) => !f.endsWith(join('components', 'ui', 'icon.tsx')))
      // Importing the icon *component types/glyphs* to hand to <Icon> / `icon` props is fine; rendering them is not.
      .filter((l) => /<[A-Z]\w*\s[^>]*\/>/.test(l));
    expect(offenders).toEqual([]);
    const rendered = sources
      .filter((f) => !f.endsWith(join('components', 'ui', 'icon.tsx')))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        const m = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(src);
        if (!m) return false;
        const names = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!).filter((n) => /^[A-Z]/.test(n) && n !== 'LucideIcon');
        return names.some((n) => new RegExp(`<${n}[\\s/>]`).test(src));
      })
      .map((f) => relative(root, f));
    expect(rendered).toEqual([]);
  });
});

/* ---- contrast: recompute from globals.css what the comment there documents ---- */

const css = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
const block = (selector: string) => {
  const m = new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{([\\s\\S]*?)\\n  \\}`).exec(css);
  if (!m) throw new Error(`no ${selector} block`);
  return Object.fromEntries([...m[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()]));
};
const themes = { light: block(':root'), dark: { ...block(':root'), ...block('.dark') } } as const;

type RGB = [number, number, number];
function color(theme: Record<string, string>, name: string): RGB {
  const v = theme[name];
  if (!v) throw new Error(`unknown token ${name}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(v);
  if (alias) return color(theme, alias[1]!);
  const ch = v.split(/\s+/).map(Number);
  if (ch.length !== 3 || ch.some(Number.isNaN)) throw new Error(`${name} is not a colour: ${v}`);
  return ch as RGB;
}
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i]! - v) * t) as RGB;

describe('palette', () => {
  const NEUTRALS = {
    light: '#FFFFFF,#F9F9FB,#F6F6F9,#F4F3F8,#EEEDF3,#E5E5ED,#D2D2E0,#BABACF,#8787A6,#696888,#56556E,#413F56,#2D2A3E,#171327,#000000',
    dark: '#000000,#111014,#1A1721,#1E1C27,#22202C,#2E2B3A,#3B3947,#494758,#716F86,#8F8DA5,#ABA9C4,#C2C0D8,#DBD9ED,#F3F2F8,#FFFFFF',
  };
  const STOPS = [0, 25, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000];
  const hex = ([r, g, b]: RGB) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  for (const t of ['light', 'dark'] as const) {
    it(`${t}: has the exact neutral stops and brand colours`, () => {
      expect(STOPS.map((s) => hex(color(themes[t], `neutral-${s}`))).join(',')).toBe(NEUTRALS[t]);
      expect(hex(color(themes[t], 'amethyst-500'))).toBe('#8143D7');
      expect(hex(color(themes[t], 'indigo-600'))).toBe('#4029D1');
      expect(hex(color(themes[t], 'eggplant-800'))).toBe('#000079');
      for (const c of ['green', 'red', 'yellow', 'blue']) for (const n of [50, 500, 700]) expect(() => color(themes[t], `${c}-${n}`)).not.toThrow();
    });
  }
});

describe('contrast (WCAG AA)', () => {
  const TEXT_AA = 4.5;
  const NON_TEXT = 3;
  for (const t of ['light', 'dark'] as const) {
    const th = themes[t];
    const c = (n: string) => color(th, n);

    it(`${t}: main and muted text on every surface`, () => {
      for (const surface of ['background', 'surface', 'card', 'sidebar', 'lane', 'popover']) {
        expect(ratio(c('foreground'), c(surface)), `foreground on ${surface}`).toBeGreaterThanOrEqual(TEXT_AA);
        expect(ratio(c('muted-foreground'), c(surface)), `muted-foreground on ${surface}`).toBeGreaterThanOrEqual(TEXT_AA);
      }
      expect(ratio(c('muted-foreground'), c('muted'))).toBeGreaterThanOrEqual(TEXT_AA);
    });

    it(`${t}: badge pairs (text on soft) and status text on surfaces`, () => {
      for (const s of ['accent', 'success', 'warning', 'danger', 'info', 'running', 'pr']) {
        expect(ratio(c(s), c(`${s}-soft`)), `${s} on ${s}-soft`).toBeGreaterThanOrEqual(TEXT_AA);
        expect(ratio(c(s), c('card')), `${s} on card`).toBeGreaterThanOrEqual(TEXT_AA);
        expect(ratio(c(`${s}-foreground`), c(s)), `${s}-foreground on ${s}`).toBeGreaterThanOrEqual(TEXT_AA);
      }
      for (const s of ['success', 'warning', 'danger', 'info', 'running', 'pr']) {
        expect(ratio(c(`${s}-solid`), c('card')), `${s}-solid dot on card`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });

    it(`${t}: primary button text on the gradient, worst point included`, () => {
      const from = c('amethyst-500');
      const to = c('indigo-600');
      const worst = Math.min(...Array.from({ length: 101 }, (_, i) => ratio(c('primary-foreground'), mix(from, to, i / 100))));
      expect(worst).toBeGreaterThanOrEqual(TEXT_AA);
      expect(ratio(c('ring'), c('background'))).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }
});
