import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  timeout: 5_000,
});
console.log(
  JSON.stringify({
    status: 'unconfigured',
    node: process.version,
    node22: process.versions.node.split('.')[0] === '22',
    gitAvailable: !git.error,
    gitRepository: git.status === 0,
    validation: 'unconfigured',
    delivery: 'unconfigured',
    next: 'Bind the project adapters using README.md. Diagnostics are not validation or delivery evidence.',
  }),
);
