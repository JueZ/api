import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  classifyDeploymentImpact,
  loadAutonomousPolicy,
  RUNTIME_NEUTRAL_DEPLOYMENT_PATHS,
  validateAutonomousPolicy,
} from '../lib/autonomous-policy.mjs';
import { classifyDeploymentGitRange, classifyDeploymentImpactFile } from '../classify-deployment-impact.mjs';

const file = (filename, status = 'modified', extra = {}) => ({ filename, status, ...extra });
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../..');

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
  assert.equal(
    classifyDeploymentImpact([file('scripts/agent-learning/validate-artifacts.mjs')]).deploymentRequired,
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

test('delivery classifier runs in a dependency-free trusted checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-free-deployment-impact-'));
  try {
    await mkdir(join(directory, 'scripts/lib'), { recursive: true });
    await Promise.all([
      copyFile(
        join(repositoryRoot, 'scripts/classify-deployment-impact.mjs'),
        join(directory, 'scripts/classify-deployment-impact.mjs'),
      ),
      copyFile(
        join(repositoryRoot, 'scripts/lib/deployment-impact.mjs'),
        join(directory, 'scripts/lib/deployment-impact.mjs'),
      ),
      copyFile(
        join(repositoryRoot, 'scripts/lib/path-classifier.mjs'),
        join(directory, 'scripts/lib/path-classifier.mjs'),
      ),
    ]);
    const path = join(directory, 'files.json');
    await writeFile(path, JSON.stringify([file('docs/project-memory/current-state.md')]));

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(directory, 'scripts/classify-deployment-impact.mjs'), path],
      { cwd: directory, env: {}, timeout: 5_000 },
    );
    assert.equal(JSON.parse(stdout).reason, 'runtime-neutral-only');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('protected-main git ranges classify runtime-neutral and deployment-impacting commits without API metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'main-deployment-impact-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    await writeFile(join(directory, 'README.md'), '# Baseline\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: directory });
    await execFileAsync('git', ['commit', '-q', '-m', 'baseline'], { cwd: directory });
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();

    await mkdir(join(directory, 'docs'));
    await writeFile(join(directory, 'docs', 'change.md'), '# Documentation\n');
    await execFileAsync('git', ['add', 'docs/change.md'], { cwd: directory });
    await execFileAsync('git', ['commit', '-q', '-m', 'docs'], { cwd: directory });
    const docsHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
    assert.equal(classifyDeploymentGitRange(base, docsHead, directory).deploymentRequired, false);

    await mkdir(join(directory, 'apps/api/src'), { recursive: true });
    await writeFile(join(directory, 'apps/api/src/index.ts'), 'export {};\n');
    await execFileAsync('git', ['add', 'apps/api/src/index.ts'], { cwd: directory });
    await execFileAsync('git', ['commit', '-q', '-m', 'api'], { cwd: directory });
    const apiHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
    assert.equal(classifyDeploymentGitRange(docsHead, apiHead, directory).deploymentRequired, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
