// Builds the API, then runs a TypeORM migration command against dist/data-source.js (ESM-safe).
// Usage: node scripts/migration.mjs generate <Name> | run | revert | check
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [command, name] = process.argv.slice(2);
const commands = {
  generate: () => {
    if (!name) throw new Error('Usage: pnpm migration:generate <Name>');
    return ['migration:generate', `src/migrations/${name}`, '-d', 'dist/data-source.js'];
  },
  run: () => ['migration:run', '-d', 'dist/data-source.js'],
  revert: () => ['migration:revert', '-d', 'dist/data-source.js'],
  check: () => ['migration:generate', 'src/migrations/Check', '-d', 'dist/data-source.js', '--check'],
};
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
const args = commands[command]();
const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('pnpm', ['exec', 'nest', 'build']);
run(process.execPath, [
  '--env-file-if-exists=.env',
  createRequire(import.meta.url).resolve('typeorm/cli.js'),
  ...args,
]);
