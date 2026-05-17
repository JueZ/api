import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseLedger } from '../validate-release-ledger.mjs';
import { parseRepairIssueBody, decideRepairIssueAction } from '../triage-repair-issues.mjs';
import { forbiddenDiffFindings, highRiskPaths } from '../policy-guardrails.mjs';

test('release ledger validation accepts required runtime truth fields', () => {
  const ledger = {
    environment: 'prod',
    deployedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workflowRunId: '123',
    functionAppName: 'func-api',
    apiBaseUrl: 'https://example.test',
    smokeRunId: 'smoke-1',
    smokeResults: { status: 'passed' },
    authenticatedSmokeResults: { status: 'blocked_auth_smoke', blockedReason: 'token missing' },
    telemetryCheckResult: { status: 'blocked_telemetry', blockedReason: 'permission missing' },
    verifiedAt: '2026-05-17T00:00:00.000Z',
  };
  assert.deepEqual(validateReleaseLedger(ledger), []);
});

test('repair issue parser finds PRs and workflow runs', () => {
  const parsed = parseRepairIssueBody('Fix in PR #123. Workflow run: https://github.com/JueZ/api/actions/runs/456');
  assert.deepEqual(parsed.prNumbers, [123]);
  assert.deepEqual(parsed.workflowRunIds, ['456']);
});

test('repair issue decision closes merged repairs', () => {
  assert.equal(decideRepairIssueAction({}, [{ number: 1, merged: true }]).action, 'close');
});

test('policy guardrails detect high-risk paths and removed telemetry', () => {
  assert.deepEqual(highRiskPaths(['scripts/check-telemetry.mjs', 'README.md']), ['scripts/check-telemetry.mjs']);
  assert.ok(forbiddenDiffFindings('- npm run ops:check-telemetry').includes('telemetry-verification-removed'));
});
