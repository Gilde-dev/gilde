import { createInterface } from 'node:readline';

let lines: AsyncIterator<string> | undefined;

/** Reads a line from stdin without echoing it. Falls back to plain line reads when stdin is not a TTY. */
export async function promptHidden(question: string): Promise<string> {
    const { stdin, stderr } = process;
    stderr.write(question);

    if (!stdin.isTTY) {
        lines ??= createInterface({ input: stdin })[Symbol.asyncIterator]();
        const next = await lines.next();
        stderr.write('\n');
        if (next.done) throw new Error('No password provided on stdin');
        return next.value;
    }

    return new Promise<string>((resolve, reject) => {
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const finish = (fn: () => void) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            stderr.write('\n');
            fn();
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
                if (ch === '\u0003') return finish(() => reject(new Error('Cancelled')));
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else value += ch;
            }
        };
        stdin.on('data', onData);
    });
}
