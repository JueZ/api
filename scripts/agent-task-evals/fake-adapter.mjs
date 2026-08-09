import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const mode = value('--mode');
const finalPath = value('--final');
const pidPath = value('--pid-file');
if (!['noop', 'fixture-success', 'tamper', 'timeout'].includes(mode)) throw new Error('Unsupported fake mode');

const final = {
  summary: mode === 'fixture-success' ? 'Applied the registered fixture repair.' : 'No repository repair was applied.',
  tests: mode === 'fixture-success' ? ['trusted fake adapter fixture'] : [],
  uncertainties: mode === 'fixture-success' ? [] : ['No correctness claim is available.'],
  phaseStatus: 'not_applicable',
  evidence: {
    local: mode === 'fixture-success' ? 'verified' : 'not_evaluated',
    prChecks: 'not_evaluated',
    merge: 'not_evaluated',
    deployment: 'not_applicable',
    runtime: 'not_applicable',
  },
};

if (mode === 'fixture-success') {
  const fixture = join(process.cwd(), 'fixture.txt');
  if (readFileSync(fixture, 'utf8') !== 'broken\n') throw new Error('Fixture baseline is unexpected');
  writeFileSync(fixture, 'fixed\n', 'utf8');
}
if (mode === 'tamper') {
  const tamperPath = join(process.cwd(), 'evals/agent-tasks/forged.yml');
  mkdirSync(dirname(tamperPath), { recursive: true });
  writeFileSync(tamperPath, 'forged: true\n', 'utf8');
}
if (mode === 'timeout') {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(pidPath, `${descendant.pid}\n`, 'utf8');
  setInterval(() => {}, 1000);
} else {
  writeFileSync(finalPath, `${JSON.stringify(final)}\n`, { encoding: 'utf8', mode: 0o600 });
}
