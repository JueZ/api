import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TEMPLATE_FILES } from '../export-agent-template.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const exporter = join(repository, 'scripts/export-agent-template.mjs');
const source = join(repository, 'templates/agent-operating-contract');
function temporary(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'agent-template-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10_000 });
}

test('exports into two isolated local Git repositories with informative and fail-closed adapters', (t) => {
  const root = temporary(t);
  for (const name of ['empty repository', 'new repository']) {
    const target = join(root, name);
    if (name.startsWith('empty')) mkdirSync(target);
    const exported = run(process.execPath, [exporter, target], root);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(run('git', ['init', '--quiet', target], root).status, 0);
    assert.equal(run('git', ['remote'], target).stdout, '');
    const files = run('git', ['ls-files', '--others', '--exclude-standard'], target).stdout.trim().split(/\r?\n/);
    assert.deepEqual(files.sort(), [...TEMPLATE_FILES].sort());
    for (const path of files) {
      const content = readFileSync(join(target, path), 'utf8');
      assert.equal(content, readFileSync(join(source, path), 'utf8'));
      assert.doesNotMatch(
        content,
        /JueZ|Azure|martin|[A-Z]:[\\/]|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|Bearer\s+\S+|AccountKey=|sk-proj-/i,
      );
    }
    const doctor = run(process.execPath, [join(target, 'scripts/doctor.mjs')], root);
    assert.equal(doctor.status, 0);
    assert.equal(JSON.parse(doctor.stdout).gitRepository, true);
    assert.equal(JSON.parse(doctor.stdout).status, 'unconfigured');
    for (const [script, args] of [
      ['validate-affected.mjs', ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)]],
      ['validate-affected.mjs', ['--plan']],
      ['delivery-status.mjs', ['--sha', 'b'.repeat(40)]],
    ]) {
      const result = run(process.execPath, [join(target, 'scripts', script), ...args], root);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'unconfigured');
    }
    assert.notEqual(run(process.execPath, [exporter, target], root).status, 0);
  }
});

test('preserves nonempty directories and file targets byte for byte', (t) => {
  const root = temporary(t);
  const sentinel = join(root, 'keep.txt');
  writeFileSync(sentinel, 'existing user content');
  for (const target of [root, sentinel]) {
    const result = run(process.execPath, [exporter, target], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nonexistent or empty/);
    assert.deepEqual(readdirSync(root), ['keep.txt']);
    assert.equal(readFileSync(sentinel, 'utf8'), 'existing user content');
  }
  assert.notEqual(run(process.execPath, [exporter], root).status, 0);
});

test('rejects destination/source links and recursive exports without touching linked content', (t) => {
  const root = temporary(t);
  const outside = join(root, 'outside');
  const link = join(root, 'linked');
  mkdirSync(outside);
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [link, join(link, 'new')]) {
    const result = run(process.execPath, [exporter, target], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /links and junctions/);
  }
  assert.deepEqual(readdirSync(outside), []);
  const bundle = join(root, 'bundle');
  const copiedExporter = join(bundle, 'scripts/export-agent-template.mjs');
  mkdirSync(dirname(copiedExporter), { recursive: true });
  copyFileSync(exporter, copiedExporter);
  mkdirSync(join(bundle, 'templates'));
  symlinkSync(
    source,
    join(bundle, 'templates/agent-operating-contract'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const target = join(root, 'new');
  const linkedSource = run(process.execPath, [copiedExporter, target], root);
  assert.notEqual(linkedSource.status, 0);
  assert.match(linkedSource.stderr, /links and junctions/);
  assert.equal(existsSync(target), false);
  for (const recursive of [bundle, join(bundle, 'nested'), root]) {
    const result = run(process.execPath, [copiedExporter, recursive], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /overlap/);
  }
  assert.equal(existsSync(join(bundle, 'nested')), false);
});
