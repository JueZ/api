import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTelemetryQuery,
  parseAzureMonitorQueryResult,
  sanitizeTelemetrySmokeRunId,
  telemetryDecision,
  shouldRetryTelemetry,
} from '../check-telemetry.mjs';
import {
  parseRepairIssueBody,
  classifyRepairIssue,
  decideRepairIssueAction,
  hasDuplicateTriageComment,
} from '../triage-repair-issues.mjs';
import { decideRuntimeTruth, summarizeLedger } from '../runtime-truth.mjs';

const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ledger = {
  environment: 'prod',
  deployedCommit: sha,
  sourceRef: sha,
  workflowRunId: '123',
  functionAppName: 'func-api',
  apiBaseUrl: 'https://example.test',
  smokeRunId: 'smoke-prod-1',
  smokeResults: { status: 'passed' },
  authenticatedSmokeResults: { status: 'passed' },
  telemetryCheckResult: { status: 'passed', checks: { smokeEvidenceCount: 1 } },
  verifiedAt: '2026-05-17T00:00:00.000Z',
};

test('telemetry KQL sanitizes smoke run IDs', () => {
  assert.equal(sanitizeTelemetrySmokeRunId("smoke-prod'; drop table"), 'smoke-prod-drop-table');
  const query = buildTelemetryQuery({ timespanMinutes: 45, smokeRunId: "smoke-prod'; drop" });
  assert.ok(query.includes("let smokeRunId = 'smoke-prod-drop';"));
  assert.ok(query.includes('smokeTraceCount'));
  assert.ok(query.includes('smokeRequestCount'));
});

test('telemetry parser reads Azure Monitor output by column name', () => {
  const parsed = parseAzureMonitorQueryResult({ tables: [{ columns: [{ name: 'smokeEvidenceCount' }, { name: 'failedRequests' }, { name: 'exceptions' }, { name: 'http5xx' }, { name: 'smokeTraceCount' }, { name: 'smokeRequestCount' }], rows: [[3, 0, 0, 0, 1, 2]] }] });
  assert.deepEqual(parsed, { exceptions: 0, http5xx: 0, failedRequests: 0, smokeTraceCount: 1, smokeRequestCount: 2, smokeEvidenceCount: 3 });
});

test('telemetry decision passes with clean checks and smoke evidence', () => {
  const decision = telemetryDecision({ environmentName: 'prod', failClosed: true, requireSmokeCorrelation: true, smokeRunId: 'smoke-prod', checks: { smokeEvidenceCount: 1 } });
  assert.equal(decision.status, 'passed');
});

test('telemetry decision fails when prod requires missing smoke correlation', () => {
  const decision = telemetryDecision({ environmentName: 'prod', failClosed: true, requireSmokeCorrelation: true, smokeRunId: 'smoke-prod', checks: { smokeEvidenceCount: 0 } });
  assert.equal(decision.status, 'failed');
  assert.equal(decision.exitCode, 1);
});

test('telemetry decision fails for runtime errors', () => {
  for (const checks of [{ exceptions: 1 }, { http5xx: 1 }, { failedRequests: 1 }]) {
    assert.equal(telemetryDecision({ environmentName: 'prod', checks }).status, 'failed');
  }
});

test('telemetry decision blocks when query config is missing', () => {
  const decision = telemetryDecision({ environmentName: 'prod', querySucceeded: false, blockedReason: 'Application Insights identifier is not configured.' });
  assert.equal(decision.status, 'blocked_telemetry');
  assert.equal(decision.exitCode, 2);
});

test('telemetry retry is limited to transient query or missing required smoke evidence', () => {
  assert.equal(shouldRetryTelemetry({ decision: { checks: { smokeEvidenceCount: 0 } }, smokeRunId: 'smoke', requireSmokeCorrelation: true, attempt: 1, maxAttempts: 2, querySucceeded: true }), true);
  assert.equal(shouldRetryTelemetry({ decision: { checks: { smokeEvidenceCount: 1 } }, smokeRunId: 'smoke', requireSmokeCorrelation: true, attempt: 1, maxAttempts: 2, querySucceeded: true }), false);
  assert.equal(shouldRetryTelemetry({ decision: {}, smokeRunId: 'smoke', requireSmokeCorrelation: true, attempt: 2, maxAttempts: 2, querySucceeded: false }), false);
});

