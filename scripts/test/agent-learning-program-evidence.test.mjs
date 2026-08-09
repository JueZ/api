import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_RUNTIME_HOSTS,
  OPEN_PR_LEDGER_PATHS,
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
  openPullRequestLedgerFindings,
  phase2EvidenceFindings,
  phase2EvidenceShapeFindings,
  phase2ImplementationIdentityFindings,
  phaseEvidenceNeedsLiveVerification,
  protectedMainControllerFindings,
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
          deploymentJobId: 401,
          artifactId: 701,
          correlation: 'test-correlation-1234',
        }),
        promoteProduction: deploymentEvidence({
          workflowRunId: 304,
          deploymentJobId: 402,
          artifactId: 702,
          correlation: 'prod-correlation-1234',
        }),
      },
    },
  };
}

function deploymentEvidence({ workflowRunId, deploymentJobId, artifactId, correlation }) {
  return {
    workflowRunId,
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

function protectedMainComparison(controllerSha = mergeSha, mainSha = currentMainSha) {
  return {
    status: controllerSha === mainSha ? 'identical' : 'ahead',
    ahead_by: controllerSha === mainSha ? 0 : 1,
    behind_by: 0,
    base_commit: { sha: controllerSha },
    merge_base_commit: { sha: controllerSha },
    url: `https://api.github.com/repos/JueZ/api/compare/${controllerSha}...${mainSha}`,
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

function releaseLedger(environment, record, sourceSha = mergeSha) {
  return {
    environment,
    deployedCommit: sourceSha,
    sourceRef: sourceSha,
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
    verifiedAt: sourceSha === currentMainSha ? '2026-08-09T09:39:36Z' : '2026-08-08T21:41:16Z',
  };
}

function workflowFiles(environment, ref) {
  return {
    entry: {
      path: environment === 'test' ? '.github/workflows/deploy-test.yml' : '.github/workflows/promote-production.yml',
      ref,
      sha256:
        environment === 'test'
          ? 'be874930e0d375765afe67d50429744f5f629d129b944cae601e915ea16c7275'
          : 'eb87a6f7fd479226a68e0edd7f9867ce9b6c3bac853ffae0ed687734e0944387',
    },
    shared: {
      path: '.github/workflows/deploy-environment.yml',
      ref,
      sha256: 'cd36744ebf07c466d407ca4ecd83751e2f6445263a7bab90145c69326d844be9',
    },
  };
}

function observedEnvironment(environment, record) {
  const workflowName =
    environment === 'test'
      ? `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`
      : `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`;
  const jobUrl = `https://github.com/JueZ/api/actions/runs/${record.workflowRunId}/job/${record.deploymentJobId}`;
  const ledger = releaseLedger(environment, record);
  return {
    artifactList: {
      artifacts: [
        {
          id: record.releaseLedgerArtifactId,
          name: `release-ledger-${environment}-${record.sourceSha}-${record.deliveryCorrelation}`,
          expired: false,
          digest: artifactDigest,
          created_at: '2026-08-08T21:41:17Z',
          updated_at: '2026-08-08T21:41:17Z',
          workflow_run: { id: record.workflowRunId, head_sha: mergeSha, head_branch: 'main' },
        },
      ],
    },
    ledger,
    workflowFiles: workflowFiles(environment, mergeSha),
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
      created_at: '2026-08-08T21:37:25Z',
      started_at: '2026-08-08T21:37:29Z',
      completed_at: '2026-08-08T21:41:20Z',
      runner_group_name: 'GitHub Actions',
      html_url: jobUrl,
      steps: [
        {
          name: 'Write release ledger',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-08-08T21:41:16Z',
          completed_at: '2026-08-08T21:41:16Z',
        },
        {
          name: 'Upload release ledger',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-08-08T21:41:16Z',
          completed_at: '2026-08-08T21:41:17Z',
        },
      ],
    },
  };
}

function currentObservedEnvironment(environment, runId) {
  const jobId = runId + 5000;
  const correlation = 'current-correlation';
  const jobUrl = `https://github.com/JueZ/api/actions/runs/${runId}/job/${jobId}`;
  const workflowTitle = `${environment === 'test' ? 'Deploy Test' : 'Promote Production'} ${currentMainSha} ${correlation}`;
  const run = workflowRun(
    runId,
    environment === 'test' ? '.github/workflows/deploy-test.yml' : '.github/workflows/promote-production.yml',
    'repository_dispatch',
    currentMainSha,
    {
      head_branch: 'main',
      head_repository: { full_name: 'JueZ/api' },
      html_url: `https://github.com/JueZ/api/actions/runs/${runId}`,
      display_title: workflowTitle,
    },
  );
  const record = { workflowRunId: runId, deliveryCorrelation: correlation };
  const ledger = releaseLedger(environment, record, currentMainSha);
  const artifact = {
    id: runId + 7000,
    name: `release-ledger-${environment}-${currentMainSha}-${correlation}`,
    expired: false,
    digest: artifactDigest,
    created_at: '2026-08-09T09:39:37Z',
    updated_at: '2026-08-09T09:39:37Z',
    workflow_run: { id: runId, head_sha: currentMainSha, head_branch: 'main' },
  };
  const deploymentJob = {
    id: jobId,
    run_id: runId,
    workflow_name: workflowTitle,
    name: environment === 'test' ? 'deploy test / deploy test' : 'promote production / deploy prod',
    head_sha: currentMainSha,
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-08-09T09:35:48Z',
    started_at: '2026-08-09T09:35:51Z',
    completed_at: '2026-08-09T09:39:38Z',
    runner_group_name: 'GitHub Actions',
    html_url: jobUrl,
    steps: [
      {
        name: 'Write release ledger',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-09T09:39:36Z',
        completed_at: '2026-08-09T09:39:36Z',
      },
      {
        name: 'Upload release ledger',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-09T09:39:36Z',
        completed_at: '2026-08-09T09:39:37Z',
      },
    ],
  };
  return {
    workflowRuns: [run],
    workflowRun: run,
    deliveryCorrelation: correlation,
    deploymentJobs: [deploymentJob],
    deploymentJob,
    artifactList: { artifacts: [artifact] },
    ledgerArtifacts: [artifact],
    artifact,
    ledger,
    workflowFiles: workflowFiles(environment, currentMainSha),
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
        test: currentObservedEnvironment('test', 10001),
        prod: currentObservedEnvironment('prod', 10002),
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
  evidence.implementation.postMergeDelivery.deployTest.deploymentId = 123;
  evidence.implementation.postMergeDelivery.deployTest.deliveryCorrelation = 'Authorization: Bearer unsafe-token-value';
  const findings = phase2EvidenceShapeFindings(evidence);
  assert.ok(findings.some((finding) => finding.includes('rawLog is not allowed')));
  assert.ok(findings.some((finding) => finding.includes('deploymentId is not allowed')));
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

test('live Phase 2 verification binds reviewed workflows, exact jobs, ledgers, and health', () => {
  const evidence = validEvidence();
  const observed = validObserved(evidence);
  assert.deepEqual(phase2EvidenceFindings(evidence, observed), []);

  observed.environments.test.workflowFiles.entry.sha256 = '0'.repeat(64);
  observed.environments.test.artifactList.artifacts[0].created_at = '2026-08-08T21:42:00Z';
  observed.environments.test.ledger.apiBaseUrl = observed.environments.prod.ledger.apiBaseUrl;
  const findings = phase2EvidenceFindings(evidence, observed);
  assert.ok(findings.some((finding) => finding.includes('test historical entry workflow content')));
  assert.ok(findings.some((finding) => finding.includes('test ledger runtime origin is not allowlisted')));
  assert.ok(findings.some((finding) => finding.includes('test historical release ledger is not bounded')));

  const wrongRun = validObserved(validEvidence());
  wrongRun.environments.test.artifactList.artifacts[0].workflow_run.id = 999;
  assert.ok(
    phase2EvidenceFindings(validEvidence(), wrongRun).some((finding) =>
      finding.includes('test ledger artifact run does not match'),
    ),
  );
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

test('canonical workflow histories and authenticated artifacts reject later or duplicate records', () => {
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
  observed.workflowHistories.merge.push({
    ...observed.workflowRuns['301'],
    id: 5301,
    conclusion: 'failure',
    display_title: 'Deliver trigger 999 attempt 1',
  });
  observed.environments.test.artifactList.artifacts.push({
    ...observed.environments.test.artifactList.artifacts[0],
    id: 5400,
  });
  const findings = phase2EvidenceFindings(evidence, observed);
  assert.ok(findings.some((finding) => finding.includes('deployTest workflow run is not the canonical latest')));
  assert.ok(findings.some((finding) => finding.includes('mainDelivery workflow run is not the canonical latest')));
  assert.ok(findings.some((finding) => finding.includes('test ledger artifact name is not unique')));
});

test('current runtime requires the latest reviewed workflow run, its ledger artifact, and exact health', () => {
  const evidence = validEvidence();
  const observed = validObserved(evidence);
  assert.deepEqual(currentRuntimeFindings(observed.currentRuntime), []);
  assert.notEqual(observed.currentRuntime.mainBefore.object.sha, mergeSha);

  observed.currentRuntime.environments.prod.workflowRuns.push({
    ...observed.currentRuntime.environments.prod.workflowRun,
    id: 20002,
    conclusion: 'failure',
  });
  observed.currentRuntime.environments.test.liveHealth.deployedCommitSha = mergeSha;
  observed.currentRuntime.environments.test.workflowRun.path = '.github/workflows/repair-triage.yml';
  observed.currentRuntime.environments.test.deploymentJob.name = 'unrelated job';
  observed.currentRuntime.environments.test.artifact.created_at = '2026-08-09T09:40:40Z';
  observed.currentRuntime.mainAfter.object.sha = 'f'.repeat(40);
  const findings = currentRuntimeFindings(observed.currentRuntime);
  assert.ok(
    findings.some((finding) => finding.includes('prod current deployment workflow is not the canonical latest')),
  );
  assert.ok(findings.some((finding) => finding.includes('test current live health commit is not exact main')));
  assert.ok(findings.some((finding) => finding.includes('test current deployment workflow immutable workflow path')));
  assert.ok(findings.some((finding) => finding.includes('test job name does not match')));
  assert.ok(findings.some((finding) => finding.includes('test current release ledger is not bounded')));
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

test('trusted GitHub pull-request commit history is complete, bounded, and no-redirect', async () => {
  const requests = [];
  const client = createTrustedGithubClient({
    repository: 'JueZ/api',
    token: 'test-token-placeholder',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const page = Number(new URL(url).searchParams.get('page'));
      const count = page === 1 ? 100 : 1;
      return new Response(
        JSON.stringify(
          Array.from({ length: count }, (_, index) => ({
            sha: page === 2 ? headSha : `${String(page * 1000 + index).padStart(40, '0')}`,
          })),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const commits = await client.getPullRequestCommits(364);
  assert.equal(commits.length, 101);
  assert.equal(commits.at(-1).sha, headSha);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.init.redirect === 'error'));
  assert.ok(requests.every((request) => request.url.includes('/pulls/364/commits?per_page=100&page=')));
});

test('trusted workflow content is fixed-path, exact-ref, and digest-bound', async () => {
  const content = Buffer.from('reviewed workflow bytes\n');
  const requests = [];
  const client = createTrustedGithubClient({
    repository: 'JueZ/api',
    token: 'test-token-placeholder',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          type: 'file',
          path: '.github/workflows/deploy-test.yml',
          encoding: 'base64',
          size: content.length,
          content: content.toString('base64'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  assert.deepEqual(await client.getWorkflowFileDigest('.github/workflows/deploy-test.yml', headSha), {
    path: '.github/workflows/deploy-test.yml',
    ref: headSha,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  assert.equal(requests[0].init.redirect, 'error');
  await assert.rejects(client.getWorkflowFileDigest('.github/workflows/ci.yml', headSha), /not allowlisted/);
  await assert.rejects(client.getWorkflowFileDigest('.github/workflows/deploy-test.yml', 'main'), /exact SHA/);
  assert.equal(requests.length, 1);
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
    GITHUB_WORKFLOW_SHA: mergeSha,
    GITHUB_REPOSITORY: 'JueZ/api',
    GITHUB_RUN_ID: '900',
  };
  assert.deepEqual(trustedControllerFindings(options, { env, checkoutSha: mergeSha }), []);
  assert.ok(
    trustedControllerFindings(options, { env: { ...env, GITHUB_WORKFLOW: 'CI' }, checkoutSha: mergeSha }).length > 0,
  );
  assert.ok(
    trustedControllerFindings(options, { env: { ...env, GITHUB_WORKFLOW_SHA: headSha }, checkoutSha: mergeSha })
      .length > 0,
  );
  assert.ok(trustedControllerFindings(options, { env, checkoutSha: headSha }).length > 0);
});

test('trusted controller workflow SHA must be authenticated as stable protected-main history', () => {
  const options = { controllerSha: mergeSha };
  const main = { object: { type: 'commit', sha: currentMainSha } };
  const comparison = protectedMainComparison();
  assert.deepEqual(protectedMainControllerFindings(main, main, comparison, options), []);
  assert.ok(
    protectedMainControllerFindings(main, main, { ...comparison, merge_base_commit: { sha: headSha } }, options).some(
      (finding) => finding.includes('not an ancestor'),
    ),
  );
  assert.ok(
    protectedMainControllerFindings(main, { object: { type: 'commit', sha: headSha } }, comparison, options).some(
      (finding) => finding.includes('changed'),
    ),
  );
  assert.ok(
    protectedMainControllerFindings(main, main, { ...comparison, url: 'https://api.github.com/stale' }, options).some(
      (finding) => finding.includes('comparison URL'),
    ),
  );
});

test('an open PR cannot self-record any of its commit identities in governance ledgers', () => {
  const options = { prNumber: 364, headSha };
  const pullRequestCommits = [{ sha: mergeSha }, { sha: headSha }];
  assert.deepEqual(
    openPullRequestLedgerFindings(
      {
        [PROGRAM_PATH]: `PR #362 final head \`${baselineSha}\`; current exact-head review is pending.`,
      },
      options,
      pullRequestCommits,
    ),
    [],
  );
  for (const claim of [
    `PR #364 final reviewed head \`${mergeSha}\``,
    `Final reviewed head **${mergeSha}** for PR #364`,
    `Final reviewed head\n\n${mergeSha}\n\nfor PR #364`,
    `PR **#364** has FINAL REPAIR \`${mergeSha.toUpperCase()}\``,
  ]) {
    const findings = openPullRequestLedgerFindings(
      Object.fromEntries(OPEN_PR_LEDGER_PATHS.map((path) => [path, claim])),
      options,
      pullRequestCommits,
    );
    assert.equal(findings.length, OPEN_PR_LEDGER_PATHS.length);
  }
  assert.deepEqual(
    openPullRequestLedgerFindings(
      { [PROGRAM_PATH]: `PR #362 final head \`${baselineSha}\`` },
      options,
      pullRequestCommits,
    ),
    [],
  );
  assert.match(openPullRequestLedgerFindings({}, options, [])[0], /history is missing/);
  assert.match(openPullRequestLedgerFindings({}, options, [{ sha: headSha }, { sha: headSha }])[0], /duplicate SHAs/);
  assert.match(openPullRequestLedgerFindings({}, options, [{ sha: mergeSha }])[0], /does not terminate/);
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
      if (path === '/git/ref/heads/main') return { object: { type: 'commit', sha: currentMainSha } };
      if (path === `/compare/${mergeSha}...${currentMainSha}`) return protectedMainComparison();
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
    GITHUB_WORKFLOW_SHA: mergeSha,
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
      if (path === '/git/ref/heads/main') return { object: { type: 'commit', sha: currentMainSha } };
      if (path === `/compare/${mergeSha}...${currentMainSha}`) return protectedMainComparison();
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
    GITHUB_WORKFLOW_SHA: mergeSha,
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
  client.getPullRequestCommits = async () => [{ sha: headSha }];
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
