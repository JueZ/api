import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assessEvidence,
  assertNode22,
  assertStableCandidate,
  createEvidence,
  createValidationPlan,
  executePlan,
  fingerprintCandidate,
  fingerprintProvenance,
  inspectCandidate,
  outputState,
  planFingerprint,
  selectWindowsCommand,
  validateEvidencePath,
  writeEvidence,
} from '../lib/affected-validation.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'affected-validation-'));
  for (const directory of [
    'apps/api/test',
    'apps/web/test',
    'scripts/test',
    'scripts/agent-env/test',
    'contracts',
    'infra',
    '.github/workflows',
  ]) {
    mkdirSync(join(root, ...directory.split('/')), { recursive: true });
  }
  writeFileSync(join(root, 'apps/api/test/api.test.mjs'), '');
  writeFileSync(join(root, 'apps/web/test/web.test.mjs'), '');
  writeFileSync(join(root, 'scripts/test/script.test.mjs'), '');
  writeFileSync(join(root, 'scripts/test/affected-validation.test.mjs'), '');
  writeFileSync(join(root, 'scripts/test/maintain-codex-env.test.mjs'), '');
  writeFileSync(join(root, 'scripts/test/run-tests.test.mjs'), '');
  writeFileSync(join(root, 'scripts/test/setup-codex-env.test.mjs'), '');
  writeFileSync(join(root, 'scripts/check.sh'), '');
  writeFileSync(join(root, 'scripts/agent-env/test/environment.test.mjs'), '');
  writeFileSync(join(root, 'contracts/openapi.yaml'), 'openapi: 3.0.0\n');
  writeFileSync(join(root, 'infra/main.bicep'), '');
  writeFileSync(join(root, '.github/workflows/check.yml'), '');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function allClassification() {
  return {
    baseSha: 'a'.repeat(40),
    mode: 'broad-fallback',
    flags: {
      backend: true,
      frontend: true,
      contracts: true,
      infrastructure: true,
      workflow: true,
      dependencies: true,
      learning: true,
      privileged: true,
      operations: true,
      agentEnvironment: true,
    },
  };
}

test('combined validation compiles each application once and never invokes npm recipes', (t) => {
  const root = fixture(t);
  const steps = createValidationPlan(
    allClassification(),
    [
      { filename: 'apps/api/src/index.ts', status: 'modified' },
      { filename: 'apps/web/src/main.ts', status: 'modified' },
    ],
    root,
  );
  assert.equal(steps.filter((step) => step.id === 'build-api').length, 1);
  assert.equal(steps.filter((step) => step.id === 'build-web').length, 1);
  assert.equal(
    steps.flatMap((step) => step.commands).some((command) => command.tool === 'npm'),
    false,
  );
  assert.ok(steps.findIndex((step) => step.id === 'build-api') < steps.findIndex((step) => step.id === 'test-api'));
  assert.ok(
    steps.findIndex((step) => step.id === 'build-api') < steps.findIndex((step) => step.id === 'operation-drift'),
  );
  assert.ok(
    steps
      .find((step) => step.id === 'test-operations')
      .commands[0].args.includes('scripts/test/affected-validation.test.mjs'),
  );
  assert.ok(steps.find((step) => step.id === 'actionlint').commands[0].args.includes('-shellcheck='));
  assert.ok(steps.some((step) => step.id === 'shellcheck'));
});

test('agent-environment capability remains proportional and includes maintenance tests', (t) => {
  const root = fixture(t);
  const steps = createValidationPlan(
    {
      baseSha: 'a'.repeat(40),
      flags: { agentEnvironment: true, operations: false, privileged: false },
    },
    [{ filename: 'package.json', status: 'modified' }],
    root,
  );
  assert.equal(
    steps.some((step) => step.id === 'build-api'),
    false,
  );
  assert.equal(
    steps.some((step) => step.id === 'policy'),
    false,
  );
  const environmentTests = steps.find((step) => step.id === 'test-agent-environment').commands[0].args;
  assert.ok(environmentTests.includes('scripts/test/maintain-codex-env.test.mjs'));
  assert.ok(environmentTests.includes('scripts/test/setup-codex-env.test.mjs'));
});

