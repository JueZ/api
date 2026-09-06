import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../run-tests.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'portable tests '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...args], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 30_000,
  });
}

test('portable runner executes every selected suite and preserves immediate test-file scope', (t) => {
  const root = fixture(t);
  const suites = ['first suite', 'second suite'].map((name) => join(root, name));
  for (const [index, suite] of suites.entries()) {
    mkdirSync(join(suite, 'nested'), { recursive: true });
    writeFileSync(join(suite, 'included.test.mjs'), `console.log('selected-suite-${index}');`);
    writeFileSync(join(suite, 'helper.mjs'), "throw new Error('Do not run helpers');");
    writeFileSync(join(suite, 'nested', 'excluded.test.mjs'), "throw new Error('Do not recurse');");
  }
  const result = run(suites);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /selected-suite-0/);
  assert.match(result.stdout, /selected-suite-1/);
});

test('portable runner propagates test failures', (t) => {
  const root = fixture(t);
  const file = join(root, 'failure.test.mjs');
  writeFileSync(file, "throw new Error('expected-test-failure');");
  const result = run([file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /expected-test-failure/);
});

test('portable runner fails closed for empty, missing, or unspecified suites', (t) => {
  const root = fixture(t);
  for (const args of [[], [root], [join(root, 'missing')]]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

test('portable runner sets the live YouTube opt-in only when requested', (t) => {
  const root = fixture(t);
  const file = join(root, 'environment.test.mjs');
  writeFileSync(file, "console.log('live-opt-in=' + process.env.YOUTUBE_LIVE_PROVIDER_TEST);");
  const ordinary = run([file], { YOUTUBE_LIVE_PROVIDER_TEST: 'false' });
  assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
  assert.match(ordinary.stdout, /live-opt-in=false/);
  const live = run(['--youtube-live', file], { YOUTUBE_LIVE_PROVIDER_TEST: 'false' });
  assert.equal(live.status, 0, live.stdout + live.stderr);
  assert.match(live.stdout, /live-opt-in=true/);
});
