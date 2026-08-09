#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { validateReleaseLedger } from '../validate-release-ledger.mjs';
import { REPOSITORY_ROOT } from './validate-artifacts.mjs';
import {
  allowedRuntimeOrigin,
  createTrustedGithubClient,
  fetchAllowedRuntimeHealth,
  parseStrictJson,
  protectedMainControllerFindings,
  readSingleJsonArchive,
  TRUSTED_RUNTIME_HOSTS as ACCEPTANCE_RUNTIME_HOSTS,
  verifyArtifactArchiveDigest,
} from './trusted-evidence-primitives.mjs';

export { ACCEPTANCE_RUNTIME_HOSTS, protectedMainControllerFindings };

export const PROGRAM_PATH = 'docs/agent-learning/program.md';
export const PHASE_2_EVIDENCE_PATH = 'docs/agent-learning/evidence/phase-2-versioned-artifacts.json';
export const OPEN_PR_LEDGER_PATHS = Object.freeze([
  PROGRAM_PATH,
  'docs/project-memory/current-state.md',
  'docs/project-memory/known-issues.md',
  'docs/project-memory/next-steps.md',
]);
export const PROGRAM_EVIDENCE = Object.freeze({
  1: 'docs/agent-learning/evidence/branch-protection-aggregation.json',
  2: PHASE_2_EVIDENCE_PATH,
});
export const PHASE_2_IMPLEMENTATION_IDENTITY = Object.freeze({
  pullRequestNumber: 349,
  baselineMainSha: 'eab88f735d3644181d2a043156970f0df02e3ff8',
  branch: 'codex/agent-learning-phase-2-artifacts',
  headSha: '7188188cc0b3fd1a58a5ee14ae5335158294135c',
  mergeSha: '9310c94f97541e57f83b186af2cacf989d6f5330',
});

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
const EXPECTED_DEPLOYMENT_JOBS = Object.freeze({
  test: 'deploy test / deploy test',
  prod: 'promote production / deploy prod',
});
const EXPECTED_DEPLOYMENT_WORKFLOW_FILES = Object.freeze({
  shared: Object.freeze({
    path: '.github/workflows/deploy-environment.yml',
    sha256: 'cd36744ebf07c466d407ca4ecd83751e2f6445263a7bab90145c69326d844be9',
  }),
  test: Object.freeze({
    path: '.github/workflows/deploy-test.yml',
    sha256: 'be874930e0d375765afe67d50429744f5f629d129b944cae601e915ea16c7275',
  }),
  prod: Object.freeze({
    path: '.github/workflows/promote-production.yml',
    sha256: 'eb87a6f7fd479226a68e0edd7f9867ce9b6c3bac853ffae0ed687734e0944387',
  }),
});
const DEPLOYMENT_WORKFLOW_PATHS = Object.freeze(
  Object.values(EXPECTED_DEPLOYMENT_WORKFLOW_FILES).map((record) => record.path),
);
const GITHUB_ACTIONS_APP = Object.freeze({ id: 15_368, slug: 'github-actions' });
const CONTROLLER_WORKFLOW = 'Codex Auto-Merge';
const CONTROLLER_WORKFLOW_PATH = '.github/workflows/codex-automerge.yml';
const REVIEW_CLAIM_VERSION = 'v4';
const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024;
const EXACT_SHA = /^[0-9a-f]{40}$/;
const EXACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const PROGRAM_PHASES = Object.freeze([1, 2, 3, 4, 5]);
const PROGRAM_STATUSES = new Set(['not_started', 'in_progress', 'accepted', 'blocked', 'superseded']);
const PROGRAM_TABLE_HEADER = Object.freeze([
  'Phase',
  'Scope',
  'Status',
  'PR and exact commit references',
  'Accepted evidence',
  'Remaining risk',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addFinding(findings, condition, message) {
  if (!condition) findings.push(message);
}

function exactPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function latestByNumericId(records) {
  return [...records].sort((left, right) => Number(right?.id) - Number(left?.id))[0];
}

function exactKeysFindings(value, requiredKeys, label) {
  if (!isRecord(value)) return [`${label} must be an object`];
  const findings = [];
  const required = new Set(requiredKeys);
  for (const key of requiredKeys) addFinding(findings, Object.hasOwn(value, key), `${label}.${key} is required`);
  for (const key of Object.keys(value)) addFinding(findings, required.has(key), `${label}.${key} is not allowed`);
  return findings;
}

function markdownTableCells(line) {
  if (!line.startsWith('|') || !line.endsWith('|')) return undefined;
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

export function parseProgramPhaseTable(programText) {
  const lines = String(programText ?? '').split('\n');
  const headings = lines
    .map((line, index) => ({ cells: markdownTableCells(line), index }))
    .filter(({ cells }) => cells?.length === PROGRAM_TABLE_HEADER.length && cells[0] === 'Phase');
  const findings = [];
  addFinding(findings, headings.length === 1, 'program must contain exactly one phase table');
  const records = new Map();
  if (headings.length !== 1) return { records, findings };
  const heading = headings[0];
  addFinding(
    findings,
    heading.cells.every((cell, index) => cell === PROGRAM_TABLE_HEADER[index]),
    'program phase table header is invalid',
  );
  const separator = markdownTableCells(lines[heading.index + 1] || '');
  addFinding(
    findings,
    separator?.length === PROGRAM_TABLE_HEADER.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell)),
    'program phase table separator is invalid',
  );
  for (let index = heading.index + 2; index < lines.length; index += 1) {
    const cells = markdownTableCells(lines[index]);
    if (!cells || !/^\d+$/.test(cells[0] || '')) continue;
    addFinding(findings, cells.length === PROGRAM_TABLE_HEADER.length, `program phase row ${index + 1} is malformed`);
    if (cells.length !== PROGRAM_TABLE_HEADER.length) continue;
    const phase = Number(cells[0]);
    addFinding(findings, PROGRAM_PHASES.includes(phase), `program phase row ${index + 1} has an invalid phase`);
    const statusMatch = cells[2].match(/^`([a-z_]+)`$/);
    const status = statusMatch?.[1] || '';
    addFinding(findings, PROGRAM_STATUSES.has(status), `program phase ${cells[0]} has an invalid status`);
    if (!PROGRAM_PHASES.includes(phase)) continue;
    addFinding(findings, !records.has(phase), `program phase ${phase} is duplicated`);
    if (!records.has(phase)) records.set(phase, { status, line: lines[index] });
  }
  for (const phase of PROGRAM_PHASES) addFinding(findings, records.has(phase), `program phase ${phase} is missing`);
  return { records, findings };
}

function programPhaseRecord(programText, phase) {
  return parseProgramPhaseTable(programText).records.get(phase) || { status: '', line: '' };
}

export function acceptedPhaseEvidenceFindings(programText, pathExists = existsSync) {
  const table = parseProgramPhaseTable(programText);
  const findings = [...table.findings];
  for (const [phase, record] of table.records) {
    if (record.status !== 'accepted') continue;
    const evidencePath = PROGRAM_EVIDENCE[phase];
    addFinding(findings, Boolean(evidencePath), `accepted phase ${phase} has no registered evidence record`);
    if (!evidencePath) continue;
    addFinding(
      findings,
      record.line.includes(evidencePath),
      `accepted phase ${phase} does not reference ${evidencePath}`,
    );
    addFinding(findings, pathExists(evidencePath), `accepted phase ${phase} evidence is missing: ${evidencePath}`);
  }
  return findings;
}

export function openPullRequestLedgerFindings(records, options, pullRequestCommits) {
  const findings = [];
  const prNumber = Number(options?.prNumber);
  if (!exactPositiveInteger(prNumber)) return ['open pull-request ledger PR number is invalid'];
  const headSha = typeof options?.headSha === 'string' ? options.headSha.toLowerCase() : '';
  if (!EXACT_SHA.test(headSha)) return ['open pull-request ledger head SHA is invalid'];
  if (!Array.isArray(pullRequestCommits) || pullRequestCommits.length === 0) {
    return ['open pull-request commit history is missing'];
  }
  const commitShas = [];
  for (const commit of pullRequestCommits) {
    const sha = typeof commit?.sha === 'string' ? commit.sha.toLowerCase() : '';
    if (!EXACT_SHA.test(sha)) return ['open pull-request commit history contains an invalid SHA'];
    commitShas.push(sha);
  }
  if (new Set(commitShas).size !== commitShas.length) {
    return ['open pull-request commit history contains duplicate SHAs'];
  }
  if (commitShas.at(-1) !== headSha) {
    return ['open pull-request commit history does not terminate at the exact candidate head'];
  }
  for (const [path, text] of Object.entries(isRecord(records) ? records : {})) {
    if (typeof text !== 'string') {
      findings.push(`${path} open pull-request ledger content is invalid`);
      continue;
    }
    const normalizedText = text.toLowerCase();
    for (const sha of commitShas) {
      addFinding(
        findings,
        !normalizedText.includes(sha),
        `${path} cannot self-record open pull-request commit ${sha}; record exact identities only from later authenticated evidence`,
      );
    }
  }
  return findings;
}

export function phaseEvidenceNeedsLiveVerification({
  phase,
  changedPaths = [],
  previousProgramText = '',
  currentProgramText = '',
  verifyAll = false,
}) {
  if (verifyAll) return true;
  const evidencePath = PROGRAM_EVIDENCE[phase];
  if (changedPaths.includes(evidencePath)) return true;
  const previousTable = parseProgramPhaseTable(previousProgramText);
  const currentTable = parseProgramPhaseTable(currentProgramText);
  if (previousTable.findings.length > 0 || currentTable.findings.length > 0) return true;
  const previous = programPhaseRecord(previousProgramText, phase);
  const current = programPhaseRecord(currentProgramText, phase);
  if (changedPaths.includes(PROGRAM_PATH) && current.status === 'accepted') return true;
  return (
    previous.status !== current.status || previous.line.includes(evidencePath) !== current.line.includes(evidencePath)
  );
}

function publicPullRequestUrl(value, number) {
  return value === `https://github.com/JueZ/api/pull/${number}`;
}

export function phase2ImplementationIdentityFindings(evidence) {
  const findings = [];
  const implementation = evidence?.implementation;
  const pullRequest = implementation?.pullRequest;
  addFinding(
    findings,
    implementation?.baselineMainSha === PHASE_2_IMPLEMENTATION_IDENTITY.baselineMainSha,
    'Phase 2 baselineMainSha does not match the immutable implementation identity',
  );
  addFinding(
    findings,
    pullRequest?.number === PHASE_2_IMPLEMENTATION_IDENTITY.pullRequestNumber,
    'Phase 2 implementation PR number does not match the immutable implementation identity',
  );
  addFinding(
    findings,
    pullRequest?.url === `https://github.com/JueZ/api/pull/${PHASE_2_IMPLEMENTATION_IDENTITY.pullRequestNumber}`,
    'Phase 2 implementation PR URL does not match the immutable implementation identity',
  );
  addFinding(
    findings,
    pullRequest?.branch === PHASE_2_IMPLEMENTATION_IDENTITY.branch,
    'Phase 2 implementation branch does not match the immutable implementation identity',
  );
  addFinding(
    findings,
    pullRequest?.headSha === PHASE_2_IMPLEMENTATION_IDENTITY.headSha,
    'Phase 2 implementation head SHA does not match the immutable implementation identity',
  );
  addFinding(
    findings,
    pullRequest?.mergeSha === PHASE_2_IMPLEMENTATION_IDENTITY.mergeSha,
    'Phase 2 implementation merge SHA does not match the immutable implementation identity',
  );
  return findings;
}

export function phase2EvidenceShapeFindings(evidence) {
  const findings = [];
  findings.push(...exactKeysFindings(evidence, ['schemaVersion', 'repository', 'phase', 'implementation'], 'evidence'));
  if (!isRecord(evidence)) return findings;
  addFinding(findings, evidence.schemaVersion === 1, 'evidence.schemaVersion must be 1');
  addFinding(findings, evidence.repository === 'JueZ/api', 'evidence.repository must be JueZ/api');
  addFinding(findings, evidence.phase === 2, 'evidence.phase must be 2');

  const implementation = evidence.implementation;
  findings.push(
    ...exactKeysFindings(
      implementation,
      ['baselineMainSha', 'pullRequest', 'exactHeadAggregates', 'postMergeDelivery'],
      'evidence.implementation',
    ),
  );
  if (!isRecord(implementation)) return findings;
  addFinding(findings, EXACT_SHA.test(implementation.baselineMainSha), 'baselineMainSha must be an exact SHA');

  const pullRequest = implementation.pullRequest;
  findings.push(
    ...exactKeysFindings(
      pullRequest,
      ['number', 'url', 'branch', 'headSha', 'mergeSha', 'mergedAt'],
      'evidence.implementation.pullRequest',
    ),
  );
  if (isRecord(pullRequest)) {
    addFinding(findings, exactPositiveInteger(pullRequest.number), 'implementation PR number is invalid');
    addFinding(
      findings,
      publicPullRequestUrl(pullRequest.url, pullRequest.number),
      'implementation PR URL is not canonical',
    );
    addFinding(
      findings,
      typeof pullRequest.branch === 'string' && /^codex\/[a-z0-9._/-]+$/.test(pullRequest.branch),
      'implementation PR branch is invalid',
    );
    addFinding(findings, EXACT_SHA.test(pullRequest.headSha), 'implementation head SHA must be exact');
    addFinding(findings, EXACT_SHA.test(pullRequest.mergeSha), 'implementation merge SHA must be exact');
    addFinding(findings, !Number.isNaN(Date.parse(pullRequest.mergedAt)), 'implementation merge time is invalid');
  }
  findings.push(...phase2ImplementationIdentityFindings(evidence));

  const aggregates = implementation.exactHeadAggregates;
  addFinding(
    findings,
    Array.isArray(aggregates) && aggregates.length === 4,
    'exactHeadAggregates must contain four records',
  );
  if (Array.isArray(aggregates)) {
    const contexts = new Set();
    aggregates.forEach((record, index) => {
      const label = `evidence.implementation.exactHeadAggregates[${index}]`;
      findings.push(
        ...exactKeysFindings(record, ['context', 'checkRunId', 'workflowRunId', 'appSlug', 'conclusion'], label),
      );
      if (!isRecord(record)) return;
      contexts.add(record.context);
      addFinding(findings, Object.hasOwn(EXPECTED_AGGREGATES, record.context), `${label}.context is unsupported`);
      addFinding(findings, exactPositiveInteger(record.checkRunId), `${label}.checkRunId is invalid`);
      addFinding(findings, exactPositiveInteger(record.workflowRunId), `${label}.workflowRunId is invalid`);
      addFinding(findings, record.appSlug === GITHUB_ACTIONS_APP.slug, `${label}.appSlug is invalid`);
      addFinding(findings, record.conclusion === 'success', `${label}.conclusion must be success`);
    });
    addFinding(findings, contexts.size === 4, 'aggregate contexts must be unique');
    for (const context of Object.keys(EXPECTED_AGGREGATES)) {
      addFinding(findings, contexts.has(context), `aggregate evidence is missing ${context}`);
    }
  }

  const delivery = implementation.postMergeDelivery;
  findings.push(
    ...exactKeysFindings(
      delivery,
      ['mainDelivery', 'mainCi', 'deployTest', 'promoteProduction'],
      'evidence.implementation.postMergeDelivery',
    ),
  );
  if (isRecord(delivery)) {
    for (const key of ['mainDelivery', 'mainCi']) {
      const record = delivery[key];
      const label = `evidence.implementation.postMergeDelivery.${key}`;
      findings.push(...exactKeysFindings(record, ['workflowRunId', 'sourceSha', 'conclusion'], label));
      if (!isRecord(record)) continue;
      addFinding(findings, exactPositiveInteger(record.workflowRunId), `${label}.workflowRunId is invalid`);
      addFinding(findings, EXACT_SHA.test(record.sourceSha), `${label}.sourceSha must be exact`);
      addFinding(findings, record.conclusion === 'success', `${label}.conclusion must be success`);
    }
    for (const key of ['deployTest', 'promoteProduction']) {
      const record = delivery[key];
      const label = `evidence.implementation.postMergeDelivery.${key}`;
      findings.push(
        ...exactKeysFindings(
          record,
          [
            'workflowRunId',
            'deploymentJobId',
            'sourceSha',
            'deliveryCorrelation',
            'conclusion',
            'publicSmoke',
            'authenticatedSmoke',
            'telemetry',
            'releaseLedgerArtifactId',
            'releaseLedgerArtifactDigest',
            'releaseLedger',
            'runtimeTruth',
          ],
          label,
        ),
      );
      if (!isRecord(record)) continue;
      for (const field of ['workflowRunId', 'deploymentJobId', 'releaseLedgerArtifactId']) {
        addFinding(findings, exactPositiveInteger(record[field]), `${label}.${field} is invalid`);
      }
      addFinding(findings, EXACT_SHA.test(record.sourceSha), `${label}.sourceSha must be exact`);
      addFinding(
        findings,
        OPAQUE_CORRELATION.test(record.deliveryCorrelation),
        `${label}.deliveryCorrelation is invalid`,
      );
      addFinding(findings, record.conclusion === 'success', `${label}.conclusion must be success`);
      for (const field of ['publicSmoke', 'authenticatedSmoke', 'telemetry']) {
        addFinding(findings, record[field] === 'passed', `${label}.${field} must be passed`);
      }
      addFinding(findings, record.releaseLedger === 'validated', `${label}.releaseLedger must be validated`);
      addFinding(
        findings,
        EXACT_DIGEST.test(record.releaseLedgerArtifactDigest),
        `${label}.releaseLedgerArtifactDigest is invalid`,
      );
      findings.push(
        ...exactKeysFindings(
          record.runtimeTruth,
          ['status', 'checkedAt', 'failures', 'blockers'],
          `${label}.runtimeTruth`,
        ),
      );
      if (isRecord(record.runtimeTruth)) {
        addFinding(
          findings,
          record.runtimeTruth.status === 'verified',
          `${label}.runtimeTruth.status must be verified`,
        );
        addFinding(
          findings,
          !Number.isNaN(Date.parse(record.runtimeTruth.checkedAt)),
          `${label}.runtimeTruth.checkedAt is invalid`,
        );
        addFinding(findings, record.runtimeTruth.failures === 0, `${label}.runtimeTruth.failures must be zero`);
        addFinding(findings, record.runtimeTruth.blockers === 0, `${label}.runtimeTruth.blockers must be zero`);
      }
    }
  }

  const serialized = JSON.stringify(evidence);
  for (const pattern of [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{16,}\b/,
    /(?:sig|se|sp)=[^&\s]+/i,
    /(?:authorization|client_secret|connection_string|accountkey)\s*[:=]/i,
  ]) {
    addFinding(findings, !pattern.test(serialized), 'evidence contains a secret-shaped or credential-bearing value');
  }
  return findings;
}

export function workflowRunFindings(run, expected, label = 'workflow run') {
  const findings = [];
  addFinding(findings, run?.id === expected.id, `${label} ID does not match`);
  addFinding(findings, run?.repository?.full_name === expected.repository, `${label} repository does not match`);
  addFinding(findings, run?.path === expected.path, `${label} immutable workflow path does not match`);
  addFinding(findings, run?.event === expected.event, `${label} event does not match`);
  addFinding(findings, run?.run_attempt === 1, `${label} must be the first attempt`);
  addFinding(findings, run?.status === 'completed', `${label} is not completed`);
  addFinding(findings, run?.conclusion === 'success', `${label} did not succeed`);
  addFinding(findings, run?.head_sha === expected.headSha, `${label} head SHA does not match`);
  if (expected.headBranch)
    addFinding(findings, run?.head_branch === expected.headBranch, `${label} branch does not match`);
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

export function completeHistoricalCheckRollupFindings(checkRuns, commitStatuses, headSha) {
  const findings = [];
  const latestChecks = new Map();
  for (const checkRun of Array.isArray(checkRuns) ? checkRuns : []) {
    addFinding(findings, checkRun?.head_sha === headSha, 'historical check rollup contains a wrong-head check');
    if (checkRun?.head_sha !== headSha) continue;
    const identity = `${checkRun?.app?.id ?? checkRun?.app?.slug ?? 'unknown'}:${checkRun?.name ?? 'unknown'}`;
    const previous = latestChecks.get(identity);
    if (!previous || Number(checkRun.id) > Number(previous.id)) latestChecks.set(identity, checkRun);
  }
  addFinding(findings, latestChecks.size > 0, 'historical check rollup is empty');
  for (const checkRun of latestChecks.values()) {
    addFinding(findings, checkRun?.status === 'completed', `${checkRun?.name ?? 'historical check'} is not completed`);
    addFinding(
      findings,
      PASSING_CHECK_CONCLUSIONS.has(checkRun?.conclusion),
      `${checkRun?.name ?? 'historical check'} latest conclusion is not passing`,
    );
  }

  const latestStatuses = new Map();
  for (const status of Array.isArray(commitStatuses) ? commitStatuses : []) {
    addFinding(findings, status?.sha === headSha, 'historical commit status rollup contains a wrong-head status');
    if (status?.sha !== headSha) continue;
    const previous = latestStatuses.get(status.context);
    if (!previous || Number(status.id) > Number(previous.id)) latestStatuses.set(status.context, status);
  }
  for (const status of latestStatuses.values()) {
    addFinding(
      findings,
      status?.state === 'success',
      `${status?.context ?? 'historical commit status'} latest state is not successful`,
    );
  }
  return findings;
}

function normalizedHistoryRecords(records, kind) {
  if (!Array.isArray(records)) return undefined;
  const project =
    kind === 'check'
      ? (record) => ({
          id: record?.id,
          name: record?.name,
          headSha: record?.head_sha,
          status: record?.status,
          conclusion: record?.conclusion,
          appId: record?.app?.id,
          appSlug: record?.app?.slug,
          detailsUrl: record?.details_url,
          externalId: record?.external_id,
        })
      : kind === 'status'
        ? (record) => ({
            id: record?.id,
            sha: record?.sha,
            context: record?.context,
            state: record?.state,
            targetUrl: record?.target_url,
            creatorId: record?.creator?.id,
            creatorLogin: record?.creator?.login,
          })
        : (record) => ({
            id: record?.id,
            repository: record?.repository?.full_name,
            path: record?.path,
            event: record?.event,
            runAttempt: record?.run_attempt,
            status: record?.status,
            conclusion: record?.conclusion,
            headSha: record?.head_sha,
            headBranch: record?.head_branch,
            headRepository: record?.head_repository?.full_name,
            displayTitle: record?.display_title,
            htmlUrl: record?.html_url,
            createdAt: record?.created_at,
            updatedAt: record?.updated_at,
            runStartedAt: record?.run_started_at,
          });
  return records
    .map(project)
    .sort(
      (left, right) => Number(left.id) - Number(right.id) || JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

export function historyStabilityFindings(initial, final) {
  const findings = [];
  for (const [key, kind, label] of [
    ['checkRuns', 'check', 'historical check-run history'],
    ['commitStatuses', 'status', 'historical commit-status history'],
    ['implementationWorkflowRuns', 'workflow', 'implementation workflow history'],
    ['mergeWorkflowRuns', 'workflow', 'merge workflow history'],
    ['currentWorkflowRuns', 'workflow', 'current-main workflow history'],
  ]) {
    const before = normalizedHistoryRecords(initial?.[key], kind);
    const after = normalizedHistoryRecords(final?.[key], kind);
    addFinding(findings, Boolean(before), `${label} initial snapshot is invalid`);
    addFinding(findings, Boolean(after), `${label} final snapshot is invalid`);
    if (before && after) {
      addFinding(findings, JSON.stringify(before) === JSON.stringify(after), `${label} changed during verification`);
    }
  }
  return findings;
}

function canonicalAggregateCheckFindings(record, allCheckRuns, implementation) {
  const findings = [];
  const named = (Array.isArray(allCheckRuns) ? allCheckRuns : []).filter(
    (checkRun) => checkRun?.head_sha === implementation.headSha && checkRun?.name === record?.context,
  );
  addFinding(
    findings,
    named.every((checkRun) => checkRun?.app?.id === GITHUB_ACTIONS_APP.id && checkRun?.app?.slug === record?.appSlug),
    `${record?.context} rollup contains a wrong-App check`,
  );
  const expectedAppRuns = named.filter(
    (checkRun) => checkRun?.app?.id === GITHUB_ACTIONS_APP.id && checkRun?.app?.slug === record?.appSlug,
  );
  const latest = latestByNumericId(expectedAppRuns);
  addFinding(findings, Boolean(latest), `${record?.context} canonical latest check is missing`);
  addFinding(findings, latest?.id === record?.checkRunId, `${record?.context} declared check is not canonical latest`);
  return findings;
}

function workflowRunMatchesIdentity(run, expected) {
  return (
    run?.repository?.full_name === expected.repository &&
    run?.path === expected.path &&
    run?.event === expected.event &&
    run?.head_sha === expected.headSha &&
    (!expected.headBranch || run?.head_branch === expected.headBranch) &&
    (!expected.headRepository || run?.head_repository?.full_name === expected.headRepository)
  );
}

export function canonicalWorkflowRunFindings(recordedRun, workflowRuns, expected, label = 'workflow run') {
  const findings = [...workflowRunFindings(recordedRun, expected, label)];
  const applicable = (Array.isArray(workflowRuns) ? workflowRuns : []).filter((run) =>
    workflowRunMatchesIdentity(run, expected),
  );
  const latest = latestByNumericId(applicable);
  addFinding(findings, Boolean(latest), `${label} canonical history is missing`);
  addFinding(findings, latest?.id === expected.id, `${label} is not the canonical latest applicable run`);
  if (latest) findings.push(...workflowRunFindings(latest, expected, `${label} canonical latest record`));
  return findings;
}

export function aggregateCheckFindings(record, checkRun, workflowRun, implementation) {
  const findings = [];
  const expectedWorkflow = EXPECTED_AGGREGATES[record?.context];
  addFinding(findings, Boolean(expectedWorkflow), `unsupported aggregate ${record?.context ?? '<missing>'}`);
  addFinding(findings, checkRun?.id === record?.checkRunId, `${record?.context} check ID does not match`);
  addFinding(findings, checkRun?.name === record?.context, `${record?.context} check name does not match`);
  addFinding(findings, checkRun?.head_sha === implementation.headSha, `${record?.context} head SHA does not match`);
  addFinding(findings, checkRun?.status === 'completed', `${record?.context} is not completed`);
  addFinding(findings, checkRun?.conclusion === 'success', `${record?.context} did not succeed`);
  addFinding(findings, checkRun?.app?.slug === record?.appSlug, `${record?.context} app slug does not match`);
  addFinding(findings, checkRun?.app?.id === GITHUB_ACTIONS_APP.id, `${record?.context} app ID does not match`);
  if (record?.context === 'Autonomous review complete') {
    const expectedExternalId = `juez-autonomous-review-decision:v1:JueZ/api:pull:${implementation.number}:head:${implementation.headSha}:run:${record.workflowRunId}`;
    addFinding(
      findings,
      checkRun?.external_id === expectedExternalId,
      'Autonomous review complete does not bind the exact PR, head, and run',
    );
  } else {
    addFinding(
      findings,
      checkRun?.details_url ===
        `https://github.com/JueZ/api/actions/runs/${record?.workflowRunId}/job/${record?.checkRunId}`,
      `${record?.context} details URL does not bind the exact run and job`,
    );
  }
  if (expectedWorkflow) {
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
  addFinding(findings, pullRequest?.head?.sha === implementation.headSha, 'implementation PR head does not match');
  addFinding(
    findings,
    pullRequest?.base?.sha === evidence?.implementation?.baselineMainSha,
    'implementation PR base does not match',
  );
  addFinding(
    findings,
    pullRequest?.merge_commit_sha === implementation.mergeSha,
    'implementation merge SHA does not match',
  );
  return findings;
}

function trustedWorkflowFileFindings(files, environment, expectedSha, scope) {
  const findings = [];
  for (const [key, expected] of [
    ['entry', EXPECTED_DEPLOYMENT_WORKFLOW_FILES[environment]],
    ['shared', EXPECTED_DEPLOYMENT_WORKFLOW_FILES.shared],
  ]) {
    const observed = files?.[key];
    addFinding(findings, observed?.path === expected.path, `${environment} ${scope} ${key} workflow path is invalid`);
    addFinding(findings, observed?.ref === expectedSha, `${environment} ${scope} ${key} workflow ref is not exact`);
    addFinding(
      findings,
      observed?.sha256 === expected.sha256,
      `${environment} ${scope} ${key} workflow content is not the reviewed generation`,
    );
  }
  return findings;
}

function deploymentJobFindings(record, job, environment, expectedSha) {
  const findings = [];
  const expectedName = EXPECTED_DEPLOYMENT_JOBS[environment];
  const expectedWorkflowName =
    environment === 'test'
      ? `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`
      : `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`;
  addFinding(findings, job?.id === record.deploymentJobId, `${environment} job ID does not match`);
  addFinding(findings, job?.run_id === record.workflowRunId, `${environment} job run does not match`);
  addFinding(findings, job?.workflow_name === expectedWorkflowName, `${environment} workflow name does not match`);
  addFinding(findings, job?.name === expectedName, `${environment} job name does not match`);
  addFinding(findings, job?.head_sha === expectedSha, `${environment} job head does not match`);
  addFinding(findings, job?.head_branch === 'main', `${environment} job branch is not main`);
  addFinding(
    findings,
    job?.status === 'completed' && job?.conclusion === 'success',
    `${environment} job did not succeed`,
  );
  addFinding(findings, job?.run_attempt === 1, `${environment} job must be the first attempt`);
  addFinding(findings, job?.runner_group_name === 'GitHub Actions', `${environment} job runner is not GitHub Actions`);
  addFinding(
    findings,
    job?.html_url === `https://github.com/JueZ/api/actions/runs/${record.workflowRunId}/job/${record.deploymentJobId}`,
    `${environment} job URL does not match`,
  );
  for (const stepName of ['Write release ledger', 'Upload release ledger']) {
    const matches = (Array.isArray(job?.steps) ? job.steps : []).filter((step) => step.name === stepName);
    addFinding(
      findings,
      matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success',
      `${environment} job did not successfully complete ${stepName}`,
    );
  }
  return findings;
}

function releaseLedgerTimelineFindings(artifact, ledger, job, environment, scope) {
  const findings = [];
  const writeSteps = (Array.isArray(job?.steps) ? job.steps : []).filter(
    (step) => step.name === 'Write release ledger',
  );
  const uploadSteps = (Array.isArray(job?.steps) ? job.steps : []).filter(
    (step) => step.name === 'Upload release ledger',
  );
  const write = writeSteps[0];
  const upload = uploadSteps[0];
  const timestamps = {
    jobStarted: Date.parse(job?.started_at),
    jobCompleted: Date.parse(job?.completed_at),
    writeStarted: Date.parse(write?.started_at),
    writeCompleted: Date.parse(write?.completed_at),
    uploadStarted: Date.parse(upload?.started_at),
    uploadCompleted: Date.parse(upload?.completed_at),
    ledgerVerified: Date.parse(ledger?.verifiedAt),
    artifactCreated: Date.parse(artifact?.created_at),
    artifactUpdated: Date.parse(artifact?.updated_at),
  };
  addFinding(
    findings,
    Object.values(timestamps).every(Number.isFinite),
    `${environment} ${scope} release-ledger lifecycle timestamps are invalid`,
  );
  addFinding(
    findings,
    timestamps.jobStarted <= timestamps.writeStarted &&
      timestamps.writeStarted <= timestamps.ledgerVerified &&
      timestamps.ledgerVerified <= timestamps.writeCompleted + 5_000 &&
      timestamps.writeCompleted <= timestamps.uploadCompleted &&
      timestamps.uploadStarted <= timestamps.artifactCreated &&
      timestamps.artifactCreated <= timestamps.uploadCompleted + 5_000 &&
      timestamps.artifactUpdated >= timestamps.artifactCreated &&
      timestamps.artifactUpdated <= timestamps.jobCompleted + 5_000,
    `${environment} ${scope} release ledger is not bounded to the authenticated job lifecycle`,
  );
  return findings;
}

function deploymentLedgerFindings(record, ledger, observed, environment, expectedSha, scope) {
  const findings = [];
  const artifactName = `release-ledger-${environment}-${record.sourceSha}-${record.deliveryCorrelation}`;
  const artifacts = Array.isArray(observed.artifactList?.artifacts) ? observed.artifactList.artifacts : [];
  const named = artifacts.filter((artifact) => artifact.name === artifactName);
  const artifact = named.find((candidate) => candidate.id === record.releaseLedgerArtifactId);
  addFinding(findings, named.length === 1, `${environment} ledger artifact name is not unique`);
  addFinding(findings, Boolean(artifact), `${environment} ledger artifact ID is unavailable`);
  addFinding(findings, artifact?.expired === false, `${environment} ledger artifact is expired`);
  addFinding(
    findings,
    artifact?.digest === record.releaseLedgerArtifactDigest,
    `${environment} ledger artifact digest does not match`,
  );
  addFinding(
    findings,
    artifact?.workflow_run?.id === record.workflowRunId,
    `${environment} ledger artifact run does not match`,
  );
  addFinding(
    findings,
    artifact?.workflow_run?.head_sha === expectedSha,
    `${environment} ledger artifact head does not match`,
  );
  addFinding(
    findings,
    artifact?.workflow_run?.head_branch === 'main',
    `${environment} ledger artifact branch is not main`,
  );
  for (const error of validateReleaseLedger(ledger, { expectedDeliveryCorrelation: record.deliveryCorrelation })) {
    findings.push(`${environment} release ledger: ${error}`);
  }
  addFinding(findings, ledger?.environment === environment, `${environment} ledger environment does not match`);
  addFinding(
    findings,
    ledger?.workflowRunId === String(record.workflowRunId),
    `${environment} ledger run does not match`,
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
    allowedRuntimeOrigin(environment, ledger?.apiBaseUrl) === `https://${ACCEPTANCE_RUNTIME_HOSTS[environment]}`,
    `${environment} ledger runtime origin is not allowlisted`,
  );
  findings.push(...trustedWorkflowFileFindings(observed.workflowFiles, environment, expectedSha, scope));
  findings.push(...deploymentJobFindings(record, observed.deploymentJob, environment, expectedSha));
  findings.push(...releaseLedgerTimelineFindings(artifact, ledger, observed.deploymentJob, environment, scope));
  return findings;
}

export function currentRuntimeFindings(currentRuntime) {
  const findings = [];
  const beforeSha = currentRuntime?.mainBefore?.object?.sha;
  const afterSha = currentRuntime?.mainAfter?.object?.sha;
  addFinding(findings, currentRuntime?.mainBefore?.object?.type === 'commit', 'current main ref is not a commit');
  addFinding(findings, currentRuntime?.mainAfter?.object?.type === 'commit', 'final main ref is not a commit');
  addFinding(findings, EXACT_SHA.test(beforeSha || ''), 'current main SHA is invalid');
  addFinding(findings, afterSha === beforeSha, 'current main changed during trusted runtime verification');
  for (const environment of ['test', 'prod']) {
    const observed = currentRuntime?.environments?.[environment];
    const run = observed?.workflowRun;
    const correlation = observed?.deliveryCorrelation;
    const expectedWorkflow =
      environment === 'test' ? EXPECTED_DELIVERY_RUNS.deployTest : EXPECTED_DELIVERY_RUNS.promoteProduction;
    const expectedTitle = `${environment === 'test' ? 'Deploy Test' : 'Promote Production'} ${beforeSha} ${correlation}`;
    const expected = {
      id: run?.id,
      repository: 'JueZ/api',
      path: expectedWorkflow.path,
      event: expectedWorkflow.event,
      headSha: beforeSha,
      headBranch: 'main',
      headRepository: 'JueZ/api',
      displayTitle: expectedTitle,
    };
    addFinding(findings, OPAQUE_CORRELATION.test(correlation || ''), `${environment} current correlation is invalid`);
    findings.push(
      ...canonicalWorkflowRunFindings(
        run,
        observed?.workflowRuns,
        expected,
        `${environment} current deployment workflow`,
      ),
    );
    addFinding(
      findings,
      Array.isArray(observed?.deploymentJobs) && observed.deploymentJobs.length === 1,
      `${environment} current deployment job is not unique`,
    );
    const artifact = observed?.artifact;
    addFinding(
      findings,
      Array.isArray(observed?.ledgerArtifacts) && observed.ledgerArtifacts.length === 1,
      `${environment} current release-ledger artifact is not unique`,
    );
    const record = {
      workflowRunId: run?.id,
      deploymentJobId: observed?.deploymentJob?.id,
      sourceSha: beforeSha,
      deliveryCorrelation: correlation,
      releaseLedgerArtifactId: artifact?.id,
      releaseLedgerArtifactDigest: artifact?.digest,
    };
    findings.push(...deploymentLedgerFindings(record, observed?.ledger, observed, environment, beforeSha, 'current'));
    addFinding(findings, observed?.liveHealth?.status === 'ok', `${environment} current live health is not ok`);
    addFinding(
      findings,
      observed?.liveHealth?.environmentName === environment,
      `${environment} current live health environment does not match`,
    );
    addFinding(
      findings,
      observed?.liveHealth?.deployedCommitSha === beforeSha,
      `${environment} current live health commit is not exact main`,
    );
    addFinding(
      findings,
      observed?.liveHealth?.deployedSourceRef === beforeSha,
      `${environment} current live health source ref is not exact main`,
    );
    addFinding(
      findings,
      observed?.liveHealth?.deploymentRunId === String(run?.id),
      `${environment} current live health deployment run does not match`,
    );
  }
  addFinding(
    findings,
    allowedRuntimeOrigin('test', currentRuntime?.environments?.test?.ledger?.apiBaseUrl) !==
      allowedRuntimeOrigin('prod', currentRuntime?.environments?.prod?.ledger?.apiBaseUrl),
    'current test and production runtime origins must be distinct',
  );
  return findings;
}

export function phase2EvidenceFindings(evidence, observed) {
  const findings = [...phase2EvidenceShapeFindings(evidence)];
  if (findings.length > 0) return findings;
  findings.push(...historyStabilityFindings(observed?.historyStability?.initial, observed?.historyStability?.final));
  const implementation = evidence.implementation.pullRequest;
  findings.push(...pullRequestFindings(evidence, observed.pullRequest));
  findings.push(
    ...completeHistoricalCheckRollupFindings(
      observed.checkRollup?.checkRuns,
      observed.checkRollup?.commitStatuses,
      implementation.headSha,
    ),
  );
  for (const record of evidence.implementation.exactHeadAggregates) {
    findings.push(...canonicalAggregateCheckFindings(record, observed.checkRollup?.checkRuns, implementation));
    const expectedWorkflow = EXPECTED_AGGREGATES[record.context];
    const expected = {
      id: record.workflowRunId,
      repository: 'JueZ/api',
      path: expectedWorkflow.path,
      event: expectedWorkflow.event,
      headSha: implementation.headSha,
      headBranch: implementation.branch,
      headRepository: 'JueZ/api',
    };
    findings.push(
      ...aggregateCheckFindings(
        record,
        observed.checkRuns[String(record.checkRunId)],
        observed.workflowRuns[String(record.workflowRunId)],
        implementation,
      ),
      ...canonicalWorkflowRunFindings(
        observed.workflowRuns[String(record.workflowRunId)],
        observed.workflowHistories?.implementationHead,
        expected,
        `${record.context} workflow run`,
      ),
    );
  }
  const autonomousReviewRecord = evidence.implementation.exactHeadAggregates.find(
    (record) => record.context === 'Autonomous review complete',
  );
  for (const [key, expectedWorkflow] of Object.entries(EXPECTED_DELIVERY_RUNS)) {
    const record = evidence.implementation.postMergeDelivery[key];
    addFinding(findings, record.sourceSha === implementation.mergeSha, `${key} source SHA does not match the merge`);
    const expected = {
      id: record.workflowRunId,
      repository: 'JueZ/api',
      path: expectedWorkflow.path,
      event: expectedWorkflow.event,
      headSha: implementation.mergeSha,
      headBranch: 'main',
      headRepository: 'JueZ/api',
    };
    if (key === 'mainDelivery') {
      expected.displayTitle = `Deliver trigger ${autonomousReviewRecord.workflowRunId} attempt 1`;
    }
    if (key === 'deployTest') {
      expected.displayTitle = `Deploy Test ${record.sourceSha} ${record.deliveryCorrelation}`;
    }
    if (key === 'promoteProduction') {
      expected.displayTitle = `Promote Production ${record.sourceSha} ${record.deliveryCorrelation}`;
    }
    findings.push(
      ...canonicalWorkflowRunFindings(
        observed.workflowRuns[String(record.workflowRunId)],
        observed.workflowHistories?.merge,
        expected,
        `${key} workflow run`,
      ),
    );
  }
  findings.push(
    ...deploymentLedgerFindings(
      evidence.implementation.postMergeDelivery.deployTest,
      observed.environments.test.ledger,
      observed.environments.test,
      'test',
      implementation.mergeSha,
      'historical',
    ),
    ...deploymentLedgerFindings(
      evidence.implementation.postMergeDelivery.promoteProduction,
      observed.environments.prod.ledger,
      observed.environments.prod,
      'prod',
      implementation.mergeSha,
      'historical',
    ),
  );
  addFinding(
    findings,
    allowedRuntimeOrigin('test', observed.environments.test.ledger.apiBaseUrl) !==
      allowedRuntimeOrigin('prod', observed.environments.prod.ledger.apiBaseUrl),
    'test and production runtime origins must be distinct',
  );
  findings.push(...currentRuntimeFindings(observed.currentRuntime));
  return findings;
}

export function reviewEvidenceFindings(review, options, claimMarker) {
  const findings = [];
  addFinding(findings, isRecord(review), 'trusted review evidence must be an object');
  addFinding(findings, review?.decision === 'approve', 'trusted review did not approve');
  addFinding(findings, review?.reviewedHeadSha === options.headSha, 'trusted review head does not match');
  addFinding(findings, review?.risk?.highRisk === true, 'program evidence must receive high-risk review');
  addFinding(findings, review?.modelInvoked === true, 'program evidence must receive independent model review');
  addFinding(findings, review?.reviewClaim?.status === 'new', 'trusted review claim was not newly consumed');
  addFinding(
    findings,
    review?.reviewClaim?.runId === options.controllerRunId,
    'trusted review claim run does not match',
  );
  addFinding(
    findings,
    exactPositiveInteger(review?.reviewClaim?.checkRunId),
    'trusted review claim check ID is invalid',
  );
  const expectedClaimName = `Autonomous review paid-call claim ${REVIEW_CLAIM_VERSION} PR #${options.prNumber}`;
  const expectedExternalId = `juez-autonomous-review:${REVIEW_CLAIM_VERSION}:${options.repository}:pull:${options.prNumber}:head:${options.headSha}:workflow:codex-automerge.yml:run:${options.controllerRunId}`;
  addFinding(
    findings,
    claimMarker?.id === review?.reviewClaim?.checkRunId,
    'trusted review claim marker ID does not match',
  );
  addFinding(findings, claimMarker?.name === expectedClaimName, 'trusted review claim marker name does not match');
  addFinding(findings, claimMarker?.head_sha === options.headSha, 'trusted review claim marker head does not match');
  addFinding(
    findings,
    claimMarker?.external_id === expectedExternalId,
    'trusted review claim marker identity does not match',
  );
  const expectedRunUrl = `https://github.com/${options.repository}/actions/runs/${options.controllerRunId}`;
  const expectedCheckUrl = `https://github.com/${options.repository}/runs/${review?.reviewClaim?.checkRunId}`;
  addFinding(
    findings,
    [expectedRunUrl, expectedCheckUrl].includes(claimMarker?.details_url),
    'trusted review claim details URL does not match',
  );
  addFinding(findings, claimMarker?.app?.slug === GITHUB_ACTIONS_APP.slug, 'trusted review claim app does not match');
  addFinding(findings, claimMarker?.app?.id === GITHUB_ACTIONS_APP.id, 'trusted review claim app ID does not match');
  addFinding(findings, claimMarker?.status === 'completed', 'trusted review claim is not completed');
  addFinding(findings, claimMarker?.conclusion === 'neutral', 'trusted review claim conclusion is not neutral');
  return findings;
}

export function lowRiskReviewEvidenceFindings(review, options) {
  const findings = [];
  addFinding(findings, isRecord(review), 'trusted review evidence must be an object');
  addFinding(findings, review?.decision === 'approve', 'trusted review did not approve');
  addFinding(findings, review?.reviewedHeadSha === options.headSha, 'trusted review head does not match');
  addFinding(findings, review?.risk?.highRisk === false, 'low-risk review classification does not match');
  addFinding(findings, review?.modelInvoked === false, 'low-risk review must not invoke the model');
  addFinding(findings, review?.reviewClaim === undefined, 'low-risk review must not carry a paid-review claim');
  return findings;
}

export function trustedControllerFindings(options, runtime = {}) {
  const env = runtime.env ?? process.env;
  const findings = [];
  addFinding(findings, env.GITHUB_ACTIONS === 'true', 'trusted verification must run in GitHub Actions');
  addFinding(
    findings,
    env.GITHUB_WORKFLOW === CONTROLLER_WORKFLOW,
    'trusted verification workflow name does not match',
  );
  addFinding(findings, env.GITHUB_REPOSITORY === options.repository, 'trusted verification repository does not match');
  addFinding(
    findings,
    Number(env.GITHUB_RUN_ID) === options.controllerRunId,
    'trusted verification run ID does not match',
  );
  addFinding(findings, EXACT_SHA.test(options.controllerSha), 'trusted controller SHA must be exact');
  addFinding(findings, EXACT_SHA.test(env.GITHUB_WORKFLOW_SHA || ''), 'runtime workflow SHA must be exact');
  addFinding(
    findings,
    env.GITHUB_WORKFLOW_SHA === options.controllerSha,
    'trusted controller option does not match the runtime workflow SHA',
  );
  addFinding(
    findings,
    runtime.checkoutSha === options.controllerSha,
    'trusted controller checkout does not match workflow SHA',
  );
  addFinding(
    findings,
    runtime.checkoutSha === env.GITHUB_WORKFLOW_SHA,
    'trusted controller checkout does not match the runtime workflow SHA',
  );
  return findings;
}

export async function collectPhase2Observed(evidence, client, dependencies = {}) {
  const fetchHealth = dependencies.fetchHealth || fetchAllowedRuntimeHealth;
  const readArchive =
    dependencies.readArchive ||
    ((archive, environment) =>
      readSingleJsonArchive(archive, `release-ledger-${environment}.json`, { label: `${environment} ledger` }));
  const implementation = evidence.implementation.pullRequest;
  const aggregates = evidence.implementation.exactHeadAggregates;
  const deliveryRecords = Object.values(evidence.implementation.postMergeDelivery);
  const workflowRunIds = [...new Set([...aggregates, ...deliveryRecords].map((record) => record.workflowRunId))];
  const [pullRequest, checkRuns, commitStatuses, implementationWorkflowRuns, mergeWorkflowRuns, mainBefore] =
    await Promise.all([
      client.getPullRequest(implementation.number),
      client.getCheckRuns(implementation.headSha),
      client.getCommitStatuses(implementation.headSha),
      client.getWorkflowRuns(implementation.headSha),
      client.getWorkflowRuns(implementation.mergeSha),
      client.getProtectedMainRef(),
    ]);
  const observed = {
    pullRequest,
    checkRuns: {},
    workflowRuns: {},
    checkRollup: { checkRuns, commitStatuses },
    workflowHistories: { implementationHead: implementationWorkflowRuns, merge: mergeWorkflowRuns },
    environments: {},
    currentRuntime: { mainBefore, environments: {} },
    historyStability: {
      initial: {
        checkRuns,
        commitStatuses,
        implementationWorkflowRuns,
        mergeWorkflowRuns,
      },
    },
  };
  await Promise.all(
    aggregates.map(async (record) => {
      observed.checkRuns[String(record.checkRunId)] = await client.getCheckRun(record.checkRunId);
    }),
  );
  await Promise.all(
    workflowRunIds.map(async (runId) => {
      observed.workflowRuns[String(runId)] = await client.getWorkflowRun(runId);
    }),
  );
  for (const [environment, record] of [
    ['test', evidence.implementation.postMergeDelivery.deployTest],
    ['prod', evidence.implementation.postMergeDelivery.promoteProduction],
  ]) {
    const artifacts = await client.getWorkflowArtifacts(record.workflowRunId);
    const artifactList = { artifacts };
    const artifact = artifacts.find((candidate) => candidate.id === record.releaseLedgerArtifactId);
    if (!artifact) throw new Error(`${environment} ledger artifact is unavailable`);
    const archive = await client.downloadArtifact(record.releaseLedgerArtifactId);
    verifyArtifactArchiveDigest(archive, artifact.digest, record.releaseLedgerArtifactDigest, `${environment} ledger`);
    const ledger = await readArchive(archive, environment);
    observed.environments[environment] = {
      artifactList,
      ledger,
      deploymentJob: await client.getWorkflowJob(record.deploymentJobId),
      workflowFiles: {
        entry: await client.getFileDigest(
          EXPECTED_DEPLOYMENT_WORKFLOW_FILES[environment].path,
          implementation.mergeSha,
          DEPLOYMENT_WORKFLOW_PATHS,
        ),
        shared: await client.getFileDigest(
          EXPECTED_DEPLOYMENT_WORKFLOW_FILES.shared.path,
          implementation.mergeSha,
          DEPLOYMENT_WORKFLOW_PATHS,
        ),
      },
    };
  }
  const currentMainSha = mainBefore?.object?.sha;
  if (!EXACT_SHA.test(currentMainSha || '')) throw new Error('current main ref did not resolve to an exact SHA');
  const currentWorkflowRuns = await client.getWorkflowRuns(currentMainSha);
  for (const environment of ['test', 'prod']) {
    const expectedWorkflow =
      environment === 'test' ? EXPECTED_DELIVERY_RUNS.deployTest : EXPECTED_DELIVERY_RUNS.promoteProduction;
    const applicableRuns = currentWorkflowRuns.filter((run) =>
      workflowRunMatchesIdentity(run, {
        repository: 'JueZ/api',
        path: expectedWorkflow.path,
        event: expectedWorkflow.event,
        headSha: currentMainSha,
        headBranch: 'main',
        headRepository: 'JueZ/api',
      }),
    );
    const historyRun = latestByNumericId(applicableRuns);
    if (!historyRun) throw new Error(`${environment} current deployment workflow is unavailable`);
    const workflowRun = await client.getWorkflowRun(historyRun.id);
    const titlePrefix = `${environment === 'test' ? 'Deploy Test' : 'Promote Production'} ${currentMainSha} `;
    const deliveryCorrelation = workflowRun?.display_title?.startsWith(titlePrefix)
      ? workflowRun.display_title.slice(titlePrefix.length)
      : '';
    if (!OPAQUE_CORRELATION.test(deliveryCorrelation)) {
      throw new Error(`${environment} current delivery correlation is invalid`);
    }
    const jobs = await client.getWorkflowJobs(workflowRun.id);
    const deploymentJobs = jobs.filter((job) => job?.name === EXPECTED_DEPLOYMENT_JOBS[environment]);
    if (deploymentJobs.length !== 1) throw new Error(`${environment} current deployment job is not unique`);
    const deploymentJob = deploymentJobs[0];
    const artifacts = await client.getWorkflowArtifacts(workflowRun.id);
    const artifactName = `release-ledger-${environment}-${currentMainSha}-${deliveryCorrelation}`;
    const ledgerArtifacts = artifacts.filter((artifact) => artifact?.name === artifactName);
    if (ledgerArtifacts.length !== 1) throw new Error(`${environment} current release-ledger artifact is not unique`);
    const artifact = ledgerArtifacts[0];
    const archive = await client.downloadArtifact(artifact.id);
    verifyArtifactArchiveDigest(archive, artifact.digest, artifact.digest, `${environment} current ledger`);
    observed.currentRuntime.environments[environment] = {
      workflowRuns: currentWorkflowRuns,
      workflowRun,
      deliveryCorrelation,
      deploymentJobs,
      deploymentJob,
      artifactList: { artifacts },
      ledgerArtifacts,
      artifact,
      ledger: await readArchive(archive, environment),
      workflowFiles: {
        entry: await client.getFileDigest(
          EXPECTED_DEPLOYMENT_WORKFLOW_FILES[environment].path,
          currentMainSha,
          DEPLOYMENT_WORKFLOW_PATHS,
        ),
        shared: await client.getFileDigest(
          EXPECTED_DEPLOYMENT_WORKFLOW_FILES.shared.path,
          currentMainSha,
          DEPLOYMENT_WORKFLOW_PATHS,
        ),
      },
      liveHealth: await fetchHealth(environment, `https://${ACCEPTANCE_RUNTIME_HOSTS[environment]}`),
    };
  }
  const [
    finalCheckRuns,
    finalCommitStatuses,
    finalImplementationWorkflowRuns,
    finalMergeWorkflowRuns,
    finalCurrentWorkflowRuns,
    mainAfter,
  ] = await Promise.all([
    client.getCheckRuns(implementation.headSha),
    client.getCommitStatuses(implementation.headSha),
    client.getWorkflowRuns(implementation.headSha),
    client.getWorkflowRuns(implementation.mergeSha),
    client.getWorkflowRuns(currentMainSha),
    client.getProtectedMainRef(),
  ]);
  observed.historyStability.initial.currentWorkflowRuns = currentWorkflowRuns;
  observed.historyStability.final = {
    checkRuns: finalCheckRuns,
    commitStatuses: finalCommitStatuses,
    implementationWorkflowRuns: finalImplementationWorkflowRuns,
    mergeWorkflowRuns: finalMergeWorkflowRuns,
    currentWorkflowRuns: finalCurrentWorkflowRuns,
  };
  observed.checkRollup = { checkRuns: finalCheckRuns, commitStatuses: finalCommitStatuses };
  observed.workflowHistories = {
    implementationHead: finalImplementationWorkflowRuns,
    merge: finalMergeWorkflowRuns,
  };
  for (const environment of ['test', 'prod']) {
    observed.currentRuntime.environments[environment].workflowRuns = finalCurrentWorkflowRuns;
  }
  observed.currentRuntime.mainAfter = mainAfter;
  return observed;
}

async function readBoundedReviewFile(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_REVIEW_FILE_BYTES) {
    throw new Error('trusted review evidence file is invalid');
  }
  return parseStrictJson(await readFile(path, 'utf8'), 'trusted review evidence');
}

function pullRequestIdentityFindings(pullRequest, options) {
  const findings = [];
  addFinding(findings, pullRequest?.number === options.prNumber, 'candidate PR number does not match');
  addFinding(findings, pullRequest?.state === 'open', 'candidate PR is not open');
  addFinding(findings, pullRequest?.head?.sha === options.headSha, 'candidate PR head does not match');
  addFinding(findings, pullRequest?.base?.ref === 'main', 'candidate PR base is not main');
  addFinding(findings, pullRequest?.head?.repo?.full_name === options.repository, 'candidate PR is a fork');
  addFinding(
    findings,
    pullRequest?.base?.repo?.full_name === options.repository,
    'candidate PR repository does not match',
  );
  addFinding(findings, EXACT_SHA.test(pullRequest?.base?.sha || ''), 'candidate PR base SHA is invalid');
  return findings;
}

function finalCandidateSnapshotFindings(initialPullRequest, finalPullRequest, options) {
  const findings = pullRequestIdentityFindings(finalPullRequest, options);
  addFinding(findings, finalPullRequest?.head?.ref === initialPullRequest?.head?.ref, 'candidate PR head ref changed');
  addFinding(findings, finalPullRequest?.base?.sha === initialPullRequest?.base?.sha, 'candidate PR base SHA changed');
  addFinding(
    findings,
    finalPullRequest?.changed_files === initialPullRequest?.changed_files,
    'candidate PR changed-file count changed',
  );
  addFinding(findings, finalPullRequest?.commits === initialPullRequest?.commits, 'candidate PR commit count changed');
  return findings;
}

async function requireStableFinalCandidate(client, initialPullRequest, options) {
  const finalPullRequest = await client.getPullRequest(options.prNumber);
  const findings = finalCandidateSnapshotFindings(initialPullRequest, finalPullRequest, options);
  if (findings.length > 0) throw new Error(`final candidate identity failed: ${findings.join('; ')}`);
}

export function controllerRunFindings(run, options) {
  const findings = [];
  addFinding(findings, run?.id === options.controllerRunId, 'controller run ID does not match');
  addFinding(findings, run?.repository?.full_name === options.repository, 'controller run repository does not match');
  addFinding(findings, run?.path === CONTROLLER_WORKFLOW_PATH, 'controller run path does not match');
  addFinding(
    findings,
    ['pull_request_target', 'repository_dispatch'].includes(run?.event),
    'controller run event is invalid',
  );
  addFinding(findings, run?.run_attempt === 1, 'controller run must be the first attempt');
  addFinding(findings, ['in_progress', 'completed'].includes(run?.status), 'controller run status is invalid');
  // GitHub exposes two different identities for pull_request_target: trusted
  // workflow code comes from github.workflow_sha, while the REST workflow-run
  // record is associated with the candidate pull request head. Bind both
  // independently instead of treating the REST head_sha as executable code.
  const expectedRunHead = run?.event === 'repository_dispatch' ? options.controllerSha : options.headSha;
  addFinding(
    findings,
    run?.head_sha === expectedRunHead,
    'controller run head does not match the trusted event identity',
  );
  return findings;
}

function sanitizedSuccess(options, evidence, status) {
  return {
    schemaVersion: 1,
    status,
    repository: options.repository,
    pullRequest: options.prNumber,
    verifiedHeadSha: options.headSha,
    trustedControllerSha: options.controllerSha,
    trustedControllerRunId: options.controllerRunId,
    reviewedDecision: 'approve',
    phase: status === 'verified' ? 2 : undefined,
    implementationPullRequest: evidence?.implementation?.pullRequest?.number,
    implementationMergeSha: evidence?.implementation?.pullRequest?.mergeSha,
    workflowRunIds:
      status === 'verified'
        ? Object.fromEntries(
            Object.entries(evidence.implementation.postMergeDelivery).map(([key, record]) => [
              key,
              record.workflowRunId,
            ]),
          )
        : undefined,
  };
}

export async function verifyTrustedPullRequest(options, dependencies = {}) {
  const runtime = dependencies.runtime || {};
  const checkoutSha =
    runtime.checkoutSha ||
    spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim().toLowerCase();
  const runtimeFindings = trustedControllerFindings(options, { ...runtime, checkoutSha });
  if (runtimeFindings.length > 0) throw new Error(`trusted controller identity failed: ${runtimeFindings.join('; ')}`);
  const client =
    dependencies.client ||
    createTrustedGithubClient({ repository: options.repository, token: (runtime.env ?? process.env).GH_TOKEN });
  const protectedMainBefore = await client.getProtectedMainRef();
  const protectedMainSha = protectedMainBefore?.object?.sha;
  if (!EXACT_SHA.test(protectedMainSha || '')) {
    throw new Error('trusted controller protected-main authentication failed: protected main SHA is invalid');
  }
  const controllerComparison = await client.compareControllerToMain(options.controllerSha, protectedMainSha);
  const protectedMainAfter = await client.getProtectedMainRef();
  const protectedMainFindings = protectedMainControllerFindings(
    protectedMainBefore,
    protectedMainAfter,
    controllerComparison,
    options,
  );
  if (protectedMainFindings.length > 0) {
    throw new Error(`trusted controller protected-main authentication failed: ${protectedMainFindings.join('; ')}`);
  }
  const [pullRequest, controllerRun, review] = await Promise.all([
    client.getPullRequest(options.prNumber),
    client.getWorkflowRun(options.controllerRunId),
    readBoundedReviewFile(options.reviewFile),
  ]);
  const identityFindings = [
    ...pullRequestIdentityFindings(pullRequest, options),
    ...controllerRunFindings(controllerRun, options),
  ];
  if (identityFindings.length > 0) throw new Error(`candidate identity failed: ${identityFindings.join('; ')}`);
  let reviewFindings;
  if (review?.risk?.highRisk === true) {
    if (!isRecord(review) || !exactPositiveInteger(review?.reviewClaim?.checkRunId)) {
      throw new Error('review binding failed: trusted review evidence or claim check ID is invalid');
    }
    const claimMarker = await client.getCheckRun(review.reviewClaim.checkRunId);
    reviewFindings = reviewEvidenceFindings(review, options, claimMarker);
  } else {
    reviewFindings = lowRiskReviewEvidenceFindings(review, options);
  }
  if (reviewFindings.length > 0) throw new Error(`review binding failed: ${reviewFindings.join('; ')}`);

  const changedFiles = await client.getPullRequestFiles(options.prNumber, options.headSha, pullRequest.base.sha);
  const changedPaths = changedFiles.map((file) => file.filename);
  if (changedPaths.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new Error('candidate changed-file list is invalid');
  }
  const changedLedgerPaths = OPEN_PR_LEDGER_PATHS.filter((path) => changedPaths.includes(path));
  const changedLedgerRecords = Object.fromEntries(
    await Promise.all(
      changedLedgerPaths.map(async (path) => [path, await client.getFile(path, options.headSha, OPEN_PR_LEDGER_PATHS)]),
    ),
  );
  const pullRequestCommits = changedLedgerPaths.length > 0 ? await client.getPullRequestCommits(options.prNumber) : [];
  const ledgerFindings =
    changedLedgerPaths.length > 0
      ? openPullRequestLedgerFindings(changedLedgerRecords, options, pullRequestCommits)
      : [];
  if (ledgerFindings.length > 0)
    throw new Error(`open pull-request ledger identity failed: ${ledgerFindings.join('; ')}`);
  const currentProgramText =
    changedLedgerRecords[PROGRAM_PATH] ?? (await client.getFile(PROGRAM_PATH, options.headSha, OPEN_PR_LEDGER_PATHS));
  const previousProgramText = await client.getFile(PROGRAM_PATH, pullRequest.base.sha, OPEN_PR_LEDGER_PATHS);
  const verifyPhase2 = phaseEvidenceNeedsLiveVerification({
    phase: 2,
    changedPaths,
    previousProgramText,
    currentProgramText,
  });
  if (verifyPhase2 && review.risk.highRisk !== true) {
    throw new Error('review binding failed: Phase 2 program evidence requires an independent high-risk review');
  }
  if (!verifyPhase2) {
    await requireStableFinalCandidate(client, pullRequest, options);
    return sanitizedSuccess(options, undefined, 'not_applicable');
  }

  const evidenceText = await client.getFile(PHASE_2_EVIDENCE_PATH, options.headSha, [PHASE_2_EVIDENCE_PATH]);
  const programFindings = acceptedPhaseEvidenceFindings(currentProgramText, (path) =>
    path === PROGRAM_EVIDENCE[1] ? true : path === PHASE_2_EVIDENCE_PATH,
  );
  if (programFindings.length > 0)
    throw new Error(`program evidence registration failed: ${programFindings.join('; ')}`);
  const evidence = parseStrictJson(evidenceText, PHASE_2_EVIDENCE_PATH);
  const shapeFindings = phase2EvidenceShapeFindings(evidence);
  if (shapeFindings.length > 0) throw new Error(`phase 2 evidence schema failed: ${shapeFindings.join('; ')}`);
  const observed = await collectPhase2Observed(evidence, client, dependencies);
  const findings = phase2EvidenceFindings(evidence, observed);
  if (findings.length > 0) throw new Error(`phase 2 evidence verification failed: ${findings.join('; ')}`);
  await requireStableFinalCandidate(client, pullRequest, options);
  return sanitizedSuccess(options, evidence, 'verified');
}

export async function verifyOfflineProgramEvidence({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const programPath = join(repositoryRoot, PROGRAM_PATH);
  if (!existsSync(programPath)) return { verified: 0, errors: [`${PROGRAM_PATH}: authoritative program is missing`] };
  const programText = await readFile(programPath, 'utf8');
  const errors = acceptedPhaseEvidenceFindings(programText, (path) => existsSync(join(repositoryRoot, path)));
  const evidencePath = join(repositoryRoot, PHASE_2_EVIDENCE_PATH);
  let verified = 0;
  if (existsSync(evidencePath)) {
    try {
      const evidence = parseStrictJson(await readFile(evidencePath, 'utf8'), PHASE_2_EVIDENCE_PATH);
      errors.push(...phase2EvidenceShapeFindings(evidence).map((finding) => `${PHASE_2_EVIDENCE_PATH}: ${finding}`));
      if (errors.length === 0) verified = 1;
    } catch (error) {
      errors.push(`${PHASE_2_EVIDENCE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { verified, errors };
}

function parseOptions(argv) {
  const command = argv[2];
  if (!['offline', 'trusted-pr'].includes(command)) throw new Error('command must be offline or trusted-pr');
  const values = new Map();
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('arguments must use --name value pairs');
    if (values.has(key)) throw new Error(`duplicate argument: ${key}`);
    values.set(key, value);
  }
  if (command === 'offline') {
    const repositoryRoot = resolve(values.get('--repository-root') || REPOSITORY_ROOT);
    return { command, repositoryRoot };
  }
  const repository = values.get('--repository');
  const prNumber = Number(values.get('--pr'));
  const headSha = String(values.get('--head-sha') || '').toLowerCase();
  const controllerRunId = Number(values.get('--controller-run-id'));
  const controllerSha = String(values.get('--controller-sha') || '').toLowerCase();
  const reviewFile = values.get('--review-file');
  const outputFile = values.get('--output-file');
  if (repository !== 'JueZ/api') throw new Error('--repository must be JueZ/api');
  if (!exactPositiveInteger(prNumber)) throw new Error('--pr must be a positive integer');
  if (!EXACT_SHA.test(headSha)) throw new Error('--head-sha must be an exact lowercase SHA');
  if (!exactPositiveInteger(controllerRunId)) throw new Error('--controller-run-id must be a positive integer');
  if (!EXACT_SHA.test(controllerSha)) throw new Error('--controller-sha must be an exact lowercase SHA');
  if (!reviewFile) throw new Error('--review-file is required');
  if (!outputFile) throw new Error('--output-file is required');
  return { command, repository, prNumber, headSha, controllerRunId, controllerSha, reviewFile, outputFile };
}

async function runCli() {
  const options = parseOptions(process.argv);
  if (options.command === 'offline') {
    const result = await verifyOfflineProgramEvidence(options);
    if (result.errors.length > 0)
      throw new Error(`Program evidence validation failed:\n- ${result.errors.join('\n- ')}`);
    console.log(
      result.verified > 0
        ? `Program evidence schema validation passed for ${result.verified} candidate record.`
        : 'Program evidence registration validation passed; no Phase 2 record is staged.',
    );
    return;
  }
  const result = await verifyTrustedPullRequest(options);
  await writeFile(options.outputFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(
    result.status === 'verified'
      ? `Trusted program evidence verified Phase ${result.phase} for exact head ${result.verifiedHeadSha}.`
      : `Trusted program evidence is not applicable to exact head ${result.verifiedHeadSha}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
