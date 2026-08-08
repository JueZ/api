import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { generateArtifactIndex } from '../agent-learning/generate-index.mjs';
import {
  artifactStatusCounts,
  REPOSITORY_ROOT,
  validateArtifactRepository,
} from '../agent-learning/validate-artifacts.mjs';

const BROKEN_SHA = 'a'.repeat(40);
const FIXED_SHA = 'b'.repeat(40);
const AS_OF_DATE = '2026-08-08';

function validVerifiedArtifact(overrides = {}) {
  return {
    version: 1,
    id: 'example-learning',
    title: 'Example verified learning',
    fingerprint: 'delivery.workflow.identity',
    source: {
      type: 'repository_audit',
      references: [
        {
          kind: 'pull_request',
          locator: 'JueZ/api#123',
          url: 'https://github.com/JueZ/api/pull/123',
        },
      ],
    },
    classification: {
      failureArea: 'delivery',
      severity: 'high',
      symptom: 'The controller selected the wrong workflow run.',
      rootCause: 'Mutable display text was treated as immutable workflow identity.',
    },
    disposition: {
      primary: 'regression-test',
      rationale: 'An executable invariant prevents recurrence.',
    },
    artifacts: [{ path: 'scripts/prevent.mjs', kind: 'regression-test' }],
    counterfactual: {
      hypothesis: 'The trusted regression fails before the repair and passes after it.',
      broken: { commit: BROKEN_SHA, expectedResult: 'The trusted regression fails.' },
      fixed: { commit: FIXED_SHA, expectedResult: 'The trusted regression passes.' },
      verification: { commands: ['node scripts/prevent.mjs'] },
      implementationPr: {
        repository: 'JueZ/api',
        number: 123,
        url: 'https://github.com/JueZ/api/pull/123',
      },
    },
    status: 'verified',
    ...overrides,
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'agent-learning-'));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await mkdir(join(repositoryRoot, 'docs/agent-learning/artifacts'), { recursive: true });
  await mkdir(join(repositoryRoot, 'scripts'), { recursive: true });
  await writeFile(join(repositoryRoot, 'scripts/prevent.mjs'), 'export const prevented = true;\n');
  return repositoryRoot;
}

async function writeArtifact(repositoryRoot, fileName, artifact) {
  await writeFile(join(repositoryRoot, 'docs/agent-learning/artifacts', fileName), stringifyYaml(artifact));
}

function validateFixture(repositoryRoot) {
  return validateArtifactRepository({ repositoryRoot, asOfDate: AS_OF_DATE });
}

test('strict validator accepts a complete verified artifact', async (context) => {
  const repositoryRoot = await createFixture(context);
  await writeArtifact(repositoryRoot, 'example-learning.yml', validVerifiedArtifact());

  const result = validateFixture(repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(artifactStatusCounts(result.artifacts), {
    candidate: 0,
    implemented: 0,
    verified: 1,
    waived: 0,
    superseded: 0,
  });
});

test('malformed and unknown artifact fields fail closed', async (context) => {
  const repositoryRoot = await createFixture(context);
  const malformed = validVerifiedArtifact();
  delete malformed.version;
  malformed.rawLog = 'untrusted output';
  await writeArtifact(repositoryRoot, 'example-learning.yml', malformed);
  await writeFile(
    join(repositoryRoot, 'docs/agent-learning/artifacts', 'invalid.yml'),
    'version: 1\nid: duplicate\nid: duplicate\n',
  );

  const result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('.version: is required')));
  assert.ok(result.errors.some((error) => error.includes('.rawLog: is not an allowed field')));
  assert.ok(result.errors.some((error) => error.includes('invalid YAML')));
});

test('duplicate IDs are rejected even when stored in separate files', async (context) => {
  const repositoryRoot = await createFixture(context);
  await writeArtifact(repositoryRoot, 'example-learning.yml', validVerifiedArtifact());
  await writeArtifact(repositoryRoot, 'other-learning.yml', validVerifiedArtifact({ title: 'Duplicate ID' }));

  const result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('duplicates artifact ID example-learning')));
});

test('active recurrence fingerprints must be updated or explicitly superseded', async (context) => {
  const repositoryRoot = await createFixture(context);
  await writeArtifact(repositoryRoot, 'example-learning.yml', validVerifiedArtifact());
  await writeArtifact(
    repositoryRoot,
    'other-learning.yml',
    validVerifiedArtifact({ id: 'other-learning', title: 'Same recurrence mechanism' }),
  );

  let result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('duplicates active fingerprint delivery.workflow.identity')));

  const superseded = validVerifiedArtifact({
    id: 'example-learning',
    status: 'superseded',
    supersededBy: 'other-learning',
  });
  const replacement = validVerifiedArtifact({
    id: 'other-learning',
    title: 'Replacement learning',
    supersedes: ['example-learning'],
  });
  await writeArtifact(repositoryRoot, 'example-learning.yml', superseded);
  await writeArtifact(repositoryRoot, 'other-learning.yml', replacement);
  result = validateFixture(repositoryRoot);
  assert.deepEqual(result.errors, []);
});

test('artifact paths reject traversal and missing stale references', async (context) => {
  const repositoryRoot = await createFixture(context);
  const traversal = validVerifiedArtifact({
    artifacts: [{ path: '../outside.mjs', kind: 'regression-test' }],
  });
  await writeArtifact(repositoryRoot, 'example-learning.yml', traversal);

  let result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('without traversal')));

  traversal.artifacts[0].path = 'scripts/removed-prevention.mjs';
  await writeArtifact(repositoryRoot, 'example-learning.yml', traversal);
  result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('must reference an existing file')));
});