test('repair parser finds PRs, workflow run URLs, run IDs, commit SHAs, and environment', () => {
  const parsed = parseRepairIssueBody(`Production failure fixed by PR #169. Run https://github.com/JueZ/api/actions/runs/123 for ${sha}`);
  assert.deepEqual(parsed.prNumbers, [169]);
  assert.deepEqual(parsed.workflowRunIds, ['123']);
  assert.deepEqual(parsed.commitShas, [sha]);
  assert.equal(parsed.environment, 'prod');
});

test('repair classifier distinguishes production failures from PR checks', () => {
  assert.equal(classifyRepairIssue({ title: 'Production smoke failed', body: '' }), 'production_failure');
  assert.equal(classifyRepairIssue({ title: 'CI check failed', body: '' }), 'pr_check_failure');
});

test('repair decision does not close production issue merely because a PR merged', () => {
  const decision = decideRepairIssueAction({ title: 'Production smoke failed', body: 'PR #1 merged' }, { prStates: [{ merged: true, checksPassed: true }] });
  assert.equal(decision.action, 'comment');
});

test('repair decision closes PR-check issue with merged PR and CI evidence but no prod ledger', () => {
  const decision = decideRepairIssueAction({ title: 'CI check failed', body: 'PR #1' }, { prStates: [{ merged: true, checksPassed: true }] });
  assert.equal(decision.action, 'close');
});

test('repair decision closes production issue with valid later production ledger', () => {
  const decision = decideRepairIssueAction({ title: 'Production smoke failed', body: '' }, { productionVerification: { ledger, workflowConclusion: 'success', validationErrors: [], liveHealth: { deployedCommitSha: sha } } });
  assert.equal(decision.action, 'close');
});

test('repair decision leaves production issue open when auth smoke is blocked or failed', () => {
  const blockedLedger = { ...ledger, authenticatedSmokeResults: { status: 'blocked_auth_smoke' } };
  const decision = decideRepairIssueAction({ title: 'Production smoke failed', body: '' }, { productionVerification: { ledger: blockedLedger, workflowConclusion: 'success', validationErrors: [] } });
  assert.equal(decision.action, 'comment');
});

test('repair decision leaves production issue open on live health SHA mismatch', () => {
  const decision = decideRepairIssueAction({ title: 'Production smoke failed', body: '' }, { productionVerification: { ledger, workflowConclusion: 'success', validationErrors: [], liveHealth: { deployedCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } } });
  assert.equal(decision.action, 'comment');
});

test('repair duplicate marker logic is stable per issue and decision kind', () => {
  assert.equal(hasDuplicateTriageComment([{ body: '<!-- codex-repair-triage:7:resolved-production-verification -->\nreason' }], 7, 'resolved-production-verification', 'reason'), true);
  assert.equal(hasDuplicateTriageComment([{ body: '<!-- codex-repair-triage:7:resolved-production-verification -->\nreason' }], 7, 'production-evidence-needed'), false);
});

test('runtime truth decision verifies live health and ledger match', () => {
  const decision = decideRuntimeTruth({ live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } }, ledger, options: { includeLedger: true, environment: 'prod', expectedSha: sha }, ledgerErrors: [] });
  assert.equal(decision.status, 'verified');
  assert.equal(summarizeLedger(ledger).smokeResultsStatus, 'passed');
});

test('runtime truth decision detects live health mismatch', () => {
  const decision = decideRuntimeTruth({ live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }, ledger, options: { includeLedger: true, environment: 'prod', expectedSha: sha }, ledgerErrors: [] });
  assert.equal(decision.status, 'failed');
});

test('runtime truth decision blocks when ledger evidence is missing', () => {
  const decision = decideRuntimeTruth({ live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } }, ledger: null, options: { includeLedger: true, environment: 'prod', expectedSha: sha }, ledgerErrors: [] });
  assert.equal(decision.status, 'blocked');
});

test('runtime truth decision detects live and ledger SHA mismatch', () => {
  const decision = decideRuntimeTruth({ live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } }, ledger: { ...ledger, deployedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, options: { includeLedger: true, environment: 'prod', expectedSha: '' }, ledgerErrors: [] });
  assert.equal(decision.status, 'failed');
});
