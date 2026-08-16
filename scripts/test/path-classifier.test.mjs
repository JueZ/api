import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChangedFiles, fullValidation, parseGitNameStatus } from '../lib/path-classifier.mjs';

const file = (filename, status = 'modified', extra = {}) => ({ filename, status, ...extra });

test('documentation-only fixture avoids every application and delivery job', () => {
  const result = classifyChangedFiles([file('README.md'), file('docs/architecture/overview.md')]);
  assert.deepEqual(result.profiles, ['documentation-only']);
  assert.equal(result.flags.documentation, true);
  for (const flag of ['backend', 'frontend', 'contracts', 'infrastructure', 'workflow', 'dependencies', 'trivy']) {
    assert.equal(result.flags[flag], false, flag);
  }
});

test('learning records validate independently without application or historical program work', () => {
  const artifact = classifyChangedFiles([file('docs/agent-learning/artifacts/runtime-neutral.yml')]);
  assert.deepEqual(artifact.profiles, ['learning-governance']);
  assert.equal(artifact.flags.learning, true);
  assert.equal(artifact.flags.documentation, true);
  for (const flag of ['backend', 'frontend', 'contracts', 'infrastructure', 'workflow', 'dependencies', 'privileged']) {
    assert.equal(artifact.flags[flag], false, flag);
  }

  const validator = classifyChangedFiles([file('scripts/agent-learning/validate-artifacts.mjs')]);
  assert.deepEqual(validator.profiles, ['learning-governance', 'privileged']);
  assert.equal(validator.flags.learning, true);
  assert.equal(validator.flags.privileged, true);
});

test('API, frontend, contract, and infrastructure fixtures select only their relevant work', () => {
  const api = classifyChangedFiles([file('apps/api/src/functions/hello.ts')]);
  assert.deepEqual(api.profiles, ['api-backend']);
  assert.equal(api.flags.backend, true);
  assert.equal(api.flags.frontend, false);
  assert.equal(api.flags.codeqlJavascript, true);

  const frontend = classifyChangedFiles([file('apps/web/src/app/app.ts')]);
  assert.deepEqual(frontend.profiles, ['frontend']);
  assert.equal(frontend.flags.frontend, true);
  assert.equal(frontend.flags.backend, false);

  const contract = classifyChangedFiles([file('contracts/openapi.yaml')]);
  assert.deepEqual(contract.profiles, ['contracts-integrations']);
  assert.equal(contract.flags.contracts, true);
  assert.equal(contract.flags.backend, false);

  const infrastructure = classifyChangedFiles([file('infra/main.bicep')]);
  assert.deepEqual(infrastructure.profiles, ['infrastructure-delivery']);
  assert.equal(infrastructure.flags.infrastructure, true);
  assert.equal(infrastructure.flags.workflow, false);
});

test('workflow and dependency fixtures use the privileged broad profile', () => {
  for (const filename of [
    '.github/workflows/pr-gate.yml',
    'package-lock.json',
    'apps/api/package.json',
    'apps/api/package-lock.json',
  ]) {
    const result = classifyChangedFiles([file(filename)]);
    assert.deepEqual(result.profiles, ['privileged']);
    assert.equal(result.flags.privileged, true);
    assert.equal(result.flags.backend, true);
    assert.equal(result.flags.frontend, true);
    assert.equal(result.flags.infrastructure, true);
    assert.equal(result.flags.workflow, true);
    assert.equal(result.flags.dependencies, true);
  }
});

test('mixed fixture is the understandable union of its profiles', () => {
  const result = classifyChangedFiles([
    file('docs/api.md'),
    file('apps/api/src/index.ts'),
    file('apps/web/src/main.ts'),
    file('contracts/openapi.gpt.yaml'),
    file('infra/main.bicep'),
  ]);
  assert.deepEqual(result.profiles, [
    'documentation-only',
    'api-backend',
    'frontend',
    'contracts-integrations',
    'infrastructure-delivery',
  ]);
  assert.equal(result.flags.privileged, false);
});

test('unknown, empty, malformed, and traversing inputs fail closed to privileged work', () => {
  for (const files of [
    [],
    [file('new-unclassified-area/value.txt')],
    [file('../escape.md')],
    [file('docs/new.md', 'renamed')],
    [{ filename: 'README.md', status: 'invented' }],
  ]) {
    const result = classifyChangedFiles(files);
    assert.equal(result.mode, 'broad-fallback');
    assert.equal(result.flags.privileged, true);
    assert.equal(result.flags.backend, true);
    assert.equal(result.flags.frontend, true);
    assert.equal(result.flags.codeqlActions, true);
  }
});

test('renames classify both old and new locations', () => {
  const result = classifyChangedFiles([
    file('docs/retired-api.md', 'renamed', { previous_filename: 'apps/api/src/retired.ts' }),
  ]);
  assert.deepEqual(result.profiles, ['documentation-only', 'api-backend']);
  assert.equal(result.flags.backend, true);
});

test('removed and renamed Function manifests retain privileged dependency coverage', () => {
  const removed = classifyChangedFiles([file('apps/api/package-lock.json', 'removed')]);
  assert.deepEqual(removed.profiles, ['privileged']);
  assert.equal(removed.flags.dependencies, true);

  const renamed = classifyChangedFiles([
    file('docs/retired-package-lock.json', 'renamed', {
      previous_filename: 'apps/api/package-lock.json',
    }),
  ]);
  assert.deepEqual(renamed.profiles, ['documentation-only', 'privileged']);
  assert.equal(renamed.flags.dependencies, true);
});

test('git name-status parsing preserves rename identity and rejects malformed status', () => {
  assert.deepEqual(parseGitNameStatus('M\0README.md\0R100\0apps/api/old.ts\0apps/api/new.ts\0'), [
    file('README.md'),
    file('apps/api/new.ts', 'renamed', { previous_filename: 'apps/api/old.ts' }),
  ]);
  assert.equal(parseGitNameStatus('U\0README.md\0'), null);
});

test('scheduled full validation is an explicit valid privileged classification', () => {
  const result = fullValidation('scheduled-complete-scan');
  assert.equal(result.valid, true);
  assert.equal(result.reason, 'scheduled-complete-scan');
  assert.equal(result.flags.privileged, true);
});
