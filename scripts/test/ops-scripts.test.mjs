import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseLedger } from '../validate-release-ledger.mjs';
import { parseRepairIssueBody, decideRepairIssueAction } from '../triage-repair-issues.mjs';
import { forbiddenDiffFindings, highRiskPaths } from '../policy-guardrails.mjs';
import { DEFAULT_SMOKE_FETCH_TIMEOUT_MS, fetchWithTimeout, isTimeoutError } from '../lib/smoke-utils.mjs';
import {
  missingServiceAuthFields,
  parseSmokeTokenFetchTimeoutMs,
  sanitizeTokenEndpointErrorCode,
  selectServiceAuthConfig,
} from '../mint-smoke-token.mjs';

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

test('repair issue decision closes PR-check issues only with merged PR and check evidence', () => {
  assert.equal(decideRepairIssueAction({ title: 'CI check failed', body: 'PR #1' }, { prStates: [{ number: 1, merged: true, checksPassed: true }] }).action, 'close');
});

test('policy guardrails detect high-risk paths and removed telemetry', () => {
  assert.deepEqual(highRiskPaths(['scripts/check-telemetry.mjs', 'README.md']), ['scripts/check-telemetry.mjs']);
  assert.ok(forbiddenDiffFindings('- npm run ops:check-telemetry').includes('telemetry-verification-removed'));
});

test('policy guardrails ignore negated disable warnings while blocking actual disable changes', () => {
  assert.ok(!forbiddenDiffFindings('- Do not disable tests, weaken authentication, remove policy checks, or commit secrets.').includes('ci-policy-disabled'));
  assert.ok(!forbiddenDiffFindings('+ Repair must happen without disabling CI or policy checks.').includes('ci-policy-disabled'));
  assert.ok(forbiddenDiffFindings('+ dis' + 'able CI=true').includes('ci-policy-disabled'));
});


test('smoke token mint config selects production service variables', () => {
  const config = selectServiceAuthConfig({
    ENVIRONMENT_NAME: 'prod',
    PROD_SERVICE_AUTH_CLIENT_ID: 'client-id',
    PROD_SERVICE_AUTH_TENANT_ID: 'tenant-id',
    PROD_SERVICE_AUTH_SCOPE: 'api://example/.default',
  });

  assert.equal(config.prefix, 'PROD');
  assert.deepEqual(missingServiceAuthFields(config), []);
});

test('smoke token mint config detects missing service variables', () => {
  const config = selectServiceAuthConfig({ ENVIRONMENT_NAME: 'test', TEST_SERVICE_AUTH_CLIENT_ID: 'client-id' });

  assert.equal(config.prefix, 'TEST');
  assert.deepEqual(missingServiceAuthFields(config), ['tenantId', 'scope']);
});


test('smoke token timeout override defaults and validates safe bounds', () => {
  assert.equal(parseSmokeTokenFetchTimeoutMs({}), DEFAULT_SMOKE_FETCH_TIMEOUT_MS);
  assert.equal(parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: '1500' }), 1500);
  assert.throws(() => parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: '0' }), /SMOKE_TOKEN_FETCH_TIMEOUT_MS/);
  assert.throws(() => parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: '120001' }), /SMOKE_TOKEN_FETCH_TIMEOUT_MS/);
  assert.throws(() => parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: 'secret-ish' }), /SMOKE_TOKEN_FETCH_TIMEOUT_MS/);
});

test('smoke token endpoint error code sanitizer avoids unsafe response text', () => {
  assert.equal(sanitizeTokenEndpointErrorCode('invalid_client'), 'invalid_client');
  assert.equal(sanitizeTokenEndpointErrorCode('invalid client: token abc123'), '');
  assert.equal(sanitizeTokenEndpointErrorCode('x'.repeat(97)), '');
});

test('fetchWithTimeout aborts slow fetch calls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  try {
    await assert.rejects(
      fetchWithTimeout('https://example.test', {}, 1),
      (error) => isTimeoutError(error),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
