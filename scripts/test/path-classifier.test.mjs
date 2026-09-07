import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChangedFiles, fullValidation, parseGitNameStatus } from '../lib/path-classifier.mjs';

const file = (filename, status = 'modified', extra = {}) => ({ filename, status, ...extra });

test('README files in sensitive control paths retain security scrutiny without runtime impact', () => {
  for (const filename of ['docs/security/README.md', 'docs/cost/README.md', '.github/actions/example/README.md']) {
    const { flags } = classifyChangedFiles([file(filename)]);
    assert.equal(flags.documentation, true);
    assert.equal(flags.privileged, true);
    assert.equal(flags.backend, false);
    assert.equal(flags.agentEnvironment, false);
    assert.equal(flags.operations, false);
  }
});

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
  assert.equal(validator.flags.agentEnvironment, false);
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

test('sensitive instruction paths receive policy scrutiny without unrelated behavior matrices', () => {
  for (const filename of [
    'AGENTS.md',
    '.github/AGENTS.md',
    '.agents/skills/example/SKILL.md',
    'docs/security/model.md',
  ]) {
    const result = classifyChangedFiles([file(filename)]);
    assert.deepEqual(result.profiles, ['documentation-only', 'privileged']);
    assert.equal(result.flags.documentation, true);
    assert.equal(result.flags.privileged, true);
    assert.equal(result.flags.codeqlJavascript, true);
    assert.equal(result.flags.codeqlActions, true);
    assert.equal(result.flags.trivy, true);
    for (const flag of [
      'backend',
      'frontend',
      'contracts',
      'infrastructure',
      'workflow',
      'dependencies',
      'operations',
      'agentEnvironment',
    ]) {
      assert.equal(result.flags[flag], false, `${filename}: ${flag}`);
    }
  }
});

test('README and scoped instructions do not inherit application impact from their directory', () => {
  const readme = classifyChangedFiles([file('apps/api/README.md')]);
  assert.deepEqual(readme.profiles, ['documentation-only']);
  assert.equal(readme.flags.backend, false);
  assert.equal(readme.flags.privileged, false);

  const instructions = classifyChangedFiles([file('apps/web/AGENTS.md')]);
  assert.deepEqual(instructions.profiles, ['documentation-only', 'privileged']);
  assert.equal(instructions.flags.frontend, false);
  assert.equal(instructions.flags.agentEnvironment, false);
});

test('workflow and dependency fixtures select only relevant behavior matrices', () => {
  const workflow = classifyChangedFiles([file('.github/workflows/security-gate.yml')]);
  assert.deepEqual(workflow.profiles, ['infrastructure-delivery', 'privileged']);
  assert.equal(workflow.flags.workflow, true);
  assert.equal(workflow.flags.agentEnvironment, false);
  for (const flag of ['backend', 'frontend', 'contracts', 'infrastructure', 'dependencies']) {
    assert.equal(workflow.flags[flag], false, flag);
  }

  const rootDependency = classifyChangedFiles([file('package-lock.json')]);
  assert.deepEqual(rootDependency.profiles, [
    'api-backend',
    'frontend',
    'operations',
    'agent-environment',
    'privileged',
  ]);
  assert.equal(rootDependency.flags.dependencies, true);
  assert.equal(rootDependency.flags.backend, true);
  assert.equal(rootDependency.flags.frontend, true);
  assert.equal(rootDependency.flags.operations, true);
  assert.equal(rootDependency.flags.agentEnvironment, true);
  assert.equal(rootDependency.flags.infrastructure, false);
  assert.equal(rootDependency.flags.workflow, false);

  const apiDependency = classifyChangedFiles([file('apps/api/package.json')]);
  assert.deepEqual(apiDependency.profiles, ['api-backend', 'privileged']);
  assert.equal(apiDependency.flags.dependencies, true);
  assert.equal(apiDependency.flags.backend, true);
  assert.equal(apiDependency.flags.frontend, false);
  assert.equal(apiDependency.flags.agentEnvironment, false);
});

test('executable repository operations select the operations suite without unrelated application jobs', () => {
  for (const filename of [
    'scripts/lib/deployment-impact.mjs',
    'scripts/generate-operation-docs.mjs',
    'scripts/test/ops-scripts.test.mjs',
  ]) {
    const result = classifyChangedFiles([file(filename)]);
    assert.deepEqual(result.profiles, ['operations', 'privileged']);
    assert.equal(result.flags.operations, true);
    assert.equal(result.flags.privileged, true);
    for (const flag of ['backend', 'frontend', 'contracts', 'infrastructure', 'workflow', 'dependencies']) {
      assert.equal(result.flags[flag], false, `${filename}: ${flag}`);
    }
  }
});

test('only local agent environment implementation and gate paths select the environment matrix', () => {
  for (const filename of [
    'scripts/agent-env/core.mjs',
    'scripts/setup-codex-env.sh',
    'scripts/maintain-codex-env.sh',
    'scripts/run-tests.mjs',
    'scripts/test/setup-codex-env.test.mjs',
    'scripts/test/maintain-codex-env.test.mjs',
    'scripts/test/run-tests.test.mjs',
    '.github/workflows/pr-gate.yml',
  ]) {
    const result = classifyChangedFiles([file(filename)]);
    assert.equal(result.flags.agentEnvironment, true, filename);
    assert.equal(result.flags.privileged, true, filename);
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
    assert.equal(result.flags.agentEnvironment, true);
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
  assert.deepEqual(removed.profiles, ['api-backend', 'privileged']);
  assert.equal(removed.flags.dependencies, true);

  const renamed = classifyChangedFiles([
    file('docs/retired-package-lock.json', 'renamed', {
      previous_filename: 'apps/api/package-lock.json',
    }),
  ]);
  assert.deepEqual(renamed.profiles, ['documentation-only', 'api-backend', 'privileged']);
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
  assert.equal(result.flags.agentEnvironment, true);
});