test('waivers require owned, current exception data and never count as verified proof', async (context) => {
  const repositoryRoot = await createFixture(context);
  const waived = validVerifiedArtifact({
    disposition: {
      primary: 'no-durable-artifact',
      rationale: 'The source was conclusively non-recurrent.',
    },
    artifacts: [],
    counterfactual: { hypothesis: 'A recurrence would invalidate this disposition.' },
    status: 'waived',
    exception: {
      rationale: 'No repository behavior can prevent the external event.',
      owner: 'repository-maintainers',
      reviewDate: '2026-09-01',
      recurrenceFingerprint: 'delivery.workflow.identity',
    },
  });
  await writeArtifact(repositoryRoot, 'example-learning.yml', waived);

  let result = validateFixture(repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(artifactStatusCounts(result.artifacts).verified, 0);
  assert.equal(artifactStatusCounts(result.artifacts).waived, 1);

  waived.exception.reviewDate = '2026-08-07';
  await writeArtifact(repositoryRoot, 'example-learning.yml', waived);
  result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('is stale relative to 2026-08-08')));

  waived.exception.reviewDate = '2026-02-31';
  await writeArtifact(repositoryRoot, 'example-learning.yml', waived);
  result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('must be a valid YYYY-MM-DD date')));

  delete waived.exception.owner;
  await writeArtifact(repositoryRoot, 'example-learning.yml', waived);
  result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('.exception.owner: is required')));
});

test('external-transient dispositions require the same owned recurrence exception', async (context) => {
  const repositoryRoot = await createFixture(context);
  const transient = validVerifiedArtifact({
    disposition: {
      primary: 'external-transient',
      rationale: 'The failure originated outside the repository boundary.',
    },
    artifacts: [],
    counterfactual: { hypothesis: 'A recurrence would reopen durable-prevention analysis.' },
    status: 'candidate',
    exception: {
      rationale: 'Provider availability recovered without a repository behavior change.',
      owner: 'repository-maintainers',
      expiry: '2026-09-01',
      recurrenceFingerprint: 'delivery.workflow.identity',
    },
  });
  await writeArtifact(repositoryRoot, 'example-learning.yml', transient);
  assert.deepEqual(validateFixture(repositoryRoot).errors, []);

  delete transient.exception;
  await writeArtifact(repositoryRoot, 'example-learning.yml', transient);
  assert.ok(validateFixture(repositoryRoot).errors.some((error) => error.includes('.exception: is required')));
});

test('verified artifacts require exact counterfactual references and implementation PR evidence', async (context) => {
  const repositoryRoot = await createFixture(context);
  const artifact = validVerifiedArtifact();
  artifact.counterfactual.broken.commit = 'main';
  artifact.counterfactual.fixed.commit = 'main';
  artifact.counterfactual.implementationPr.url = 'https://example.com/JueZ/api/pull/123';
  delete artifact.counterfactual.verification;
  await writeArtifact(repositoryRoot, 'example-learning.yml', artifact);

  const result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('exact 40-character lowercase SHA')));
  assert.ok(result.errors.some((error) => error.includes('broken and fixed commits must be different')));
  assert.ok(result.errors.some((error) => error.includes('.verification: is required for verified status')));
  assert.ok(result.errors.some((error) => error.includes('declared GitHub implementation pull request')));

  delete artifact.counterfactual.implementationPr;
  await writeArtifact(repositoryRoot, 'example-learning.yml', artifact);
  assert.ok(
    validateFixture(repositoryRoot).errors.some((error) =>
      error.includes('.implementationPr: is required for verified status'),
    ),
  );
});

test('secret-shaped content and raw environment dumps are rejected', async (context) => {
  const repositoryRoot = await createFixture(context);
  const artifact = validVerifiedArtifact();
  artifact.classification.symptom = [
    ['GITHUB_TOKEN', 'synthetic-token-shaped-fixture'].join('='),
    ['OPENAI_API_KEY', 'synthetic-provider-shaped-fixture'].join('='),
  ].join('\n');
  await writeArtifact(repositoryRoot, 'example-learning.yml', artifact);

  const result = validateFixture(repositoryRoot);
  assert.ok(result.errors.some((error) => error.includes('secret-shaped value')));
  assert.ok(result.errors.some((error) => error.includes('raw environment dump')));
});

test('generated index is deterministic and sorted by artifact ID', async (context) => {
  const repositoryRoot = await createFixture(context);
  const second = validVerifiedArtifact({
    id: 'zeta-learning',
    title: 'Zeta learning',
    fingerprint: 'delivery.workflow.zeta',
  });
  await writeArtifact(repositoryRoot, 'zeta-learning.yml', second);
  await writeArtifact(repositoryRoot, 'example-learning.yml', validVerifiedArtifact());

  const options = { repositoryRoot, asOfDate: AS_OF_DATE };
  const firstRender = generateArtifactIndex(options);
  const secondRender = generateArtifactIndex(options);
  assert.equal(firstRender, secondRender);
  assert.ok(firstRender.indexOf('[example-learning]') < firstRender.indexOf('[zeta-learning]'));
  assert.doesNotMatch(firstRender, /Generated at|2026-08-08/);
});

test('policy alias remains compatible and reserved task aliases fail closed', () => {
  const packageDefinition = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageDefinition.scripts['eval:agent-policy'], packageDefinition.scripts['eval:agents']);
  assert.equal(
    packageDefinition.scripts['eval:agent-tasks:validate'],
    'node scripts/agent-task-evals/unavailable.mjs validate',
  );

  const result = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, 'scripts/agent-task-evals/unavailable.mjs'), 'validate'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unavailable until Phase 4/);
  assert.match(result.stderr, /blocked, not passing/);
});
