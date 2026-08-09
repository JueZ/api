import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_RUNTIME_HOSTS,
  PHASE_2_IMPLEMENTATION_IDENTITY,
  PHASE_2_EVIDENCE_PATH,
  PROGRAM_PATH,
  acceptedPhaseEvidenceFindings,
  allowedRuntimeOrigin,
  canonicalWorkflowRunFindings,
  completeHistoricalCheckRollupFindings,
  controllerRunFindings,
  createTrustedGithubClient,
  currentRuntimeFindings,
  fetchAllowedRuntimeHealth,
  lowRiskReviewEvidenceFindings,
  phase2EvidenceFindings,
  phase2EvidenceShapeFindings,
  phase2ImplementationIdentityFindings,
  phaseEvidenceNeedsLiveVerification,
  reviewEvidenceFindings,
  trustedControllerFindings,
  verifyArtifactArchiveDigest,
  verifyOfflineProgramEvidence,
  verifyTrustedPullRequest,
} from '../agent-learning/verify-program-evidence.mjs';

const baselineSha = PHASE_2_IMPLEMENTATION_IDENTITY.baselineMainSha;
const headSha = PHASE_2_IMPLEMENTATION_IDENTITY.headSha;
const mergeSha = PHASE_2_IMPLEMENTATION_IDENTITY.mergeSha;
const currentMainSha = 'e'.repeat(40);
const artifactDigest = `sha256:${'d'.repeat(64)}`;
const branch = 'codex/agent-learning-phase-2-artifacts';

function validEvidence() {
  return {
    schemaVersion: 1,
    repository: 'JueZ/api',
    phase: 2,
    implementation: {
      baselineMainSha: baselineSha,
      pullRequest: {
        number: 349,
        url: 'https://github.com/JueZ/api/pull/349',
        branch,
        headSha,
        mergeSha,
        mergedAt: '2026-08-08T21:35:12Z',
      },
      exactHeadAggregates: [
        ['CI complete', 101, 201],
        ['Policy complete', 102, 202],
        ['CodeQL complete', 103, 203],
        ['Autonomous review complete', 104, 204],
      ].map(([context, checkRunId, workflowRunId]) => ({
        context,
        checkRunId,
        workflowRunId,
        appSlug: 'github-actions',
        conclusion: 'success',
      })),
      postMergeDelivery: {
        mainDelivery: { workflowRunId: 301, sourceSha: mergeSha, conclusion: 'success' },
        mainCi: { workflowRunId: 302, sourceSha: mergeSha, conclusion: 'success' },
        deployTest: deploymentEvidence({
          workflowRunId: 303,
          deploymentId: 501,
          deploymentStatusId: 601,
          deploymentJobId: 401,
          artifactId: 701,
          correlation: 'test-correlation-1234',
        }),
        promoteProduction: deploymentEvidence({
          workflowRunId: 304,
          deploymentId: 502,
          deploymentStatusId: 602,
          deploymentJobId: 402,
          artifactId: 702,
          correlation: 'prod-correlation-1234',
        }),
      },
    },
  };
}

function deploymentEvidence({
  workflowRunId,
  deploymentId,
  deploymentStatusId,
  deploymentJobId,
  artifactId,
  correlation,
}) {
  return {
    workflowRunId,
    deploymentId,
    deploymentStatusId,
    deploymentJobId,
    sourceSha: mergeSha,
    deliveryCorrelation: correlation,
    conclusion: 'success',
    publicSmoke: 'passed',
    authenticatedSmoke: 'passed',
    telemetry: 'passed',
    releaseLedgerArtifactId: artifactId,
    releaseLedgerArtifactDigest: artifactDigest,
    releaseLedger: 'validated',
    runtimeTruth: {
      status: 'verified',
      checkedAt: '2026-08-08T21:47:22.736Z',
      failures: 0,
      blockers: 0,
    },
  };
}

function workflowRun(id, path, event, sha, overrides = {}) {
  return {
    id,
    repository: { full_name: 'JueZ/api' },
    path,
    event,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    ...overrides,
  };
}

