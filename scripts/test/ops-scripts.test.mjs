import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseLedger } from '../validate-release-ledger.mjs';
import { parseRepairIssueBody, decideRepairIssueAction } from '../triage-repair-issues.mjs';
import { forbiddenDiffFindings, highRiskPaths } from '../policy-guardrails.mjs';
import { missingServiceAuthFields, selectServiceAuthConfig } from '../mint-smoke-token.mjs';
import {
  DEFAULT_SMOKE_FETCH_TIMEOUT_MS,
  fetchJson,
  fetchWithTimeout,
  getSmokeFetchTimeoutMs,
} from '../lib/smoke-utils.mjs';

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

test('smoke fetch timeout config uses safe defaults and positive overrides', () => {
  assert.equal(getSmokeFetchTimeoutMs(undefined), DEFAULT_SMOKE_FETCH_TIMEOUT_MS);
  assert.equal(getSmokeFetchTimeoutMs(''), DEFAULT_SMOKE_FETCH_TIMEOUT_MS);
  assert.equal(getSmokeFetchTimeoutMs('0'), DEFAULT_SMOKE_FETCH_TIMEOUT_MS);
  assert.equal(getSmokeFetchTimeoutMs('2500.9'), 2500);
});

test('fetchJson applies timeouts while preserving caller fetch options', async () => {
  const originalFetch = globalThis.fetch;
  const seen = {};
  try {
    globalThis.fetch = async (url, options) => {
      seen.url = url;
      seen.options = options;
      return new Response('{"ok":true}', { status: 201 });
    };

    const headers = { 'X-Smoke-Run-Id': 'smoke-test' };
    const result = await fetchJson('https://example.test/data', {
      method: 'POST',
      headers,
      body: 'payload',
      redirect: 'manual',
      timeoutMs: 5000,
    });

    assert.equal(result.response.status, 201);
    assert.deepEqual(result.json, { ok: true });
    assert.equal(seen.url, 'https://example.test/data');
    assert.equal(seen.options.method, 'POST');
    assert.equal(seen.options.headers, headers);
    assert.equal(seen.options.body, 'payload');
    assert.equal(seen.options.redirect, 'manual');
    assert.ok(seen.options.signal instanceof AbortSignal);
    assert.equal('timeoutMs' in seen.options, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchWithTimeout reports concise timeout errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
      const delay = setTimeout(() => resolve(new Response('{}')), 100);
      options.signal.addEventListener('abort', () => {
        clearTimeout(delay);
        reject(options.signal.reason);
      }, { once: true });
    });

    await assert.rejects(
      fetchWithTimeout('https://example.test/slow', { timeoutMs: 1 }),
      (error) => error.name === 'SmokeFetchTimeoutError' && error.message === 'fetch timed out after 1ms',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
