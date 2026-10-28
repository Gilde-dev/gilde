import { parseArgs } from 'node:util';

export function parseUserCreateArgs(argv: string[]): { email: string; name: string; bot: boolean } {
    const { values } = parseArgs({
        args: argv,
        options: { email: { type: 'string' }, name: { type: 'string' }, bot: { type: 'boolean' } },
        strict: true,
    });
    if (!values.email || !values.name) {
        throw new Error('Usage: pnpm --filter @gilde/api user:create --email <email> --name <name> [--bot]');
    }
    return { email: values.email, name: values.name, bot: values.bot === true };
}

export function parseMarkBotArgs(argv: string[]): { email: string } {
    const { values } = parseArgs({ args: argv, options: { email: { type: 'string' } }, strict: true });
    if (!values.email) throw new Error('Usage: pnpm --filter @gilde/api user:mark-bot --email <email>');
    return { email: values.email };
}

export function parseApiKeyCreateArgs(argv: string[]): { email: string; name: string } {
    const { values } = parseArgs({
        args: argv,
        options: { email: { type: 'string' }, name: { type: 'string' } },
        strict: true,
    });
    if (!values.email || !values.name) {
        throw new Error('Usage: pnpm --filter @gilde/api apikey:create --email <user email> --name <name>');
    }
    return { email: values.email, name: values.name };
}

export function parseRejectRetroCandidatesArgs(argv: string[]): { dryRun: boolean } {
    const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' } }, strict: true });
    return { dryRun: values['dry-run'] === true };
}