function programText(phase2Status = 'in_progress', phase2Evidence = 'None') {
  return `| Phase | Scope | Status | PR and exact commit references | Accepted evidence | Remaining risk |
| --- | --- | --- | --- | --- | --- |
| 1 | Aggregate | \`accepted\` | PR | docs/agent-learning/evidence/branch-protection-aggregation.json | none |
| 2 | Artifacts | \`${phase2Status}\` | PR | ${phase2Evidence} | pending |
| 3 | Conversion | \`not_started\` | None | None | pending |
| 4 | Evaluations | \`not_started\` | None | None | pending |
| 5 | Freshness | \`not_started\` | None | None | pending |
`;
}

function releaseLedger(environment, record) {
  return {
    environment,
    deployedCommit: mergeSha,
    sourceRef: mergeSha,
    workflowRunId: String(record.workflowRunId),
    deliveryCorrelation: record.deliveryCorrelation,
    functionAppName: `safe-${environment}`,
    apiBaseUrl: `https://${ACCEPTANCE_RUNTIME_HOSTS[environment]}`,
    artifacts: {
      functionappSha256: '1'.repeat(64),
      frontendSha256: '2'.repeat(64),
      sbomSha256: '3'.repeat(64),
    },
    smokeRunId: `smoke-${environment}-1`,
    smokeResults: { status: 'passed' },
    authenticatedSmokeResults: { status: 'passed' },
    telemetryCheckResult: { status: 'passed' },
    verifiedAt: '2026-08-08T21:47:22.736Z',
  };
}

