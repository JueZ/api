import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateReleaseLedger } from '../validate-release-ledger.mjs';
import { REPOSITORY_ROOT } from './validate-artifacts.mjs';

const PHASE_2_EVIDENCE_PATH = 'docs/agent-learning/evidence/phase-2-versioned-artifacts.json';
const PROGRAM_PATH = 'docs/agent-learning/program.md';
const PROGRAM_EVIDENCE = Object.freeze({
  1: 'docs/agent-learning/evidence/branch-protection-aggregation.json',
  2: PHASE_2_EVIDENCE_PATH,
});
const ACCEPTANCE_CONTEXT_PATHS = Object.freeze([
  PROGRAM_PATH,
  'docs/project-memory/current-state.md',
  'docs/project-memory/decision-log.md',
  'docs/project-memory/deployment-log.md',
  'docs/project-memory/next-steps.md',
]);
const EXPECTED_AGGREGATES = Object.freeze({
  'CI complete': Object.freeze({ path: '.github/workflows/ci.yml', event: 'pull_request' }),
  'Policy complete': Object.freeze({ path: '.github/workflows/policy-check.yml', event: 'pull_request' }),
  'CodeQL complete': Object.freeze({ path: '.github/workflows/codeql.yml', event: 'pull_request' }),
  'Autonomous review complete': Object.freeze({
    path: '.github/workflows/codex-automerge.yml',
    event: 'pull_request_target',
  }),
});
const EXPECTED_DELIVERY_RUNS = Object.freeze({
  mainDelivery: Object.freeze({ path: '.github/workflows/codex-main-delivery.yml', event: 'workflow_run' }),
  mainCi: Object.freeze({ path: '.github/workflows/ci.yml', event: 'workflow_dispatch' }),
  deployTest: Object.freeze({ path: '.github/workflows/deploy-test.yml', event: 'repository_dispatch' }),
  promoteProduction: Object.freeze({
    path: '.github/workflows/promote-production.yml',
    event: 'repository_dispatch',
  }),
});
const EXPECTED_DEPLOYMENT_ENVIRONMENTS = Object.freeze({
  test: 'test',
  prod: 'production',
});
const EXPECTED_DEPLOYMENT_JOBS = Object.freeze({
  test: 'deploy test / deploy test',
  prod: 'promote production / deploy prod',
});
const GITHUB_ACTIONS_BOT = Object.freeze({
  id: 41_898_282,
  login: 'github-actions[bot]',
  type: 'Bot',
});

function addFinding(findings, condition, message) {
  if (!condition) findings.push(message);
}

function exactSha(value) {
  return /^[0-9a-f]{40}$/.test(String(value ?? ''));
}

function exactPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function programPhaseRecord(programText, phase) {
  for (const line of String(programText ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells[1] === String(phase)) {
      return { status: cells[3]?.replaceAll('`', '') || '', line };
    }
  }
  return { status: '', line: '' };
}

