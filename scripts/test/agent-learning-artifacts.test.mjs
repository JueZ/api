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
import { historicalScorerFindings, pullRequestProvenanceFindings } from '../agent-learning/verify-artifacts.mjs';
import {
  acceptedPhaseEvidenceFindings,
  phase2EvidenceFindings,
  phaseEvidenceNeedsLiveVerification,
} from '../agent-learning/verify-program-evidence.mjs';

const BROKEN_SHA = 'a'.repeat(40);
const FIXED_SHA = 'b'.repeat(40);
const AS_OF_DATE = '2026-08-08';

function validPhase2Observed(evidence) {
  const implementation = evidence.implementation.pullRequest;
  const observed = {
    pullRequest: {
      number: implementation.number,
      html_url: implementation.url,
      state: 'closed',
      merged_at: implementation.mergedAt,
      head: { ref: implementation.branch, sha: implementation.headSha },
      base: { sha: evidence.implementation.baselineMainSha },
      merge_commit_sha: implementation.mergeSha,
    },
    checkRuns: {},
    workflowRuns: {},
    artifacts: {},
    ledgers: {},
    liveHealth: {},
  };
  const aggregateWorkflows = {
    'CI complete': ['.github/workflows/ci.yml', 'pull_request'],
    'Policy complete': ['.github/workflows/policy-check.yml', 'pull_request'],
    'CodeQL complete': ['.github/workflows/codeql.yml', 'pull_request'],
    'Autonomous review complete': ['.github/workflows/codex-automerge.yml', 'pull_request_target'],
  };
  for (const record of evidence.implementation.exactHeadAggregates) {
    const autonomous = record.context === 'Autonomous review complete';
    observed.checkRuns[String(record.checkRunId)] = {
      id: record.checkRunId,
      name: record.context,
      head_sha: implementation.headSha,
      status: 'completed',
      conclusion: 'success',
      app: { id: 15368, slug: 'github-actions' },
      external_id: autonomous
        ? `juez-autonomous-review-decision:v1:JueZ/api:pull:${implementation.number}:head:${implementation.headSha}:run:${record.workflowRunId}`
        : 'workflow-job',
      details_url: autonomous
        ? `https://github.com/JueZ/api/runs/${record.checkRunId}`
        : `https://github.com/JueZ/api/actions/runs/${record.workflowRunId}/job/${record.checkRunId}`,
    };
    observed.workflowRuns[String(record.workflowRunId)] = {
      id: record.workflowRunId,
      repository: { full_name: 'JueZ/api' },
      path: aggregateWorkflows[record.context][0],
      event: aggregateWorkflows[record.context][1],
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      head_sha: implementation.headSha,
    };
  }
  const deliveryWorkflows = {
    mainDelivery: ['.github/workflows/codex-main-delivery.yml', 'workflow_run'],
    mainCi: ['.github/workflows/ci.yml', 'workflow_dispatch'],
    deployTest: ['.github/workflows/deploy-test.yml', 'repository_dispatch'],
    promoteProduction: ['.github/workflows/promote-production.yml', 'repository_dispatch'],
  };
  for (const [key, record] of Object.entries(evidence.implementation.postMergeDelivery)) {
    observed.workflowRuns[String(record.workflowRunId)] = {
      id: record.workflowRunId,
      repository: { full_name: 'JueZ/api' },
      path: deliveryWorkflows[key][0],
      event: deliveryWorkflows[key][1],
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      head_sha: implementation.mergeSha,
      display_title:
        key === 'deployTest'
          ? `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`
          : key === 'promoteProduction'
            ? `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`
            : undefined,
    };
  }
  for (const [environment, key] of [
    ['test', 'deployTest'],
    ['prod', 'promoteProduction'],
  ]) {
    const record = evidence.implementation.postMergeDelivery[key];
    observed.artifacts[String(record.workflowRunId)] = {
      artifacts: [
        {
          id: record.releaseLedgerArtifactId,
          name: `release-ledger-${environment}-${record.sourceSha}-${record.deliveryCorrelation}`,
          expired: false,
        },
      ],
    };
    observed.ledgers[environment] = {
      environment,
      deployedCommit: record.sourceSha,
      sourceRef: record.sourceSha,
      workflowRunId: String(record.workflowRunId),
      deliveryCorrelation: record.deliveryCorrelation,
      functionAppName: `fixture-${environment}`,
      apiBaseUrl: `https://example.invalid/${environment}`,
      artifacts: {
        functionappSha256: 'a'.repeat(64),
        frontendSha256: 'b'.repeat(64),
        sbomSha256: 'c'.repeat(64),
      },
      smokeRunId: `smoke-${environment}`,
      smokeResults: { status: 'passed' },
      authenticatedSmokeResults: { status: 'passed' },
      telemetryCheckResult: { status: 'passed' },
      verifiedAt: '2026-08-08T21:00:00Z',
    };
    observed.liveHealth[environment] = { status: 'ok', deployedCommitSha: implementation.mergeSha };
  }
  return observed;
}

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