test('operation, backend, and sensitive capabilities keep their independent prerequisites', (t) => {
  const root = fixture(t);
  const changed = [{ filename: 'scripts/example.mjs', status: 'modified' }];
  const operations = createValidationPlan(
    { baseSha: 'a'.repeat(40), flags: { operations: true, privileged: false, agentEnvironment: false } },
    changed,
    root,
  );
  assert.equal(operations.filter((step) => step.id === 'build-api').length, 1);
  assert.ok(operations.some((step) => step.id === 'test-operations'));
  assert.equal(
    operations.some((step) => step.id === 'build-web'),
    false,
  );

  const backend = createValidationPlan(
    { baseSha: 'a'.repeat(40), flags: { backend: true, contracts: false, privileged: false } },
    [{ filename: 'apps/api/src/index.ts', status: 'modified' }],
    root,
  );
  assert.ok(backend.some((step) => step.id === 'contracts-lint'));
  assert.ok(backend.some((step) => step.id === 'operation-drift'));

  const sensitive = createValidationPlan(
    { baseSha: 'a'.repeat(40), flags: { privileged: true, operations: false, agentEnvironment: false } },
    [{ filename: '.agents/example.md', status: 'modified' }],
    root,
  );
  assert.ok(sensitive.some((step) => step.id === 'policy'));
  assert.equal(
    sensitive.some((step) => step.id === 'build-api'),
    false,
  );
  assert.equal(
    sensitive.some((step) => step.id === 'test-operations'),
    false,
  );
});

test('runtime and post-execution candidate checks fail closed', () => {
  assert.doesNotThrow(() => assertNode22('22.23.2'));
  assert.throws(() => assertNode22('24.0.0'), /requires Node\.js 22/);
  const before = inspectionFixture();
  assert.doesNotThrow(() => assertStableCandidate(before, structuredClone(before)));
  const after = structuredClone(before);
  after.inputFingerprint = 'changed-during-checks';
  assert.throws(() => assertStableCandidate(before, after), /changed during validation/);
});

test('candidate fingerprints change for base, untracked input, and deletion changes', () => {
  const original = candidate();
  const untracked = structuredClone(original);
  untracked.files.push({ filename: 'new-file.mjs', status: 'added', input: { exists: true, digest: '1' } });
  const deleted = structuredClone(original);
  deleted.files = [{ filename: 'source.mjs', status: 'removed', input: { exists: false } }];
  const rebased = structuredClone(original);
  rebased.baseSha = 'b'.repeat(40);

  const fingerprint = fingerprintCandidate(original);
  assert.notEqual(fingerprintCandidate(untracked), fingerprint);
  assert.notEqual(fingerprintCandidate(deleted), fingerprint);
  assert.notEqual(fingerprintCandidate(rebased), fingerprint);
});

test('prior evidence is invalidated by dependencies, toolchain, inputs, and mutated outputs', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
  writeFileSync(join(root, 'apps/api/dist/index.js'), 'original');
  const inspection = inspectionFixture();
  const steps = [{ id: 'build-api', description: 'compile', commands: [], outputs: ['apps/api/dist'] }];
  const provenance = provenanceFixture();
  const outputs = outputState(root, steps);
  const evidence = createEvidence({
    inspection,
    steps,
    provenance,
    results: [{ id: 'build-api', status: 'passed' }],
    outputs,
    outcome: 'passed',
    startedAt: '2026-09-07T00:00:00.000Z',
    finishedAt: '2026-09-07T00:00:01.000Z',
  });
  assert.deepEqual(assessEvidence(evidence, { inspection, steps, provenance, outputs }), {
    advisory: true,
    matches: true,
    reusable: false,
    reason: 'metadata matches; automatic reuse is disabled',
  });

  const changedInput = structuredClone(inspection);
  changedInput.inputFingerprint = 'changed';
  assert.equal(
    assessEvidence(evidence, { inspection: changedInput, steps, provenance, outputs }).reason,
    'candidate-inputs-changed',
  );

  const changedDependencies = structuredClone(provenance);
  changedDependencies.dependencies[0].digest = 'changed';
  changedDependencies.fingerprint = fingerprintProvenance(changedDependencies);
  assert.equal(
    assessEvidence(evidence, { inspection, steps, provenance: changedDependencies, outputs }).reason,
    'dependencies-or-toolchain-changed',
  );

  const changedToolchain = structuredClone(provenance);
  changedToolchain.tools.node.version = 'v22.1.0';
  changedToolchain.fingerprint = fingerprintProvenance(changedToolchain);
  assert.equal(
    assessEvidence(evidence, { inspection, steps, provenance: changedToolchain, outputs }).reason,
    'dependencies-or-toolchain-changed',
  );

  writeFileSync(join(root, 'apps/api/dist/index.js'), 'mutated');
  assert.equal(
    assessEvidence(evidence, { inspection, steps, provenance, outputs: outputState(root, steps) }).reason,
    'outputs-changed',
  );
  assert.equal(evidence.reusePolicy, 'none');
  assert.equal(evidence.planFingerprint, planFingerprint(steps));
});