export function acceptedPhaseEvidenceFindings(programText, pathExists = existsSync) {
  const findings = [];
  for (const line of String(programText ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const phase = Number(cells[1]);
    if (!Number.isSafeInteger(phase) || cells[3]?.replaceAll('`', '') !== 'accepted') continue;
    const evidencePath = PROGRAM_EVIDENCE[phase];
    addFinding(findings, Boolean(evidencePath), `accepted phase ${phase} has no registered evidence record`);
    if (!evidencePath) continue;
    addFinding(findings, line.includes(evidencePath), `accepted phase ${phase} does not reference ${evidencePath}`);
    addFinding(findings, pathExists(evidencePath), `accepted phase ${phase} evidence is missing: ${evidencePath}`);
  }
  return findings;
}

export function phaseEvidenceNeedsLiveVerification({
  phase,
  changedPaths = [],
  previousProgramText = '',
  currentProgramText = '',
  acceptanceDiff = '',
  verifyAll = false,
}) {
  if (verifyAll) return true;
  const evidencePath = PROGRAM_EVIDENCE[phase];
  if (changedPaths.includes(evidencePath)) return true;
  const previous = programPhaseRecord(previousProgramText, phase);
  const current = programPhaseRecord(currentProgramText, phase);
  if (
    previous.status !== current.status ||
    previous.line.includes(evidencePath) !== current.line.includes(evidencePath)
  ) {
    return true;
  }
  const phasePattern = new RegExp(
    phase === 2
      ? '(?:Phase 2|phase-2-versioned-artifacts|PR #349|9310c94f97541e57f83b186af2cacf989d6f5330)'
      : `(?:Phase ${phase}|phase-${phase})`,
    'i',
  );
  return String(acceptanceDiff ?? '')
    .split('\n')
    .some((line) => /^[+-](?![+-])/.test(line) && phasePattern.test(line));
}

function githubToken(env = process.env, spawn = spawnSync) {
  const configured = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (configured) return configured;
  const completed = spawn('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
  const token = completed.status === 0 ? completed.stdout.trim() : '';
  if (!token) throw new Error('authenticated GitHub evidence verification requires GH_TOKEN or GITHUB_TOKEN');
  return token;
}

export async function authenticatedGitHubJson(path, options = {}) {
  const token = options.token || githubToken(options.env, options.spawn);
  const response = await fetch(`https://api.github.com/${path.replace(/^\//, '')}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'JueZ-api-agent-learning-evidence-validator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`authenticated GitHub request failed with HTTP ${response.status} for ${path}`);
  return response.json();
}

export function workflowRunFindings(run, expected, label = 'workflow run') {
  const findings = [];
  addFinding(findings, run?.id === expected.id, `${label} ID does not match the evidence`);
  addFinding(findings, run?.repository?.full_name === expected.repository, `${label} repository does not match`);
  addFinding(findings, run?.path === expected.path, `${label} immutable workflow path does not match`);
  addFinding(findings, run?.event === expected.event, `${label} event does not match`);
  addFinding(findings, run?.run_attempt === 1, `${label} must be the first workflow attempt`);
  addFinding(findings, run?.status === 'completed', `${label} is not completed`);
  addFinding(findings, run?.conclusion === 'success', `${label} did not conclude successfully`);
  addFinding(findings, run?.head_sha === expected.headSha, `${label} head SHA does not match`);
  if (expected.headBranch) {
    addFinding(findings, run?.head_branch === expected.headBranch, `${label} head branch does not match`);
  }
  if (expected.headRepository) {
    addFinding(
      findings,
      run?.head_repository?.full_name === expected.headRepository,
      `${label} head repository does not match`,
    );
  }
  if (expected.displayTitle) {
    addFinding(findings, run?.display_title === expected.displayTitle, `${label} display title does not match`);
  }
  return findings;
}

export function aggregateCheckFindings(record, checkRun, workflowRun, implementation) {
  const findings = [];
  const expectedWorkflow = EXPECTED_AGGREGATES[record?.context];
  addFinding(findings, Boolean(expectedWorkflow), `unsupported aggregate context ${record?.context ?? '<missing>'}`);
  addFinding(findings, checkRun?.id === record?.checkRunId, `${record?.context} check-run ID does not match`);
  addFinding(findings, checkRun?.name === record?.context, `${record?.context} check-run name does not match`);
  addFinding(findings, checkRun?.head_sha === implementation.headSha, `${record?.context} head SHA does not match`);
  addFinding(findings, checkRun?.status === 'completed', `${record?.context} is not completed`);
  addFinding(findings, checkRun?.conclusion === 'success', `${record?.context} did not conclude successfully`);
  addFinding(findings, checkRun?.app?.slug === 'github-actions', `${record?.context} app is not github-actions`);
  addFinding(findings, checkRun?.app?.slug === record?.appSlug, `${record?.context} recorded app does not match`);
  addFinding(
    findings,
    checkRun?.app?.id === 15368,
    `${record?.context} is not bound to the expected GitHub Actions app`,
  );
  if (record?.context === 'Autonomous review complete') {
    const expectedExternalId = `juez-autonomous-review-decision:v1:JueZ/api:pull:${implementation.number}:head:${implementation.headSha}:run:${record.workflowRunId}`;
    addFinding(
      findings,
      checkRun?.external_id === expectedExternalId,
      'Autonomous review complete external identity does not bind the exact PR, head, and run',
    );
  } else {
    addFinding(
      findings,
      checkRun?.details_url ===
        `https://github.com/JueZ/api/actions/runs/${record?.workflowRunId}/job/${record?.checkRunId}`,
      `${record?.context} details URL does not bind the exact workflow and check run`,
    );
  }
  if (expectedWorkflow) {
    // The authenticated Actions REST run resource reports the PR source head for
    // pull_request_target. That is distinct from the runner's base-context
    // GITHUB_SHA. The authenticated PR record binds the source head and base;
    // the custom review check external identity binds this exact workflow run.
    findings.push(
      ...workflowRunFindings(
        workflowRun,
        {
          id: record.workflowRunId,
          repository: 'JueZ/api',
          path: expectedWorkflow.path,
          event: expectedWorkflow.event,
          headSha: implementation.headSha,
          headBranch: implementation.branch,
          headRepository: 'JueZ/api',
        },
        `${record.context} workflow run`,
      ),
    );
  }
  return findings;
}

function pullRequestFindings(evidence, pullRequest) {
  const findings = [];
  const implementation = evidence?.implementation?.pullRequest ?? {};
  addFinding(findings, pullRequest?.number === implementation.number, 'implementation PR number does not match');
  addFinding(findings, pullRequest?.html_url === implementation.url, 'implementation PR URL does not match');
  addFinding(
    findings,
    pullRequest?.state === 'closed' && Boolean(pullRequest?.merged_at),
    'implementation PR is not merged',
  );
  addFinding(
    findings,
    pullRequest?.merged_at === implementation.mergedAt,
    'implementation PR merge time does not match',
  );
  addFinding(findings, pullRequest?.head?.ref === implementation.branch, 'implementation PR branch does not match');
  addFinding(findings, pullRequest?.head?.sha === implementation.headSha, 'implementation PR head SHA does not match');
  addFinding(
    findings,
    pullRequest?.base?.sha === evidence?.implementation?.baselineMainSha,
    'implementation PR base SHA does not match',
  );
  addFinding(
    findings,
    pullRequest?.merge_commit_sha === implementation.mergeSha,
    'implementation PR merge SHA does not match',
  );
  return findings;
}

function publicHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function githubActionsBot(actor) {
  return (
    actor?.id === GITHUB_ACTIONS_BOT.id &&
    actor?.login === GITHUB_ACTIONS_BOT.login &&
    actor?.type === GITHUB_ACTIONS_BOT.type
  );
}

export function deploymentJobFindings(record, job, environment, evidence) {
  const findings = [];
  const expectedName = EXPECTED_DEPLOYMENT_JOBS[environment];
  const sourceSha = evidence?.implementation?.pullRequest?.mergeSha;
  const expectedWorkflowName =
    environment === 'test'
      ? `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`
      : `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`;
  addFinding(findings, Boolean(expectedName), `${environment} is not a supported deployment job environment`);
  addFinding(findings, job?.id === record.deploymentJobId, `${environment} deployment job ID does not match`);
  addFinding(findings, job?.run_id === record.workflowRunId, `${environment} deployment job run does not match`);
  addFinding(
    findings,
    job?.workflow_name === expectedWorkflowName,
    `${environment} deployment workflow name does not match`,
  );
  addFinding(findings, job?.name === expectedName, `${environment} deployment job name does not match`);
  addFinding(findings, job?.head_sha === sourceSha, `${environment} deployment job head SHA does not match`);
  addFinding(findings, job?.head_branch === 'main', `${environment} deployment job head branch is not main`);
  addFinding(findings, job?.status === 'completed', `${environment} deployment job is not completed`);
  addFinding(findings, job?.conclusion === 'success', `${environment} deployment job did not succeed`);
  addFinding(
    findings,
    job?.runner_group_name === 'GitHub Actions',
    `${environment} deployment job did not run on GitHub Actions`,
  );
  addFinding(
    findings,
    job?.html_url === `https://github.com/JueZ/api/actions/runs/${record.workflowRunId}/job/${record.deploymentJobId}`,
    `${environment} deployment job URL does not match`,
  );
  return findings;
}

export function deploymentEnvironmentFindings(
  record,
  ledger,
  deployment,
  deploymentStatuses,
  deploymentJob,
  liveHealth,
  environment,
  evidence,
) {
  const findings = [];
  const expectedEnvironment = EXPECTED_DEPLOYMENT_ENVIRONMENTS[environment];
  addFinding(findings, Boolean(expectedEnvironment), `${environment} is not a supported deployment environment`);
  addFinding(findings, exactPositiveInteger(record.deploymentId), `${environment} deployment ID is invalid`);
  addFinding(
    findings,
    exactPositiveInteger(record.deploymentStatusId),
    `${environment} deployment status ID is invalid`,
  );
  addFinding(findings, exactPositiveInteger(record.deploymentJobId), `${environment} deployment job ID is invalid`);
  addFinding(findings, deployment?.id === record.deploymentId, `${environment} deployment ID does not match`);
  addFinding(
    findings,
    deployment?.sha === evidence?.implementation?.pullRequest?.mergeSha,
    `${environment} deployment SHA does not match the implementation merge`,
  );
  addFinding(findings, deployment?.ref === 'main', `${environment} deployment ref is not main`);
  addFinding(
    findings,
    deployment?.environment === expectedEnvironment,
    `${environment} deployment is not bound to the expected GitHub environment`,
  );
  addFinding(findings, deployment?.task === 'deploy', `${environment} deployment task is not deploy`);
  addFinding(
    findings,
    githubActionsBot(deployment?.creator),
    `${environment} deployment creator is not the expected GitHub Actions bot`,
  );

  findings.push(...deploymentJobFindings(record, deploymentJob, environment, evidence));

  const statuses = Array.isArray(deploymentStatuses) ? deploymentStatuses : [];
  const status = statuses.find((candidate) => candidate.id === record.deploymentStatusId);
  addFinding(findings, Boolean(status), `${environment} successful deployment status ID is unavailable`);
  addFinding(findings, status?.state === 'success', `${environment} deployment status is not successful`);
  addFinding(
    findings,
    status?.environment === expectedEnvironment,
    `${environment} deployment status is not bound to the expected GitHub environment`,
  );
  addFinding(
    findings,
    githubActionsBot(status?.creator),
    `${environment} deployment status creator is not the expected GitHub Actions bot`,
  );
  // GitHub's deployment schema has no immutable Actions-job relation. The
  // log URL is corroboration only; provenance comes from the authenticated job
  // plus the unique exact-run release-ledger artifact validated below.
  addFinding(
    findings,
    status?.log_url === deploymentJob?.html_url,
    `${environment} deployment status job URL does not match the authenticated deployment job`,
  );

  const deploymentOrigin = publicHttpsOrigin(status?.environment_url);
  const ledgerOrigin = publicHttpsOrigin(ledger?.apiBaseUrl);
  addFinding(findings, Boolean(deploymentOrigin), `${environment} deployment environment URL is not public HTTPS`);
  addFinding(findings, Boolean(ledgerOrigin), `${environment} ledger API URL is not public HTTPS`);
  addFinding(
    findings,
    Boolean(deploymentOrigin) && deploymentOrigin === ledgerOrigin,
    `${environment} ledger API URL does not match the GitHub deployment environment URL`,
  );
  addFinding(
    findings,
    liveHealth?.environmentName === environment,
    `${environment} live /health environment does not match`,
  );
  addFinding(
    findings,
    liveHealth?.deploymentRunId === String(record.workflowRunId),
    `${environment} live /health deployment run does not match`,
  );
  return findings;
}

function deploymentLedgerFindings(
  record,
  ledger,
  artifactList,
  deployment,
  deploymentStatuses,
  deploymentJob,
  liveHealth,
  environment,
  evidence,
) {
  const findings = [];
  const artifactName = `release-ledger-${environment}-${record.sourceSha}-${record.deliveryCorrelation}`;
  const artifacts = Array.isArray(artifactList?.artifacts) ? artifactList.artifacts : [];
  // Artifacts are issued within a specific Actions run. Requiring the unique
  // name, recorded ID, embedded run identity, and downloaded ledger content is
  // the independently authenticated run-bound attestation.
  const namedArtifacts = artifacts.filter((artifact) => artifact.name === artifactName);
  const matchingArtifact = namedArtifacts.find((artifact) => artifact.id === record.releaseLedgerArtifactId);
  addFinding(
    findings,
    namedArtifacts.length === 1,
    `${environment} release-ledger artifact name is not unique within the exact workflow run`,
  );
  addFinding(findings, Boolean(matchingArtifact), `${environment} release-ledger artifact ID is unavailable`);
  addFinding(
    findings,
    matchingArtifact?.name === artifactName,
    `${environment} release-ledger artifact name does not match`,
  );
  addFinding(findings, matchingArtifact?.expired === false, `${environment} release-ledger artifact is expired`);
  addFinding(
    findings,
    matchingArtifact?.workflow_run?.id === record.workflowRunId,
    `${environment} release-ledger artifact is not bound to the exact workflow run`,
  );
  addFinding(
    findings,
    matchingArtifact?.workflow_run?.head_sha === evidence?.implementation?.pullRequest?.mergeSha,
    `${environment} release-ledger artifact head SHA does not match the implementation merge`,
  );
  addFinding(
    findings,
    matchingArtifact?.workflow_run?.head_branch === 'main',
    `${environment} release-ledger artifact head branch is not main`,
  );

  for (const error of validateReleaseLedger(ledger, { expectedDeliveryCorrelation: record.deliveryCorrelation })) {
    findings.push(`${environment} release ledger: ${error}`);
  }
  addFinding(findings, ledger?.environment === environment, `${environment} release-ledger environment does not match`);
  addFinding(
    findings,
    ledger?.workflowRunId === String(record.workflowRunId),
    `${environment} ledger run ID does not match`,
  );
  addFinding(
    findings,
    ledger?.deployedCommit === record.sourceSha,
    `${environment} ledger deployed commit does not match`,
  );
  addFinding(findings, ledger?.sourceRef === record.sourceSha, `${environment} ledger source ref does not match`);
  addFinding(findings, ledger?.smokeResults?.status === 'passed', `${environment} public smoke did not pass`);
  addFinding(
    findings,
    ledger?.authenticatedSmokeResults?.status === 'passed',
    `${environment} authenticated smoke did not pass`,
  );
  addFinding(findings, ledger?.telemetryCheckResult?.status === 'passed', `${environment} telemetry did not pass`);
  addFinding(
    findings,
    record.publicSmoke === 'passed',
    `${environment} evidence does not record public smoke as passed`,
  );
  addFinding(
    findings,
    record.authenticatedSmoke === 'passed',
    `${environment} evidence does not record authenticated smoke as passed`,
  );
  addFinding(findings, record.telemetry === 'passed', `${environment} evidence does not record telemetry as passed`);
  addFinding(
    findings,
    record.releaseLedger === 'validated',
    `${environment} evidence does not record a validated ledger`,
  );
  addFinding(
    findings,
    record.runtimeTruth?.status === 'verified',
    `${environment} evidence does not record verified runtime truth`,
  );
  addFinding(findings, record.runtimeTruth?.failures === 0, `${environment} runtime truth records failures`);
  addFinding(findings, record.runtimeTruth?.blockers === 0, `${environment} runtime truth records blockers`);
  addFinding(
    findings,
    !Number.isNaN(Date.parse(record.runtimeTruth?.checkedAt)),
    `${environment} runtime-truth time is invalid`,
  );
  addFinding(findings, liveHealth?.status === 'ok', `${environment} live /health status is not ok`);
  addFinding(
    findings,
    liveHealth?.deployedCommitSha === evidence.implementation.pullRequest.mergeSha,
    `${environment} live /health commit does not match the implementation merge`,
  );
  findings.push(
    ...deploymentEnvironmentFindings(
      record,
      ledger,
      deployment,
      deploymentStatuses,
      deploymentJob,
      liveHealth,
      environment,
      evidence,
    ),
  );
  return findings;
}

export function phase2EvidenceFindings(evidence, observed) {
  const findings = [];
  addFinding(findings, evidence?.schemaVersion === 1, 'Phase 2 evidence schemaVersion must be 1');
  addFinding(findings, evidence?.repository === 'JueZ/api', 'Phase 2 evidence repository must be JueZ/api');
  addFinding(findings, evidence?.phase === 2, 'Phase 2 evidence phase must be 2');
  const implementation = evidence?.implementation?.pullRequest ?? {};
  addFinding(findings, exactSha(evidence?.implementation?.baselineMainSha), 'baseline main SHA is not exact');
  addFinding(findings, exactSha(implementation.headSha), 'implementation head SHA is not exact');
  addFinding(findings, exactSha(implementation.mergeSha), 'implementation merge SHA is not exact');
  findings.push(...pullRequestFindings(evidence, observed?.pullRequest));

  const aggregateRecords = evidence?.implementation?.exactHeadAggregates ?? [];
  addFinding(findings, aggregateRecords.length === 4, 'Phase 2 evidence must contain exactly four aggregates');
  const recordedContexts = new Set(aggregateRecords.map((record) => record.context));
  addFinding(findings, recordedContexts.size === 4, 'Phase 2 aggregate contexts must be unique');
  for (const context of Object.keys(EXPECTED_AGGREGATES)) {
    addFinding(findings, recordedContexts.has(context), `Phase 2 evidence is missing ${context}`);
  }
  for (const record of aggregateRecords) {
    addFinding(findings, exactPositiveInteger(record.checkRunId), `${record.context} check-run ID is invalid`);
    addFinding(findings, exactPositiveInteger(record.workflowRunId), `${record.context} workflow-run ID is invalid`);
    findings.push(
      ...aggregateCheckFindings(
        record,
        observed?.checkRuns?.[String(record.checkRunId)],
        observed?.workflowRuns?.[String(record.workflowRunId)],
        implementation,
      ),
    );
  }

  const delivery = evidence?.implementation?.postMergeDelivery ?? {};
  for (const [key, expectedWorkflow] of Object.entries(EXPECTED_DELIVERY_RUNS)) {
    const record = delivery[key] ?? {};
    addFinding(findings, exactPositiveInteger(record.workflowRunId), `${key} workflow-run ID is invalid`);
    addFinding(findings, record.sourceSha === implementation.mergeSha, `${key} source SHA does not match the merge`);
    addFinding(findings, record.conclusion === 'success', `${key} evidence conclusion is not success`);
    const expected = {
      id: record.workflowRunId,
      repository: 'JueZ/api',
      path: expectedWorkflow.path,
      event: expectedWorkflow.event,
      headSha: implementation.mergeSha,
    };
    if (key === 'deployTest') expected.displayTitle = `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`;
    if (key === 'promoteProduction') {
      expected.displayTitle = `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`;
    }
    findings.push(
      ...workflowRunFindings(observed?.workflowRuns?.[String(record.workflowRunId)], expected, `${key} workflow run`),
    );
  }

  findings.push(
    ...deploymentLedgerFindings(
      delivery.deployTest ?? {},
      observed?.ledgers?.test,
      observed?.artifacts?.[String(delivery.deployTest?.workflowRunId)],
      observed?.deployments?.test,
      observed?.deploymentStatuses?.test,
      observed?.deploymentJobs?.test,
      observed?.liveHealth?.test,
      'test',
      evidence,
    ),
  );
  findings.push(
    ...deploymentLedgerFindings(
      delivery.promoteProduction ?? {},
      observed?.ledgers?.prod,
      observed?.artifacts?.[String(delivery.promoteProduction?.workflowRunId)],
      observed?.deployments?.prod,
      observed?.deploymentStatuses?.prod,
      observed?.deploymentJobs?.prod,
      observed?.liveHealth?.prod,
      'prod',
      evidence,
    ),
  );
  const testStatus = observed?.deploymentStatuses?.test?.find(
    (status) => status.id === delivery.deployTest?.deploymentStatusId,
  );
  const productionStatus = observed?.deploymentStatuses?.prod?.find(
    (status) => status.id === delivery.promoteProduction?.deploymentStatusId,
  );
  const testOrigin = publicHttpsOrigin(testStatus?.environment_url);
  const productionOrigin = publicHttpsOrigin(productionStatus?.environment_url);
  addFinding(
    findings,
    Boolean(testOrigin) && Boolean(productionOrigin) && testOrigin !== productionOrigin,
    'test and production must resolve to distinct GitHub deployment environment URLs',
  );
  return findings;
}

async function findJsonFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findJsonFiles(path)));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}

