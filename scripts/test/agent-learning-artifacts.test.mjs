import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  deriveReusableClaimState,
  generateArtifactIndex,
  summarizeReusableClaims,
} from '../agent-learning/generate-index.mjs';
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
    prevention: [{ kind: 'regression-test', path: 'scripts/prevent.test.mjs' }],
    broken: BROKEN_SHA,
    fixed: FIXED_SHA,
    repairPr: 123,
    recurrenceCount: 1,
    status: 'verified',
    ...overrides,
  };
}

function validReusableClaim(overrides = {}) {
  const base = {
    id: 'adaptive-repair-guidance',
    claim: 'Repeated repair evidence is grouped by causal lineage rather than by the number of agent restatements.',
    scope: {
      paths: ['scripts/**'],
      components: ['autonomous repair'],
      conditions: ['a repair strategy produces no material progress'],
    },
    relation: 'supports',
    evidence: {
      kind: 'authoritative-requirement',
      source: 'owner-requirement:adaptive-repair-guidance',
      independence: 'independent',
    },
    lineageId: 'repair.strategy.no-progress',
    independenceBasis:
      'This record represents one owner requirement and repeated restatements remain in the same lineage.',
    applicability:
      'Autonomous repository repair after a concrete strategy fails without changing the observed failure.',
    exceptions: [],
    challenge: { state: 'none', severity: 'low' },
    enforcement: { kind: 'none' },
    supersedes: [],
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...overrides.scope },
    evidence: { ...base.evidence, ...overrides.evidence },
    challenge: { ...base.challenge, ...overrides.challenge },
    enforcement: { ...base.enforcement, ...overrides.enforcement },
  };
}

function reusableClaimRecord(claimOverrides = {}, artifactOverrides = {}) {
  return {
    artifact: validArtifact({
      ...artifactOverrides,
      reusableClaim: validReusableClaim(claimOverrides),
    }),
  };
}

async function fixture(context) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'learning-v2-'));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const artifactDirectory = join(repositoryRoot, 'docs/agent-learning/artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(join(repositoryRoot, 'scripts'), { recursive: true });
  await mkdir(join(repositoryRoot, 'docs'), { recursive: true });
  await mkdir(join(repositoryRoot, 'contracts'), { recursive: true });
  await mkdir(join(repositoryRoot, '.github/workflows'), { recursive: true });
  await writeFile(join(repositoryRoot, 'scripts/prevent.test.mjs'), 'export const prevented = true;\n');
  await writeFile(join(repositoryRoot, 'scripts/policy-guardrails.mjs'), 'export const policy = true;\n');
  await writeFile(join(repositoryRoot, 'scripts/runtime-truth.mjs'), 'export const runtimeTruth = true;\n');
  await writeFile(join(repositoryRoot, 'contracts/example.yaml'), 'openapi: 3.1.0\n');
  await writeFile(join(repositoryRoot, '.github/workflows/example.yml'), 'name: Example\n');
  await writeFile(join(repositoryRoot, 'docs/learning.md'), '# Prose only\n');
  return { repositoryRoot, artifactDirectory };
}

async function writeArtifact(directory, name, artifact) {
  await writeFile(join(directory, name), stringifyYaml(artifact));
}

test('concise schema accepts an executable verified invariant', async (context) => {
  const { repositoryRoot } = await fixture(context);
  assert.deepEqual(validateLearningArtifact(validArtifact(), { filename: 'example-learning.yml', repositoryRoot }), []);
});

test('schema v2 remains backward compatible and accepts an optional reusable claim', async (context) => {
  const { repositoryRoot } = await fixture(context);
  assert.deepEqual(validateLearningArtifact(validArtifact(), { filename: 'example-learning.yml', repositoryRoot }), []);
  const reusableClaim = validReusableClaim({
    reviewAfter: '2000-01-01',
    enforcement: { kind: 'test', reference: 'scripts/prevent.test.mjs' },
  });
  assert.deepEqual(
    validateLearningArtifact(validArtifact({ reusableClaim }), { filename: 'example-learning.yml', repositoryRoot }),
    [],
  );
});

test('reusable claims reject unknown fields and enforcement without an existing prevention reference', async (context) => {
  const { repositoryRoot } = await fixture(context);
  const reusableClaim = validReusableClaim({
    confidence: 0.99,
    enforcement: { kind: 'policy', reference: 'scripts/missing.mjs' },
  });
  const errors = validateLearningArtifact(validArtifact({ reusableClaim }), {
    filename: 'example-learning.yml',
    repositoryRoot,
  });
  assert.ok(errors.some((error) => error.includes('unknown field: confidence')));
  assert.ok(errors.some((error) => error.includes('reference does not exist')));
  assert.ok(errors.some((error) => error.includes('must match an existing prevention path')));
});

