import { describe, expect, it } from 'vitest';
import type { Job } from './api';
import { dependencyLevels } from './feature-jobs';

const j = (id: string, dependsOn: string[] = []) => ({ id, title: `T${id}`, dependsOn }) as Job;
const ids = (levels: Job[][]) => levels.map((l) => l.map((x) => x.id));

describe('dependencyLevels', () => {
  it('orders a linear chain', () => {
    expect(ids(dependencyLevels([j('c', ['b']), j('b', ['a']), j('a')]).levels)).toEqual([['a'], ['b'], ['c']]);
  });

  it('puts the diamond tip after both sides', () => {
    const r = dependencyLevels([j('a'), j('b', ['a']), j('c', ['a']), j('d', ['b', 'c'])]);
    expect(ids(r.levels)).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(r.notes).toEqual([]);
  });

  it('reports a cycle and keeps the rest', () => {
    const r = dependencyLevels([j('a'), j('x', ['y']), j('y', ['x']), j('z', ['x'])]);
    expect(ids(r.levels)).toEqual([['a']]);
    expect(r.cyclic.map((x) => x.id).sort()).toEqual(['x', 'y', 'z']);
    expect(r.notes[0]).toMatch(/cycle/i);
  });

  it('treats a dependency outside the feature as a note, not a level', () => {
    const r = dependencyLevels([j('a', ['ffffffff-0000'])]);
    expect(ids(r.levels)).toEqual([['a']]);
    expect(r.outside).toHaveLength(1);
    expect(r.notes[0]).toMatch(/outside/);
  });
});
