import { parseArgs } from 'node:util';

export function parseUserCreateArgs(argv: string[]): { email: string; name: string } {
    const { values } = parseArgs({
        args: argv,
        options: { email: { type: 'string' }, name: { type: 'string' } },
        strict: true,
    });
    if (!values.email || !values.name) {
        throw new Error('Usage: pnpm --filter @gilde/api user:create --email <email> --name <name>');
    }
    return { email: values.email, name: values.name };
}
