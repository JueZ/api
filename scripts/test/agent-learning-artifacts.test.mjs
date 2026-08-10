import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { generateArtifactIndex } from '../agent-learning/generate-index.mjs';
import {
  findSecretLikeValue,
  loadLearningArtifacts,
  validateLearningArtifact,
} from '../agent-learning/validate-artifacts.mjs';

const BROKEN_SHA = 'a'.repeat(40);
const FIXED_SHA = 'b'.repeat(40);

function validArtifact(overrides = {}) {
  return {
    version: 2,
    id: 'example-learning',
    fingerprint: 'delivery.workflow.identity',
    severity: 'high',
    invariant: 'Trusted automation binds workflow behavior to immutable path and exact source identity.',
    scope: ['.github/workflows/**'],
    prevention: [{ kind: 'regression-test', path: 'scripts/prevent.mjs' }],
    broken: BROKEN_SHA,
    fixed: FIXED_SHA,
    repairPr: 123,
    recurrenceCount: 1,
    status: 'verified',
    ...overrides,
  };
}

async function fixture(context) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'learning-v2-'));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const artifactDirectory = join(repositoryRoot, 'docs/agent-learning/artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(join(repositoryRoot, 'scripts'), { recursive: true });
  await writeFile(join(repositoryRoot, 'scripts/prevent.mjs'), 'export const prevented = true;\n');
  return { repositoryRoot, artifactDirectory };
}

async function writeArtifact(directory, name, artifact) {
  await writeFile(join(directory, name), stringifyYaml(artifact));
}

test('concise schema accepts an executable verified invariant', async (context) => {
  const { repositoryRoot } = await fixture(context);
  assert.deepEqual(validateLearningArtifact(validArtifact(), { filename: 'example-learning.yml', repositoryRoot }), []);
});

test('unknown fields, malformed identity, and missing verified provenance fail closed', async (context) => {
  const { repositoryRoot } = await fixture(context);
  const artifact = validArtifact({ rawLog: 'not allowed', broken: 'main', repairPr: 0 });
  const errors = validateLearningArtifact(artifact, { filename: 'wrong-file.yml', repositoryRoot });
  assert.ok(errors.some((error) => error.includes('unknown field')));
  assert.ok(errors.some((error) => error.includes('file name')));
  assert.ok(errors.some((error) => error.includes('broken must be an exact SHA')));
  assert.ok(errors.some((error) => error.includes('require repairPr')));
});

test('prevention paths reject traversal and stale references', async (context) => {
  const { repositoryRoot } = await fixture(context);
  let errors = validateLearningArtifact(
    validArtifact({ prevention: [{ kind: 'regression-test', path: '../escape.mjs' }] }),
    { filename: 'example-learning.yml', repositoryRoot },
  );
  assert.ok(errors.some((error) => error.includes('path is invalid')));

  errors = validateLearningArtifact(
    validArtifact({ prevention: [{ kind: 'regression-test', path: 'scripts/missing.mjs' }] }),
    { filename: 'example-learning.yml', repositoryRoot },
  );
  assert.ok(errors.some((error) => error.includes('does not exist')));
});

test('secret-shaped values are rejected without retaining their content', async (context) => {
  const { repositoryRoot } = await fixture(context);
  const secretValue = ['github_pat_', 'synthetic123456789'].join('');
  const artifact = validArtifact({ invariant: `Never persist ${secretValue} in learning.` });
  const errors = validateLearningArtifact(artifact, { filename: 'example-learning.yml', repositoryRoot });
  assert.ok(errors.some((error) => error.includes('secret-shaped')));
  assert.equal(findSecretLikeValue(artifact), 'artifact.invariant');
  assert.ok(errors.every((error) => !error.includes(secretValue)));
});

test('verified and superseded states require exact compact identities', async (context) => {
  const { repositoryRoot } = await fixture(context);
  const missingProof = validArtifact({ status: 'verified', broken: undefined, fixed: undefined, repairPr: undefined });
  assert.ok(
    validateLearningArtifact(missingProof, { filename: 'example-learning.yml', repositoryRoot }).filter((error) =>
      error.includes('verified artifacts require'),
    ).length >= 3,
  );

  const superseded = validArtifact({
    status: 'superseded',
    broken: undefined,
    fixed: undefined,
    repairPr: undefined,
    supersededBy: 'replacement-learning',
  });
  assert.deepEqual(validateLearningArtifact(superseded, { filename: 'example-learning.yml', repositoryRoot }), []);
});

test('repository loader rejects duplicate fingerprints and duplicate YAML keys', async (context) => {
  const { repositoryRoot, artifactDirectory } = await fixture(context);
  await writeArtifact(artifactDirectory, 'example-learning.yml', validArtifact());
  await writeArtifact(
    artifactDirectory,
    'second-learning.yml',
    validArtifact({ id: 'second-learning', fingerprint: 'delivery.workflow.identity' }),
  );
  await writeFile(join(artifactDirectory, 'invalid.yml'), 'version: 2\nid: invalid\nid: duplicate\n');
  const result = loadLearningArtifacts({ artifactDirectory, repositoryRoot });
  assert.ok(result.errors.some((error) => error.includes('duplicate fingerprint')));
  assert.ok(result.errors.some((error) => error.includes('invalid YAML')));
});

test('generated index is deterministic, sorted, and contains no execution ledger', () => {
  const records = [
    { artifact: validArtifact({ id: 'zeta-learning', fingerprint: 'delivery.workflow.zeta' }) },
    { artifact: validArtifact() },
  ];
  const first = generateArtifactIndex(records);
  const second = generateArtifactIndex(records);
  assert.equal(first, second);
  assert.ok(first.indexOf('[example-learning]') < first.indexOf('[zeta-learning]'));
  assert.doesNotMatch(first, /workflow run|Generated at|timestamp/i);
});