function observedEnvironment(environment, record) {
  const expectedEnvironment = environment === 'test' ? 'test' : 'production';
  const workflowName =
    environment === 'test'
      ? `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`
      : `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`;
  const jobUrl = `https://github.com/JueZ/api/actions/runs/${record.workflowRunId}/job/${record.deploymentJobId}`;
  const ledger = releaseLedger(environment, record);
  const deployment = {
    id: record.deploymentId,
    sha: mergeSha,
    ref: 'main',
    environment: expectedEnvironment,
    task: 'deploy',
    creator: { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' },
  };
  return {
    artifactList: {
      artifacts: [
        {
          id: record.releaseLedgerArtifactId,
          name: `release-ledger-${environment}-${record.sourceSha}-${record.deliveryCorrelation}`,
          expired: false,
          digest: artifactDigest,
          workflow_run: { id: record.workflowRunId, head_sha: mergeSha, head_branch: 'main' },
        },
      ],
    },
    ledger,
    deployment,
    deploymentHistory: [deployment],
    deploymentStatuses: [
      {
        id: record.deploymentStatusId + 1000,
        state: 'inactive',
        environment: expectedEnvironment,
        environment_url: '',
        log_url: jobUrl,
        creator: { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: record.deploymentStatusId,
        state: 'success',
        environment: expectedEnvironment,
        environment_url: ledger.apiBaseUrl,
        log_url: jobUrl,
        creator: { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
    deploymentJob: {
      id: record.deploymentJobId,
      run_id: record.workflowRunId,
      workflow_name: workflowName,
      name: environment === 'test' ? 'deploy test / deploy test' : 'promote production / deploy prod',
      head_sha: mergeSha,
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
      runner_group_name: 'GitHub Actions',
      html_url: jobUrl,
      steps: [
        { name: 'Write release ledger', status: 'completed', conclusion: 'success' },
        { name: 'Upload release ledger', status: 'completed', conclusion: 'success' },
      ],
    },
  };
}

function currentObservedEnvironment(environment, deploymentId, statusId, runId) {
  const expectedEnvironment = environment === 'test' ? 'test' : 'production';
  const deployment = {
    id: deploymentId,
    sha: currentMainSha,
    ref: 'main',
    environment: expectedEnvironment,
    task: 'deploy',
    creator: { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' },
  };
  return {
    deployments: [deployment],
    deployment,
    deploymentStatuses: [
      {
        id: statusId,
        state: 'success',
        environment: expectedEnvironment,
        environment_url: `https://${ACCEPTANCE_RUNTIME_HOSTS[environment]}`,
        log_url: `https://github.com/JueZ/api/actions/runs/${runId}/job/${deploymentId + 5000}`,
        creator: { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
    liveHealth: {
      status: 'ok',
      environmentName: environment,
      deploymentRunId: String(runId),
      deployedCommitSha: currentMainSha,
      deployedSourceRef: currentMainSha,
    },
  };
}

function validObserved(evidence) {
  const aggregateRuns = Object.fromEntries(
    evidence.implementation.exactHeadAggregates.map((record) => [
      String(record.workflowRunId),
      workflowRun(
        record.workflowRunId,
        record.context === 'CI complete'
          ? '.github/workflows/ci.yml'
          : record.context === 'Policy complete'
            ? '.github/workflows/policy-check.yml'
            : record.context === 'CodeQL complete'
              ? '.github/workflows/codeql.yml'
              : '.github/workflows/codex-automerge.yml',
        record.context === 'Autonomous review complete' ? 'pull_request_target' : 'pull_request',
        headSha,
        { head_branch: branch, head_repository: { full_name: 'JueZ/api' } },
      ),
    ]),
  );
  const checkRuns = Object.fromEntries(
    evidence.implementation.exactHeadAggregates.map((record) => [
      String(record.checkRunId),
      {
        id: record.checkRunId,
        name: record.context,
        head_sha: headSha,
        status: 'completed',
        conclusion: 'success',
        app: { id: 15_368, slug: 'github-actions' },
        details_url: `https://github.com/JueZ/api/actions/runs/${record.workflowRunId}/job/${record.checkRunId}`,
        external_id:
          record.context === 'Autonomous review complete'
            ? `juez-autonomous-review-decision:v1:JueZ/api:pull:349:head:${headSha}:run:${record.workflowRunId}`
            : undefined,
      },
    ]),
  );
  const delivery = evidence.implementation.postMergeDelivery;
  const autonomousReviewRunId = evidence.implementation.exactHeadAggregates.find(
    (record) => record.context === 'Autonomous review complete',
  ).workflowRunId;
  const deliveryRuns = {
    301: workflowRun(301, '.github/workflows/codex-main-delivery.yml', 'workflow_run', mergeSha, {
      head_branch: 'main',
      head_repository: { full_name: 'JueZ/api' },
      display_title: `Deliver trigger ${autonomousReviewRunId} attempt 1`,
    }),
    302: workflowRun(302, '.github/workflows/ci.yml', 'workflow_dispatch', mergeSha, {
      head_branch: 'main',
      head_repository: { full_name: 'JueZ/api' },
    }),
    303: workflowRun(303, '.github/workflows/deploy-test.yml', 'repository_dispatch', mergeSha, {
      head_branch: 'main',
      head_repository: { full_name: 'JueZ/api' },
      display_title: `Deploy Test ${mergeSha} ${delivery.deployTest.deliveryCorrelation}`,
    }),
    304: workflowRun(304, '.github/workflows/promote-production.yml', 'repository_dispatch', mergeSha, {
      head_branch: 'main',
      head_repository: { full_name: 'JueZ/api' },
      display_title: `Promote Production ${mergeSha} ${delivery.promoteProduction.deliveryCorrelation}`,
    }),
  };
  return {
    pullRequest: {
      number: 349,
      html_url: 'https://github.com/JueZ/api/pull/349',
      state: 'closed',
      merged_at: '2026-08-08T21:35:12Z',
      head: { ref: branch, sha: headSha },
      base: { sha: baselineSha },
      merge_commit_sha: mergeSha,
    },
    checkRuns,
    workflowRuns: { ...aggregateRuns, ...deliveryRuns },
    checkRollup: { checkRuns: Object.values(checkRuns), commitStatuses: [] },
    workflowHistories: {
      implementationHead: Object.values(aggregateRuns),
      merge: Object.values(deliveryRuns),
    },
    environments: {
      test: observedEnvironment('test', delivery.deployTest),
      prod: observedEnvironment('prod', delivery.promoteProduction),
    },
    currentRuntime: {
      mainBefore: { object: { type: 'commit', sha: currentMainSha } },
      mainAfter: { object: { type: 'commit', sha: currentMainSha } },
      environments: {
        test: currentObservedEnvironment('test', 8001, 9001, 10001),
        prod: currentObservedEnvironment('prod', 8002, 9002, 10002),
      },
    },
  };
}

test('offline program validation requires registered evidence for every accepted phase', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'program-evidence-offline-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/agent-learning/evidence'), { recursive: true });
  const program = programText();
  await writeFile(join(root, PROGRAM_PATH), program);
  let result = await verifyOfflineProgramEvidence({ repositoryRoot: root });
  assert.ok(result.errors.some((error) => error.includes('branch-protection-aggregation.json')));
  await writeFile(join(root, 'docs/agent-learning/evidence/branch-protection-aggregation.json'), '{}\n');
  result = await verifyOfflineProgramEvidence({ repositoryRoot: root });
  assert.deepEqual(result, { verified: 0, errors: [] });
});

test('Phase 2 evidence schema is strict and rejects malformed or secret-shaped fields', () => {
  const evidence = validEvidence();
  assert.deepEqual(phase2EvidenceShapeFindings(evidence), []);
  evidence.rawLog = 'untrusted';
  evidence.implementation.postMergeDelivery.deployTest.deliveryCorrelation = 'Authorization: Bearer unsafe-token-value';
  const findings = phase2EvidenceShapeFindings(evidence);
  assert.ok(findings.some((finding) => finding.includes('rawLog is not allowed')));
  assert.ok(findings.some((finding) => finding.includes('secret-shaped')));
});

test('Phase 2 evidence is pinned to the reviewed implementation identity', () => {
  const mutations = [
    {
      label: 'baselineMainSha',
      apply(evidence) {
        evidence.implementation.baselineMainSha = 'a'.repeat(40);
      },
    },
    {
      label: 'PR number',
      apply(evidence) {
        evidence.implementation.pullRequest.number = 999;
        evidence.implementation.pullRequest.url = 'https://github.com/JueZ/api/pull/999';
      },
    },
    {
      label: 'branch',
      apply(evidence) {
        evidence.implementation.pullRequest.branch = 'codex/otherwise-valid-phase-2';
      },
    },
    {
      label: 'head SHA',
      apply(evidence) {
        evidence.implementation.pullRequest.headSha = 'b'.repeat(40);
      },
    },
    {
      label: 'merge SHA',
      apply(evidence) {
        evidence.implementation.pullRequest.mergeSha = 'c'.repeat(40);
      },
    },
  ];

  assert.deepEqual(phase2ImplementationIdentityFindings(validEvidence()), []);
  for (const mutation of mutations) {
    const evidence = validEvidence();
    mutation.apply(evidence);
    const findings = phase2ImplementationIdentityFindings(evidence);
    assert.ok(
      findings.some((finding) => finding.includes(mutation.label)),
      `${mutation.label} substitution must be rejected`,
    );
  }
});

test('live Phase 2 verification binds distinct GitHub environments, jobs, ledgers, and health', () => {
  const evidence = validEvidence();
  const observed = validObserved(evidence);
  assert.deepEqual(phase2EvidenceFindings(evidence, observed), []);

  observed.environments.test.deployment.environment = 'production';
  observed.environments.test.ledger.apiBaseUrl = observed.environments.prod.ledger.apiBaseUrl;
  const findings = phase2EvidenceFindings(evidence, observed);
  assert.ok(findings.some((finding) => finding.includes('test GitHub environment does not match')));
  assert.ok(findings.some((finding) => finding.includes('test ledger runtime origin is not allowlisted')));
});

test('historical check rollup rejects unrelated and aggregate superseding failures', () => {
  const evidence = validEvidence();
  const unrelated = validObserved(evidence);
  unrelated.checkRollup.checkRuns.push({
    id: 5000,
    name: 'later unrelated security check',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    app: { id: 15_368, slug: 'github-actions' },
  });
  let findings = phase2EvidenceFindings(evidence, unrelated);
  assert.ok(findings.some((finding) => finding.includes('later unrelated security check latest conclusion')));

  const supersededAggregate = validObserved(evidence);
  supersededAggregate.checkRollup.checkRuns.push({
    ...supersededAggregate.checkRuns['101'],
    id: 5100,
    status: 'in_progress',
    conclusion: null,
  });
  findings = phase2EvidenceFindings(evidence, supersededAggregate);
  assert.ok(findings.some((finding) => finding.includes('CI complete declared check is not canonical latest')));
  assert.ok(findings.some((finding) => finding.includes('CI complete is not completed')));

  assert.ok(
    completeHistoricalCheckRollupFindings(
      [],
      [{ id: 1, context: 'legacy-policy', sha: headSha, state: 'pending' }],
      headSha,
    ).some((finding) => finding.includes('legacy-policy latest state')),
  );
});

test('canonical workflow and deployment histories reject later failed records', () => {
  const evidence = validEvidence();
  const observed = validObserved(evidence);
  const recordedDeploy = observed.workflowRuns['303'];
  const expectedDeploy = {
    id: 303,
    repository: 'JueZ/api',
    path: '.github/workflows/deploy-test.yml',
    event: 'repository_dispatch',
    headSha: mergeSha,
    headBranch: 'main',
    headRepository: 'JueZ/api',
    displayTitle: recordedDeploy.display_title,
    historyDisplayTitlePrefix: `Deploy Test ${mergeSha} `,
  };
  const laterFailedRun = {
    ...recordedDeploy,
    id: 5300,
    conclusion: 'failure',
    display_title: `Deploy Test ${mergeSha} later-correlation-9999`,
  };
  assert.ok(
    canonicalWorkflowRunFindings(recordedDeploy, [recordedDeploy, laterFailedRun], expectedDeploy, 'deployTest').some(
      (finding) => finding.includes('not the canonical latest applicable run'),
    ),
  );

  observed.workflowHistories.merge.push(laterFailedRun);
  observed.environments.test.deploymentStatuses.push({
    ...observed.environments.test.deploymentStatuses[0],
    id: 5400,
    state: 'failure',
  });
  const findings = phase2EvidenceFindings(evidence, observed);
  assert.ok(findings.some((finding) => finding.includes('deployTest workflow run is not the canonical latest')));
  assert.ok(findings.some((finding) => finding.includes('test deployment has a later non-supersession status')));
});

test('historical inactive supersession requires healthy exact-current-main runtime', () => {
  const evidence = validEvidence();
  const observed = validObserved(evidence);
  assert.deepEqual(currentRuntimeFindings(observed.currentRuntime), []);
  assert.notEqual(observed.currentRuntime.mainBefore.object.sha, mergeSha);

  observed.currentRuntime.environments.prod.deploymentStatuses[0].state = 'in_progress';
  observed.currentRuntime.environments.test.liveHealth.deployedCommitSha = mergeSha;
  observed.currentRuntime.mainAfter.object.sha = 'f'.repeat(40);
  const findings = currentRuntimeFindings(observed.currentRuntime);
  assert.ok(findings.some((finding) => finding.includes('prod current deployment did not succeed')));
  assert.ok(findings.some((finding) => finding.includes('test current live health commit is not exact main')));
  assert.ok(findings.some((finding) => finding.includes('current main changed')));
});

test('runtime origins are fixed per environment and reject credentials, query data, and aliases', () => {
  assert.equal(
    allowedRuntimeOrigin('test', `https://${ACCEPTANCE_RUNTIME_HOSTS.test}`),
    `https://${ACCEPTANCE_RUNTIME_HOSTS.test}`,
  );
  assert.equal(allowedRuntimeOrigin('test', `https://${ACCEPTANCE_RUNTIME_HOSTS.prod}`), '');
  assert.equal(allowedRuntimeOrigin('test', `https://user:pass@${ACCEPTANCE_RUNTIME_HOSTS.test}`), '');
  assert.equal(allowedRuntimeOrigin('test', `https://${ACCEPTANCE_RUNTIME_HOSTS.test}?redirect=1`), '');
});

test('runtime health requests disable redirects and never follow a redirect response', async () => {
  let request;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': '89' }),
    async text() {
      return JSON.stringify({ status: 'ok', environmentName: 'test', deployedCommitSha: mergeSha });
    },
  };
  const result = await fetchAllowedRuntimeHealth(
    'test',
    `https://${ACCEPTANCE_RUNTIME_HOSTS.test}`,
    async (url, init) => {
      request = { url, init };
      return response;
    },
  );
  assert.equal(result.status, 'ok');
  assert.equal(request.url, `https://${ACCEPTANCE_RUNTIME_HOSTS.test}/health`);
  assert.equal(request.init.redirect, 'error');

  await assert.rejects(
    fetchAllowedRuntimeHealth('test', `https://${ACCEPTANCE_RUNTIME_HOSTS.test}`, async () => ({
      ok: false,
      status: 302,
      headers: new Headers(),
      async text() {
        return '';
      },
    })),
    /HTTP 302/,
  );
  await assert.rejects(
    fetchAllowedRuntimeHealth(
      'test',
      `https://${ACCEPTANCE_RUNTIME_HOSTS.test}`,
      async () => new Response('x'.repeat(65 * 1024), { status: 200 }),
    ),
    /byte limit/,
  );
});

test('trusted GitHub reads are repository-bound, fixed-path, exact-ref, and no-redirect', async () => {
  const requests = [];
  const program = Buffer.from('# Program\n');
  const client = createTrustedGithubClient({
    repository: 'JueZ/api',
    token: 'test-token-placeholder',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({
            type: 'file',
            path: PROGRAM_PATH,
            encoding: 'base64',
            size: program.length,
            content: program.toString('base64'),
          });
        },
      };
    },
  });
  assert.equal(await client.getFile(PROGRAM_PATH, headSha), '# Program\n');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, 'error');
  assert.match(requests[0].url, /\/contents\/docs\/agent-learning\/program\.md\?ref=/);
  await assert.rejects(client.getFile('scripts/untrusted.mjs', headSha), /not allowlisted/);
  await assert.rejects(client.getFile(PROGRAM_PATH, 'main'), /exact SHA/);
  assert.equal(requests.length, 1);
  assert.throws(
    () => createTrustedGithubClient({ repository: 'attacker/repository', token: 'test-token-placeholder' }),
    /repository-bound/,
  );
});

test('trusted GitHub check history pagination is complete and exact-SHA bound', async () => {
  const requests = [];
  const client = createTrustedGithubClient({
    repository: 'JueZ/api',
    token: 'test-token-placeholder',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const page = Number(new URL(url).searchParams.get('page'));
      const count = page === 1 ? 100 : 1;
      return new Response(
        JSON.stringify({
          total_count: 101,
          check_runs: Array.from({ length: count }, (_, index) => ({ id: page * 1000 + index })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const checkRuns = await client.getCheckRuns(headSha);
  assert.equal(checkRuns.length, 101);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.init.redirect === 'error'));
  assert.ok(requests.every((request) => request.url.includes(`/commits/${headSha}/check-runs?filter=all`)));
  await assert.rejects(client.getCheckRuns('main'), /SHA must be exact/);
  assert.equal(requests.length, 2);
});

test('artifact archive proof requires the authenticated and recorded digest to match the exact bytes', () => {
  const archive = Buffer.from('immutable artifact bytes');
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  assert.equal(verifyArtifactArchiveDigest(archive, digest, digest), digest);
  assert.throws(() => verifyArtifactArchiveDigest(Buffer.from('changed'), digest, digest), /digest does not match/);
});

test('trusted review evidence binds the exact reviewed head, claim, and controller run', () => {
  const options = {
    repository: 'JueZ/api',
    prNumber: 400,
    headSha,
    controllerRunId: 900,
  };
  const review = {
    decision: 'approve',
    reviewedHeadSha: headSha,
    risk: { highRisk: true },
    modelInvoked: true,
    reviewClaim: { status: 'new', runId: 900, checkRunId: 901 },
  };
  const claim = {
    id: 901,
    name: 'Autonomous review paid-call claim v4 PR #400',
    head_sha: headSha,
    external_id: `juez-autonomous-review:v4:JueZ/api:pull:400:head:${headSha}:workflow:codex-automerge.yml:run:900`,
    details_url: 'https://github.com/JueZ/api/runs/901',
    app: { id: 15_368, slug: 'github-actions' },
    status: 'completed',
    conclusion: 'neutral',
  };
  assert.deepEqual(reviewEvidenceFindings(review, options, claim), []);
  assert.ok(reviewEvidenceFindings({ ...review, reviewedHeadSha: mergeSha }, options, claim).length > 0);
  assert.ok(reviewEvidenceFindings({ ...review, decision: 'reject' }, options, claim).length > 0);
  assert.ok(reviewEvidenceFindings(review, options, { ...claim, external_id: 'stale' }).length > 0);
});

test('low-risk review evidence is exact-head bound and cannot carry a paid claim', () => {
  const options = { headSha };
  const review = {
    decision: 'approve',
    reviewedHeadSha: headSha,
    risk: { highRisk: false },
    modelInvoked: false,
  };
  assert.deepEqual(lowRiskReviewEvidenceFindings(review, options), []);
  assert.ok(lowRiskReviewEvidenceFindings({ ...review, modelInvoked: true }, options).length > 0);
  assert.ok(lowRiskReviewEvidenceFindings({ ...review, reviewClaim: { status: 'new' } }, options).length > 0);
});

test('trusted controller identity rejects the wrong workflow, run, repository, or checkout SHA', () => {
  const options = {
    repository: 'JueZ/api',
    controllerRunId: 900,
    controllerSha: mergeSha,
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'Codex Auto-Merge',
    GITHUB_REPOSITORY: 'JueZ/api',
    GITHUB_RUN_ID: '900',
  };
  assert.deepEqual(trustedControllerFindings(options, { env, checkoutSha: mergeSha }), []);
  assert.ok(
    trustedControllerFindings(options, { env: { ...env, GITHUB_WORKFLOW: 'CI' }, checkoutSha: mergeSha }).length > 0,
  );
  assert.ok(trustedControllerFindings(options, { env, checkoutSha: headSha }).length > 0);
});

test('pull_request_target REST head binds the candidate while trusted checkout binds workflow SHA', () => {
  const targetOptions = {
    repository: 'JueZ/api',
    controllerRunId: 900,
    controllerSha: mergeSha,
    headSha,
  };
  const targetRun = workflowRun(900, '.github/workflows/codex-automerge.yml', 'pull_request_target', headSha);
  assert.deepEqual(controllerRunFindings(targetRun, targetOptions), []);
  assert.ok(controllerRunFindings({ ...targetRun, head_sha: mergeSha }, targetOptions).length > 0);

  const dispatchOptions = { ...targetOptions, controllerRunId: 901 };
  const dispatchRun = workflowRun(901, '.github/workflows/codex-automerge.yml', 'repository_dispatch', mergeSha);
  assert.deepEqual(controllerRunFindings(dispatchRun, dispatchOptions), []);
  assert.ok(controllerRunFindings({ ...dispatchRun, head_sha: headSha }, dispatchOptions).length > 0);
});

test('trusted verification rejects an invalid review claim before querying a check run', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'program-evidence-review-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const reviewFile = join(root, 'review.json');
  await writeFile(
    reviewFile,
    JSON.stringify({
      decision: 'approve',
      reviewedHeadSha: headSha,
      risk: { highRisk: true },
      modelInvoked: true,
      reviewClaim: { status: 'new', runId: 900, checkRunId: 0 },
    }),
  );
  const requests = [];
  const client = {
    async getJson(path) {
      requests.push(path);
      if (path.startsWith('/pulls/')) {
        return {
          number: 400,
          state: 'open',
          head: { sha: headSha, repo: { full_name: 'JueZ/api' } },
          base: { ref: 'main', sha: baselineSha, repo: { full_name: 'JueZ/api' } },
        };
      }
      if (path.startsWith('/actions/runs/')) {
        return workflowRun(900, '.github/workflows/codex-automerge.yml', 'pull_request_target', headSha);
      }
      throw new Error(`unexpected request: ${path}`);
    },
    async getPullRequestFiles() {
      return [{ filename: PROGRAM_PATH }];
    },
  };
  const options = {
    repository: 'JueZ/api',
    prNumber: 400,
    headSha,
    controllerRunId: 900,
    controllerSha: mergeSha,
    reviewFile,
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'Codex Auto-Merge',
    GITHUB_REPOSITORY: 'JueZ/api',
    GITHUB_RUN_ID: '900',
  };
  await assert.rejects(
    verifyTrustedPullRequest(options, { client, runtime: { env, checkoutSha: mergeSha } }),
    /claim check ID is invalid/,
  );
  assert.equal(
    requests.some((path) => path.startsWith('/check-runs/')),
    false,
  );
});

test('trusted verification accepts a bound low-risk review only when program evidence is not applicable', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'program-evidence-low-risk-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const reviewFile = join(root, 'review.json');
  await writeFile(
    reviewFile,
    JSON.stringify({
      decision: 'approve',
      reviewedHeadSha: headSha,
      risk: { highRisk: false },
      modelInvoked: false,
    }),
  );
  const requests = [];
  const client = {
    async getJson(path) {
      requests.push(path);
      if (path.startsWith('/pulls/')) {
        return {
          number: 400,
          state: 'open',
          head: { sha: headSha, repo: { full_name: 'JueZ/api' } },
          base: { ref: 'main', sha: baselineSha, repo: { full_name: 'JueZ/api' } },
        };
      }
      if (path.startsWith('/actions/runs/')) {
        return workflowRun(900, '.github/workflows/codex-automerge.yml', 'pull_request_target', headSha);
      }
      throw new Error(`unexpected request: ${path}`);
    },
    async getPullRequestFiles() {
      return [{ filename: 'docs/ordinary.md' }];
    },
    async getFile(path) {
      assert.equal(path, PROGRAM_PATH);
      return programText();
    },
  };
  const options = {
    repository: 'JueZ/api',
    prNumber: 400,
    headSha,
    controllerRunId: 900,
    controllerSha: mergeSha,
    reviewFile,
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'Codex Auto-Merge',
    GITHUB_REPOSITORY: 'JueZ/api',
    GITHUB_RUN_ID: '900',
  };
  const result = await verifyTrustedPullRequest(options, { client, runtime: { env, checkoutSha: mergeSha } });
  assert.equal(result.status, 'not_applicable');
  assert.equal(
    requests.some((path) => path.startsWith('/check-runs/')),
    false,
  );

  client.getPullRequestFiles = async () => [{ filename: PROGRAM_PATH }];
  client.getFile = async (path, ref) => {
    assert.equal(path, PROGRAM_PATH);
    return ref === headSha ? programText('accepted', PHASE_2_EVIDENCE_PATH) : programText();
  };
  await assert.rejects(
    verifyTrustedPullRequest(options, { client, runtime: { env, checkoutSha: mergeSha } }),
    /requires an independent high-risk review/,
  );
});

test('Phase 2 live verification triggers only for its evidence or authoritative phase record', () => {
  const previous = programText();
  const current = programText('accepted', PHASE_2_EVIDENCE_PATH);
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      changedPaths: [PHASE_2_EVIDENCE_PATH],
      previousProgramText: previous,
      currentProgramText: previous,
    }),
    true,
  );
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      changedPaths: ['docs/project-memory/current-state.md'],
      previousProgramText: previous,
      currentProgramText: previous,
    }),
    false,
  );
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      changedPaths: [PROGRAM_PATH],
      previousProgramText: current,
      currentProgramText: current.replace('Risk', 'Updated risk'),
    }),
    true,
  );
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      changedPaths: [PROGRAM_PATH],
      previousProgramText: previous,
      currentProgramText: current,
    }),
    true,
  );
});

test('duplicate or malformed phase tables cannot bypass live verification', () => {
  const duplicate = `${programText()}\n| 2 | Artifacts | \`accepted\` | PR | ${PHASE_2_EVIDENCE_PATH} | none |\n`;
  assert.equal(
    phaseEvidenceNeedsLiveVerification({
      phase: 2,
      changedPaths: [PROGRAM_PATH],
      previousProgramText: programText(),
      currentProgramText: duplicate,
    }),
    true,
  );
  assert.ok(acceptedPhaseEvidenceFindings(duplicate, () => true).some((finding) => finding.includes('duplicated')));
  assert.ok(
    acceptedPhaseEvidenceFindings(programText().replace('| 5 |', '| 6 |'), () => true).some((finding) =>
      finding.includes('phase 5 is missing'),
    ),
  );
});

test('accepted-phase registration helper rejects missing paths without interpreting evidence contents', () => {
  const program = programText('accepted', PHASE_2_EVIDENCE_PATH);
  assert.deepEqual(
    acceptedPhaseEvidenceFindings(program, () => true),
    [],
  );
  assert.ok(
    acceptedPhaseEvidenceFindings(program, () => false).some((finding) => finding.includes('evidence is missing')),
  );
});