test('reusable claims cannot claim executable enforcement through prose', async (context) => {
  const { repositoryRoot } = await fixture(context);
  const reusableClaim = validReusableClaim({
    enforcement: { kind: 'test', reference: 'docs/learning.md' },
  });
  const errors = validateLearningArtifact(
    validArtifact({
      prevention: [
        { kind: 'regression-test', path: 'scripts/prevent.test.mjs' },
        { kind: 'architecture', path: 'docs/learning.md' },
      ],
      reusableClaim,
    }),
    { filename: 'example-learning.yml', repositoryRoot },
  );
  assert.ok(errors.some((error) => error.includes('executable prevention path')));
  assert.ok(errors.some((error) => error.includes('cannot reference prose')));
  assert.ok(errors.some((error) => error.includes('must reference a test file')));
});

test('enforcement kinds must match their executable carrier and prevention kind', async (context) => {
  const { repositoryRoot } = await fixture(context);
  const validCases = [
    ['test', 'regression-test', 'scripts/prevent.test.mjs'],
    ['contract', 'deterministic-guard', 'contracts/example.yaml'],
    ['policy', 'deterministic-guard', 'scripts/policy-guardrails.mjs'],
    ['workflow', 'deterministic-guard', '.github/workflows/example.yml'],
    ['runtime-check', 'deterministic-guard', 'scripts/runtime-truth.mjs'],
  ];
  for (const [kind, preventionKind, reference] of validCases) {
    const artifact = validArtifact({
      prevention: [{ kind: preventionKind, path: reference }],
      reusableClaim: validReusableClaim({ enforcement: { kind, reference } }),
    });
    assert.deepEqual(
      validateLearningArtifact(artifact, { filename: 'example-learning.yml', repositoryRoot }),
      [],
      `${kind} should accept its matching carrier`,
    );
  }

  const mismatched = validArtifact({
    reusableClaim: validReusableClaim({
      enforcement: { kind: 'runtime-check', reference: 'scripts/prevent.test.mjs' },
    }),
  });
  const errors = validateLearningArtifact(mismatched, {
    filename: 'example-learning.yml',
    repositoryRoot,
  });
  assert.ok(errors.some((error) => error.includes('requires a deterministic-guard prevention entry')));
  assert.ok(errors.some((error) => error.includes('must reference a runtime')));
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

test('one exact evidence source cannot manufacture independent lineages', async (context) => {
  const { repositoryRoot, artifactDirectory } = await fixture(context);
  await writeArtifact(
    artifactDirectory,
    'example-learning.yml',
    validArtifact({ reusableClaim: validReusableClaim() }),
  );
  await writeArtifact(
    artifactDirectory,
    'second-learning.yml',
    validArtifact({
      id: 'second-learning',
      fingerprint: 'delivery.workflow.second-identity',
      reusableClaim: validReusableClaim({ lineageId: 'repair.strategy.allegedly-independent' }),
    }),
  );
  const result = loadLearningArtifacts({ artifactDirectory, repositoryRoot });
  assert.ok(result.errors.some((error) => error.includes('is assigned to lineage')));
});

test('copied reviews must retain one declared source lineage', async (context) => {
  const { repositoryRoot, artifactDirectory } = await fixture(context);
  await writeArtifact(
    artifactDirectory,
    'example-learning.yml',
    validArtifact({
      reusableClaim: validReusableClaim({
        evidence: {
          kind: 'specialist-review',
          source: 'review:copy-one',
          independence: 'shared-lineage',
          derivedFrom: 'review:original-source',
        },
        lineageId: 'review.original-source',
      }),
    }),
  );
  await writeArtifact(
    artifactDirectory,
    'second-learning.yml',
    validArtifact({
      id: 'second-learning',
      fingerprint: 'delivery.workflow.second-identity',
      reusableClaim: validReusableClaim({
        evidence: {
          kind: 'specialist-review',
          source: 'review:copy-two',
          independence: 'shared-lineage',
          derivedFrom: 'review:original-source',
        },
        lineageId: 'review.invented-independent-lineage',
      }),
    }),
  );
  const result = loadLearningArtifacts({ artifactDirectory, repositoryRoot });
  assert.ok(result.errors.some((error) => error.includes('review:original-source is assigned to lineage')));
});

test('qualitative reusable-claim states deduplicate lineage and exclude code prevalence', () => {
  const repeatedLineage = [
    reusableClaimRecord(),
    reusableClaimRecord({
      evidence: {
        kind: 'specialist-review',
        source: 'review:copied-restatement',
        independence: 'shared-lineage',
        derivedFrom: 'owner-requirement:adaptive-repair-guidance',
      },
    }),
  ];
  assert.equal(deriveReusableClaimState(repeatedLineage), 'candidate');

  const codePrecedent = [
    reusableClaimRecord({
      evidence: { kind: 'code-precedent', source: 'code:occurrence-one' },
      lineageId: 'code.occurrence.one',
    }),
    reusableClaimRecord({
      evidence: { kind: 'code-precedent', source: 'code:occurrence-two' },
      lineageId: 'code.occurrence.two',
    }),
  ];
  assert.equal(deriveReusableClaimState(codePrecedent), 'candidate');

  const independentEvidence = [
    reusableClaimRecord(),
    reusableClaimRecord({
      evidence: { kind: 'deterministic-reproduction', source: 'test:independent-reproduction' },
      lineageId: 'repair.strategy.deterministic-reproduction',
      independenceBasis: 'A deterministic reproduction observes the behavior independently from the owner requirement.',
    }),
  ];
  assert.equal(deriveReusableClaimState(independentEvidence), 'corroborated');
});

test('deterministic counterevidence dominates advisory agreement without a vote', () => {
  const entries = [
    reusableClaimRecord(),
    reusableClaimRecord({
      evidence: { kind: 'specialist-review', source: 'review:independent-one' },
      lineageId: 'review.independent.one',
      independenceBasis: 'The specialist inspected a separate bounded source before recording an advisory conclusion.',
    }),
    reusableClaimRecord({
      relation: 'refutes',
      evidence: { kind: 'runtime-observation', source: 'runtime:counterexample-one' },
      lineageId: 'runtime.counterexample.one',
      independenceBasis: 'The runtime observation directly contradicts the claim in its declared scope.',
    }),
  ];
  assert.equal(deriveReusableClaimState(entries), 'challenged');
});

test('resolved counterevidence and accepted scoped exceptions do not remain unresolved challenges', () => {
  const resolved = reusableClaimRecord({
    relation: 'bounds',
    evidence: { kind: 'deterministic-reproduction', source: 'test:resolved-bound' },
    lineageId: 'test.resolved-bound',
    challenge: {
      state: 'resolved',
      severity: 'high',
      summary: 'The original claim was narrowed to exclude the deterministically reproduced counterexample.',
    },
  });
  assert.equal(deriveReusableClaimState([resolved]), 'candidate');

  const acceptedException = reusableClaimRecord({
    relation: 'refutes',
    evidence: { kind: 'runtime-observation', source: 'runtime:accepted-exception' },
    lineageId: 'runtime.accepted-exception',
    exceptions: [
      {
        scope: 'The bounded legacy migration path only.',
        rationale: 'Runtime evidence proves the general claim does not apply during this migration.',
      },
    ],
    challenge: {
      state: 'accepted-exception',
      severity: 'high',
      summary: 'The runtime counterexample is retained as a scoped accepted exception.',
    },
  });
  assert.equal(deriveReusableClaimState([acceptedException]), 'candidate');
});

test('enforced, superseded, and retired reusable-claim states are derived rather than stored', () => {
  assert.equal(
    deriveReusableClaimState([
      reusableClaimRecord({ enforcement: { kind: 'test', reference: 'scripts/prevent.test.mjs' } }),
    ]),
    'enforced',
  );
  assert.equal(
    deriveReusableClaimState([reusableClaimRecord({}, { status: 'superseded', supersededBy: 'replacement-learning' })]),
    'superseded',
  );
  assert.equal(
    deriveReusableClaimState([
      reusableClaimRecord({
        retired: { reason: 'The bounded behavior no longer exists in the supported repository architecture.' },
      }),
    ]),
    'retired',
  );
});

test('a later retirement disposition can close a stable claim without rewriting earlier evidence', async (context) => {
  const { repositoryRoot, artifactDirectory } = await fixture(context);
  await writeArtifact(
    artifactDirectory,
    'example-learning.yml',
    validArtifact({ reusableClaim: validReusableClaim() }),
  );
  await writeArtifact(
    artifactDirectory,
    'retirement-learning.yml',
    validArtifact({
      id: 'retirement-learning',
      fingerprint: 'delivery.workflow.retirement-disposition',
      reusableClaim: validReusableClaim({
        evidence: { kind: 'runtime-observation', source: 'runtime:retirement-observation' },
        lineageId: 'runtime.retirement-observation',
        independenceBasis: 'A later runtime observation proves that the bounded behavior no longer exists.',
        retired: { reason: 'The bounded behavior no longer exists in the supported repository architecture.' },
      }),
    }),
  );
  const result = loadLearningArtifacts({ artifactDirectory, repositoryRoot });
  assert.ok(!result.errors.some((error) => error.includes('conflicts with its definition')));
  const claim = summarizeReusableClaims(result.records).find(({ id }) => id === 'adaptive-repair-guidance');
  assert.equal(claim?.state, 'retired');
});

test('claim supersession references must stay inside the canonical learning collection', async (context) => {
  const { repositoryRoot, artifactDirectory } = await fixture(context);
  await writeArtifact(
    artifactDirectory,
    'example-learning.yml',
    validArtifact({ reusableClaim: validReusableClaim({ relation: 'supersedes', supersedes: ['missing-claim'] }) }),
  );
  const result = loadLearningArtifacts({ artifactDirectory, repositoryRoot });
  assert.ok(result.errors.some((error) => error.includes('references unknown claim missing-claim')));
});

test('claim-level supersession replaces the old navigation state while retaining both claims', () => {
  const oldClaim = reusableClaimRecord({ id: 'old-guidance' });
  const replacement = reusableClaimRecord({
    id: 'bounded-guidance',
    claim: 'Repair guidance applies only while its declared causal and repository scope remains unchanged.',
    relation: 'supersedes',
    evidence: {
      kind: 'deterministic-reproduction',
      source: 'test:bounded-guidance',
      independence: 'independent',
    },
    lineageId: 'repair.guidance.bounded-replacement',
    independenceBasis: 'A deterministic counterexample independently proved the earlier scope was too broad.',
    applicability: 'Repair guidance for the narrower causal and repository scope exercised by the test.',
    supersedes: ['old-guidance'],
  });
  assert.deepEqual(
    summarizeReusableClaims([oldClaim, replacement]).map(({ id, state }) => ({ id, state })),
    [
      { id: 'bounded-guidance', state: 'candidate' },
      { id: 'old-guidance', state: 'superseded' },
    ],
  );
});

test('claim supersession cycles fail validation instead of retiring every claim', async (context) => {
  const { repositoryRoot, artifactDirectory } = await fixture(context);
  await writeArtifact(
    artifactDirectory,
    'first-learning.yml',
    validArtifact({
      id: 'first-learning',
      fingerprint: 'delivery.workflow.first-supersession',
      reusableClaim: validReusableClaim({
        id: 'claim-a',
        relation: 'supersedes',
        evidence: { source: 'test:claim-a-supersession' },
        lineageId: 'claim.a.supersession',
        supersedes: ['claim-b'],
      }),
    }),
  );
  await writeArtifact(
    artifactDirectory,
    'second-learning.yml',
    validArtifact({
      id: 'second-learning',
      fingerprint: 'delivery.workflow.second-supersession',
      reusableClaim: validReusableClaim({
        id: 'claim-b',
        relation: 'supersedes',
        evidence: { source: 'test:claim-b-supersession' },
        lineageId: 'claim.b.supersession',
        supersedes: ['claim-a'],
      }),
    }),
  );
  const result = loadLearningArtifacts({ artifactDirectory, repositoryRoot });
  assert.ok(result.errors.some((error) => error.includes('supersession cycle is forbidden')));
});

test('generated index is deterministic, sorted, and contains no execution ledger', () => {
  const records = [
    { artifact: validArtifact({ id: 'zeta-learning', fingerprint: 'delivery.workflow.zeta' }) },
    reusableClaimRecord(),
  ];
  const first = generateArtifactIndex(records);
  const second = generateArtifactIndex(records);
  assert.equal(first, second);
  assert.ok(first.indexOf('[example-learning]') < first.indexOf('[zeta-learning]'));
  assert.doesNotMatch(first, /workflow run|Generated at|timestamp/i);
  assert.match(first, /## Reusable claims/);
  assert.match(first, /candidate/);
  assert.doesNotMatch(first, /confidence|vote|evidence count/i);
  assert.deepEqual(
    summarizeReusableClaims(records).map(({ id, state }) => ({ id, state })),
    [{ id: 'adaptive-repair-guidance', state: 'candidate' }],
  );
});

test('task continuation artifact keeps action exhaustion distinct from diagnosis and completion', () => {
  const result = loadLearningArtifacts();
  assert.deepEqual(result.errors, []);
  const record = result.records.find(({ artifact }) => artifact.id === 'autonomous-repair-strategy-continuation');
  assert.ok(record);
  assert.match(record.artifact.invariant, /without disproving a supported diagnosis/);
  assert.match(record.artifact.invariant, /cosmetic metadata never resets the budget/);
  assert.match(record.artifact.reusableClaim.claim, /do(?:es)? not end the autonomous task/i);
  assert.equal(record.artifact.reusableClaim.enforcement.reference, 'scripts/test/agent-learning-triage.test.mjs');
  assert.equal(deriveReusableClaimState([record]), 'enforced');
});
