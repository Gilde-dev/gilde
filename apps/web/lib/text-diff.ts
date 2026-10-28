export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Above this many lines on either side the diff is not computed (the table is quadratic). */
export const DIFF_MAX_LINES = 2000;

/**
 * A line diff of two texts (longest common subsequence). Returns null when a side is over DIFF_MAX_LINES, so a caller can
 * say so instead of freezing. Line endings are normalised for comparison only; the text of each line is kept as is.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
  const same = (x: string, y: string) => x.replace(/\r$/, '') === y.replace(/\r$/, '');

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = same(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i], b[j])) {
      out.push({ kind: 'same', text: b[j] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

export const diffStats = (lines: DiffLine[]) => ({
  added: lines.filter((l) => l.kind === 'add').length,
  removed: lines.filter((l) => l.kind === 'del').length,
});