async function downloadLedger(repository, record, environment, options = {}) {
  const token = options.token || githubToken(options.env, options.spawn);
  const artifactName = `release-ledger-${environment}-${record.sourceSha}-${record.deliveryCorrelation}`;
  const directory = await mkdtemp(join(tmpdir(), 'agent-learning-evidence-'));
  try {
    const completed = (options.spawn || spawnSync)(
      'gh',
      [
        'run',
        'download',
        String(record.workflowRunId),
        '--repo',
        repository,
        '--name',
        artifactName,
        '--dir',
        directory,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token },
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (completed.status !== 0) throw new Error(`could not download authenticated ${environment} release ledger`);
    const files = await findJsonFiles(directory);
    if (files.length !== 1)
      throw new Error(`${environment} release-ledger artifact must contain exactly one JSON file`);
    return JSON.parse(await readFile(files[0], 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function deploymentHealthUrl(environmentUrl) {
  const origin = publicHttpsOrigin(environmentUrl);
  if (!origin) throw new Error('GitHub deployment environment URL is not a public HTTPS origin');
  return new URL('/health', origin).toString();
}

async function fetchLiveHealth(environmentUrl) {
  const response = await fetch(deploymentHealthUrl(environmentUrl), {
    headers: { Accept: 'application/json', 'User-Agent': 'JueZ-api-agent-learning-evidence-validator' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`live /health returned HTTP ${response.status}`);
  return response.json();
}

async function collectPhase2Observed(evidence, options = {}) {
  const repository = evidence.repository;
  const token = options.token || githubToken(options.env, options.spawn);
  const implementation = evidence.implementation.pullRequest;
  const aggregateRecords = evidence.implementation.exactHeadAggregates;
  const deliveryRecords = Object.values(evidence.implementation.postMergeDelivery);
  const workflowRunIds = [...new Set([...aggregateRecords, ...deliveryRecords].map((record) => record.workflowRunId))];
  const observed = {
    pullRequest: await authenticatedGitHubJson(`repos/${repository}/pulls/${implementation.number}`, { token }),
    checkRuns: {},
    workflowRuns: {},
    artifacts: {},
    deployments: {},
    deploymentStatuses: {},
    deploymentJobs: {},
    ledgers: {},
    liveHealth: {},
  };
  await Promise.all(
    aggregateRecords.map(async (record) => {
      observed.checkRuns[String(record.checkRunId)] = await authenticatedGitHubJson(
        `repos/${repository}/check-runs/${record.checkRunId}`,
        { token },
      );
    }),
  );
  await Promise.all(
    workflowRunIds.map(async (runId) => {
      observed.workflowRuns[String(runId)] = await authenticatedGitHubJson(
        `repos/${repository}/actions/runs/${runId}`,
        { token },
      );
    }),
  );
  for (const [environment, record] of [
    ['test', evidence.implementation.postMergeDelivery.deployTest],
    ['prod', evidence.implementation.postMergeDelivery.promoteProduction],
  ]) {
    observed.deployments[environment] = await authenticatedGitHubJson(
      `repos/${repository}/deployments/${record.deploymentId}`,
      { token },
    );
    observed.deploymentStatuses[environment] = await authenticatedGitHubJson(
      `repos/${repository}/deployments/${record.deploymentId}/statuses?per_page=100`,
      { token },
    );
    observed.deploymentJobs[environment] = await authenticatedGitHubJson(
      `repos/${repository}/actions/jobs/${record.deploymentJobId}`,
      { token },
    );
    observed.artifacts[String(record.workflowRunId)] = await authenticatedGitHubJson(
      `repos/${repository}/actions/runs/${record.workflowRunId}/artifacts?per_page=100`,
      { token },
    );
    observed.ledgers[environment] = await downloadLedger(repository, record, environment, { ...options, token });
    const deploymentStatus = observed.deploymentStatuses[environment].find(
      (status) => status.id === record.deploymentStatusId,
    );
    if (!deploymentStatus) throw new Error(`${environment} successful deployment status ID is unavailable`);
    observed.liveHealth[environment] = await fetchLiveHealth(deploymentStatus.environment_url);
  }
  return observed;
}

function gitOutput(args) {
  const completed = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`git ${args[0]} failed while resolving program-evidence changes`);
  return completed.stdout;
}

function evidenceChangeContext(options = {}) {
  const verifyAll = options.verifyAll === true || process.env.GITHUB_ACTIONS !== 'true';
  if (verifyAll) return { verifyAll, changedPaths: [], previousProgramText: '', acceptanceDiff: '' };
  const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'HEAD^';
  const range = process.env.GITHUB_BASE_REF ? `${baseRef}...HEAD` : `${baseRef}..HEAD`;
  const changedPaths = gitOutput([
    'diff',
    '--name-only',
    range,
    '--',
    ...Object.values(PROGRAM_EVIDENCE),
    ...ACCEPTANCE_CONTEXT_PATHS,
  ])
    .split('\n')
    .filter(Boolean);
  const previousProgramText = gitOutput(['show', `${baseRef}:${PROGRAM_PATH}`]);
  const acceptanceDiff = gitOutput([
    'diff',
    '--unified=0',
    range,
    '--',
    ...ACCEPTANCE_CONTEXT_PATHS.filter((path) => path !== PROGRAM_PATH),
  ]);
  return { verifyAll, changedPaths, previousProgramText, acceptanceDiff };
}

export async function verifyChangedProgramEvidence(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const programPath = join(repositoryRoot, PROGRAM_PATH);
  const evidencePath = join(repositoryRoot, PHASE_2_EVIDENCE_PATH);
  if (!existsSync(programPath)) return { verified: 0, errors: [`${PROGRAM_PATH}: authoritative program is missing`] };
  const programText = await readFile(programPath, 'utf8');
  const errors = acceptedPhaseEvidenceFindings(programText, (path) => existsSync(join(repositoryRoot, path)));
  const changeContext = evidenceChangeContext(options);
  const verifyPhase2 = phaseEvidenceNeedsLiveVerification({
    phase: 2,
    currentProgramText: programText,
    ...changeContext,
  });
  if (errors.length > 0 || !verifyPhase2) return { verified: 0, errors };
  if (!existsSync(evidencePath)) {
    return { verified: 0, errors: [`${PHASE_2_EVIDENCE_PATH}: registered evidence is missing`] };
  }
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const observed = await collectPhase2Observed(evidence, options);
  return {
    verified: 1,
    errors: [
      ...errors,
      ...phase2EvidenceFindings(evidence, observed).map((finding) => `${PHASE_2_EVIDENCE_PATH}: ${finding}`),
    ],
  };
}
