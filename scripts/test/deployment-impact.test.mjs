import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyDeploymentImpact,
  loadAutonomousPolicy,
  RUNTIME_NEUTRAL_DEPLOYMENT_PATHS,
  validateAutonomousPolicy,
} from '../lib/autonomous-policy.mjs';
import { classifyDeploymentImpactFile } from '../classify-deployment-impact.mjs';

const file = (filename, status = 'modified', extra = {}) => ({ filename, status, ...extra });

test('runtime-neutral deployment paths are exact protected policy', () => {
  const policy = loadAutonomousPolicy();
  assert.deepEqual(policy.deployment.runtimeNeutralPaths, [...RUNTIME_NEUTRAL_DEPLOYMENT_PATHS]);
  assert.deepEqual(validateAutonomousPolicy(policy), []);
  assert.match(
    validateAutonomousPolicy({
      ...policy,
      deployment: { ...policy.deployment, runtimeNeutralPaths: [...RUNTIME_NEUTRAL_DEPLOYMENT_PATHS, 'apps/**'] },
    }).join('\n'),
    /runtimeNeutralPaths must contain exactly/,
  );
});

test('documentation, scoped instruction, and non-shipped agent-governance changes skip environment deployment', () => {
  assert.deepEqual(classifyDeploymentImpact([file('README.md'), file('docs/project-memory/next-steps.md')]), {
    valid: true,
    deploymentRequired: false,
    reason: 'runtime-neutral-only',
    fileCount: 2,
    pathCount: 2,
    impactPathCount: 0,
  });
  assert.equal(classifyDeploymentImpact([file('.github/AGENTS.md')]).deploymentRequired, false);
  assert.equal(classifyDeploymentImpact([file('.agents/skills/example/SKILL.md')]).deploymentRequired, false);
  assert.equal(classifyDeploymentImpact([file('evals/agent-tasks/example.yml')]).deploymentRequired, false);
  assert.equal(classifyDeploymentImpact([file('scripts/agent-learning/status-report.mjs')]).deploymentRequired, false);
  assert.equal(
    classifyDeploymentImpact([file('scripts/agent-task-evals/scorers/example.mjs')]).deploymentRequired,
    false,
  );
  assert.equal(
    classifyDeploymentImpact([file('scripts/test/agent-learning-memory.test.mjs')]).deploymentRequired,
    false,
  );
});

test('code, workflow, policy, infrastructure, contract, and mixed changes still deploy', () => {
  for (const filename of [
    'apps/api/src/index.ts',
    '.github/workflows/ci.yml',
    '.github/autonomous-policy.yml',
    'infra/main.bicep',
    'contracts/openapi.yaml',
    'package.json',
    'scripts/example.mjs',
    'scripts/triage-repair-issues.mjs',
  ]) {
    assert.equal(classifyDeploymentImpact([file(filename)]).deploymentRequired, true, filename);
  }
  assert.equal(
    classifyDeploymentImpact([file('docs/project-memory/current-state.md'), file('apps/web/src/main.ts')])
      .deploymentRequired,
    true,
  );
});

test('renames consider both old and new paths', () => {
  assert.equal(
    classifyDeploymentImpact([file('docs/new-name.md', 'renamed', { previous_filename: 'docs/old-name.md' })])
      .deploymentRequired,
    false,
  );
  assert.equal(
    classifyDeploymentImpact([
      file('docs/archived-code.md', 'renamed', { previous_filename: 'apps/api/src/removed.ts' }),
    ]).deploymentRequired,
    true,
  );
});

test('missing, malformed, duplicated, and traversing file metadata fails closed to deployment', () => {
  for (const files of [
    [],
    [file('../docs/escape.md')],
    [file('/docs/absolute.md')],
    [file('docs\\windows.md')],
    [file('docs/duplicate.md'), file('docs/duplicate.md')],
    [file('docs/new.md', 'renamed')],
    [file('docs/file.md', 'modified', { previous_filename: 'docs/old.md' })],
    [{ filename: 'docs/file.md', status: 'invented' }],
  ]) {
    const result = classifyDeploymentImpact(files);
    assert.equal(result.valid, false);
    assert.equal(result.deploymentRequired, true);
  }
});

test('fixed classifier script reads only the supplied JSON file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-impact-test-'));
  try {
    const path = join(directory, 'files.json');
    await writeFile(path, JSON.stringify([file('docs/project-memory/current-state.md')]));
    assert.equal((await classifyDeploymentImpactFile(path)).deploymentRequired, false);
    await writeFile(path, JSON.stringify([file('apps/api/src/index.ts')]));
    assert.equal((await classifyDeploymentImpactFile(path)).deploymentRequired, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