test('registered historical scorers prove each broken and fixed invariant transition', () => {
  const fixtures = new Map([
    [
      `${BROKEN_SHA}:.github/workflows/codex-main-delivery.yml`,
      "github.event.workflow_run.name == 'CI'\ngithub.event.workflow_run.name == 'Codex Auto-Merge'\n",
    ],
    [
      `${FIXED_SHA}:.github/workflows/codex-main-delivery.yml`,
      "github.event.workflow_run.path == '.github/workflows/ci.yml'\ngithub.event.workflow_run.path == '.github/workflows/codex-automerge.yml'\n",
    ],
    [`${BROKEN_SHA}:.github/workflows/ci.yml`, 'npm run lint\n'],
    [`${FIXED_SHA}:.github/workflows/ci.yml`, './node_modules/.bin/eslint apps scripts --max-warnings 0\n'],
    [`${BROKEN_SHA}:.github/autonomous-policy.yml`, 'highRiskPaths:\n  - .github/workflows/**\n'],
    [`${FIXED_SHA}:.github/autonomous-policy.yml`, 'highRiskPaths:\n  - package.json\n  - scripts/**\n'],
    [`${BROKEN_SHA}:apps/api/src/application/operations/registry.ts`, "mcp: { toolName: 'bring_add_items' }\n"],
    [`${FIXED_SHA}:apps/api/src/application/operations/registry.ts`, "mcp: { toolName: 'bring_add_item' }\n"],
    [`${BROKEN_SHA}:apps/api/src/mcp/tools/bring.ts`, "server.registerTool('bring_add_items')\n"],
    [
      `${FIXED_SHA}:apps/api/src/mcp/tools/bring.ts`,
      "server.registerTool('bring_add_item')\nitem: itemInputSchema\nitems: [item]\n",
    ],
  ]);
  const readAt = (commit, path) => fixtures.get(`${commit}:${path}`) ?? '';
  for (const [id, scorerId] of [
    ['workflow-run-identity', 'historical.workflow-run-identity'],
    ['ci-script-indirection', 'historical.ci-script-indirection'],
    ['bring-singular-add-item', 'historical.bring-singular-add-item'],
  ]) {
    const artifact = validVerifiedArtifact({ id });
    artifact.counterfactual.verification = { trustedScorers: [scorerId] };
    assert.deepEqual(historicalScorerFindings(artifact, readAt), []);
  }

  const invalid = validVerifiedArtifact({ id: 'workflow-run-identity' });
  invalid.counterfactual.verification = { trustedScorers: ['historical.workflow-run-identity'] };
  assert.ok(
    historicalScorerFindings(invalid, () => fixtures.get(`${BROKEN_SHA}:.github/workflows/codex-main-delivery.yml`))
      .length > 0,
  );
});

test('live PR provenance must bind the implementation number and exact broken/fixed SHAs', () => {
  const artifact = validVerifiedArtifact();
  const pullRequest = {
    number: 123,
    state: 'closed',
    merged_at: '2026-08-08T00:00:00Z',
    base: { sha: BROKEN_SHA },
    merge_commit_sha: FIXED_SHA,
  };
  assert.deepEqual(pullRequestProvenanceFindings(artifact, pullRequest), []);
  assert.ok(
    pullRequestProvenanceFindings(artifact, { ...pullRequest, merge_commit_sha: 'c'.repeat(40) }).some((finding) =>
      finding.includes('merge SHA'),
    ),
  );
});

test('Phase 2 acceptance evidence binds authenticated checks, workflow runs, ledgers, and live runtime', () => {
  const evidence = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'docs/agent-learning/evidence/phase-2-versioned-artifacts.json'), 'utf8'),
  );
  assert.deepEqual(phase2EvidenceFindings(evidence, validPhase2Observed(evidence)), []);
});

test('Phase 2 acceptance evidence rejects stale or mismatched remote proof', () => {
  const evidence = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'docs/agent-learning/evidence/phase-2-versioned-artifacts.json'), 'utf8'),
  );
  const observed = validPhase2Observed(evidence);
  const aggregate = evidence.implementation.exactHeadAggregates[0];
  observed.checkRuns[String(aggregate.checkRunId)].head_sha = 'd'.repeat(40);
  observed.ledgers.prod.deployedCommit = 'e'.repeat(40);
  observed.liveHealth.test.deployedCommitSha = 'f'.repeat(40);
  const findings = phase2EvidenceFindings(evidence, observed);
  assert.ok(findings.some((finding) => finding.includes('CI complete head SHA')));
  assert.ok(findings.some((finding) => finding.includes('prod ledger deployed commit')));
  assert.ok(findings.some((finding) => finding.includes('test live /health commit')));
});

test('accepted program phases fail closed when registered evidence is deleted', () => {
  const program = readFileSync(join(REPOSITORY_ROOT, 'docs/agent-learning/program.md'), 'utf8');
  const findings = acceptedPhaseEvidenceFindings(
    program,
    (path) => path !== 'docs/agent-learning/evidence/phase-2-versioned-artifacts.json',
  );
  assert.deepEqual(findings, [
    'accepted phase 2 evidence is missing: docs/agent-learning/evidence/phase-2-versioned-artifacts.json',
  ]);
});

test('Phase 2 status-only and memory-only changes require live evidence verification', () => {
  const acceptedProgram = readFileSync(join(REPOSITORY_ROOT, 'docs/agent-learning/program.md'), 'utf8');
  const pendingProgram = acceptedProgram.replace(
    /\| 2\s+\| Versioned learning artifacts and closed-loop skill \| `accepted`/,
    '| 2     | Versioned learning artifacts and closed-loop skill | `in_progress`',
  );
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      previousProgramText: pendingProgram,
      currentProgramText: acceptedProgram,
    }),
    true,
  );
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      previousProgramText: acceptedProgram,
      currentProgramText: acceptedProgram,
      acceptanceDiff: '+Phase 2 is accepted through PR #349.\n',
    }),
    true,
  );
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
