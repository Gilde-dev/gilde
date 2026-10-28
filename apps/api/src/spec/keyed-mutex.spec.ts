import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
    it('runs same-key work one at a time in order, and keeps going after a failure', async () => {
        const mutex = new KeyedMutex();
        const log: string[] = [];
        const task = (name: string, fail = false) => async () => {
            log.push(`${name}:start`);
            await new Promise((r) => setTimeout(r, 5));
            log.push(`${name}:end`);
            if (fail) throw new Error(name);
        };
        const results = await Promise.allSettled([mutex.run('k', task('a', true)), mutex.run('k', task('b')), mutex.run('other', task('c'))]);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
        expect(log.indexOf('a:end')).toBeLessThan(log.indexOf('b:start'));
    });
});