test('Windows command shims execute without shell-enabled spawn', { skip: process.platform !== 'win32' }, (t) => {
  const root = fixture(t);
  const shim = join(root, 'safe-tool.cmd');
  writeFileSync(shim, '@echo off\r\nif not "%~1"=="safe" exit /b 9\r\nexit /b 0\r\n');
  const results = executePlan(root, [{ id: 'shim', commands: [{ tool: shim, args: ['safe'] }], outputs: [] }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'shim');
  assert.equal(results[0].status, 'passed');
});

test('Windows command resolution ignores extensionless Azure wrappers', () => {
  const root = 'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az';
  assert.equal(selectWindowsCommand(`${root}\r\n${root}.cmd\r\n`), `${root}.cmd`);
  assert.equal(selectWindowsCommand('C:\\tools\\actionlint.exe\r\n'), 'C:\\tools\\actionlint.exe');
});

test('invalid evidence destinations cannot overwrite repository source', (t) => {
  const root = repositoryFixture(t);
  const source = join(root, 'source.txt');
  const before = readFileSync(source, 'utf8');
  assert.throws(() => writeEvidence(root, { outcome: 'passed' }, 'source.txt'), /under \.agent-runtime/);
  assert.throws(
    () => writeEvidence(root, { outcome: 'passed' }, '.agent-runtime/affected-validation/../../source.txt'),
    /invalid segment|under \.agent-runtime/,
  );
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.equal(inspectCandidate(root, 'HEAD').candidate.files.length, 0);
});

test('evidence writes stay ignored and preserve candidate identity', (t) => {
  const root = repositoryFixture(t);
  const before = inspectCandidate(root, 'HEAD');
  const path = writeEvidence(root, { outcome: 'passed', candidate: before.inputFingerprint });
  writeEvidence(root, { outcome: 'passed', candidate: before.inputFingerprint, repeated: true });
  const after = inspectCandidate(root, 'HEAD');
  assert.equal(after.inputFingerprint, before.inputFingerprint);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).candidate, before.inputFingerprint);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).repeated, true);
});

test('tracked or unignored evidence destinations are rejected', (t) => {
  const trackedRoot = repositoryFixture(t);
  const trackedPath = join(trackedRoot, '.agent-runtime', 'affected-validation', 'tracked.json');
  mkdirSync(join(trackedRoot, '.agent-runtime', 'affected-validation'), { recursive: true });
  writeFileSync(trackedPath, '{}\n');
  gitCommand(trackedRoot, ['add', '--force', '.agent-runtime/affected-validation/tracked.json']);
  gitCommand(trackedRoot, ['commit', '--quiet', '-m', 'tracked evidence fixture']);
  assert.throws(
    () => validateEvidencePath(trackedRoot, '.agent-runtime/affected-validation/tracked.json'),
    /tracked by Git/,
  );

  const unignoredRoot = repositoryFixture(t, { ignoreEvidence: false });
  assert.throws(() => validateEvidencePath(unignoredRoot), /not ignored by Git/);
});

test('evidence paths reject symbolic-link and reparse-point ancestors', (t) => {
  const root = repositoryFixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'affected-validation-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(root, '.agent-runtime'), { recursive: true });
  symlinkSync(
    outside,
    join(root, '.agent-runtime', 'affected-validation'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => validateEvidencePath(root), /symbolic link or reparse point/);
});

function candidate() {
  return {
    baseRef: 'origin/main',
    baseSha: 'a'.repeat(40),
    headSha: 'c'.repeat(40),
    files: [{ filename: 'source.mjs', status: 'modified', input: { exists: true, digest: '0' } }],
    patches: { baseToWorktree: '1', baseToIndex: '2', headToWorktree: '3', untracked: '4' },
  };
}

function inspectionFixture() {
  return {
    candidate: candidate(),
    inputFingerprint: fingerprintCandidate(candidate()),
    classification: allClassification(),
  };
}

function provenanceFixture() {
  const provenance = {
    dependencies: [{ path: 'package-lock.json', digest: 'dependencies' }],
    tools: { node: { version: 'v22.0.0' } },
    environmentFingerprint: 'environment',
  };
  return { ...provenance, fingerprint: fingerprintProvenance(provenance) };
}

function repositoryFixture(t, { ignoreEvidence = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'affected-validation-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.gitignore'), ignoreEvidence ? '.agent-runtime/\n' : 'other-output/\n');
  writeFileSync(join(root, 'source.txt'), 'preserve me\n');
  gitCommand(root, ['init', '--quiet']);
  gitCommand(root, ['config', 'user.name', 'Affected Validation Test']);
  gitCommand(root, ['config', 'user.email', 'affected-validation@example.invalid']);
  gitCommand(root, ['add', '.gitignore', 'source.txt']);
  gitCommand(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

function gitCommand(root, args) {
  const completed = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(completed.status, 0, completed.stderr);
  return completed.stdout;
}
