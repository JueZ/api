import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Expand suites ourselves: npm uses cmd.exe on Windows, which does not expand
// shell globs. Keep each suite limited to its immediate *.test.mjs files.
const inputs = process.argv.slice(2);
const youtubeLive = inputs[0] === '--youtube-live';
if (youtubeLive) inputs.shift();

try {
  if (inputs.length === 0) throw new Error('Provide at least one test directory or file.');
  const files = inputs.flatMap((input) => {
    const path = resolve(input);
    if (!statSync(path).isDirectory()) return [path];
    const matches = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
      .map((entry) => join(path, entry.name))
      .sort();
    if (matches.length === 0) throw new Error(`No test files found in ${input}.`);
    return matches;
  });
  const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: youtubeLive ? { ...process.env, YOUTUBE_LIVE_PROVIDER_TEST: 'true' } : process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
