/** Runs async functions with the same key one at a time, in call order. */
export class KeyedMutex {
    private readonly tails = new Map<string, Promise<unknown>>();

    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(fn);
        const tail = next.catch(() => undefined);
        this.tails.set(key, tail);
        try {
            return await next;
        } finally {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        }
    }
}
