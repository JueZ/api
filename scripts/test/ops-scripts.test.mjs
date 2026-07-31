import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseLedger } from '../validate-release-ledger.mjs';
import { parseRepairIssueBody, decideRepairIssueAction } from '../triage-repair-issues.mjs';
import { forbiddenDiffFindings, highRiskPaths } from '../policy-guardrails.mjs';
import {
  DEFAULT_SMOKE_FETCH_TIMEOUT_MS,
  fetchJson,
  fetchWithTimeout,
  getSmokeFetchTimeoutMs,
  isTimeoutError,
} from '../lib/smoke-utils.mjs';
import { runAuthenticatedSmoke } from '../smoke-auth.mjs';
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
    deliveryCorrelation: 'delivery-12345678',
    functionAppName: 'func-api',
    apiBaseUrl: 'https://example.test',
    artifacts: {
      functionappSha256: 'b'.repeat(64),
      frontendSha256: 'c'.repeat(64),
      sbomSha256: 'd'.repeat(64),
    },
    smokeRunId: 'smoke-1',
    smokeResults: { status: 'passed' },
    authenticatedSmokeResults: { status: 'blocked_auth_smoke', blockedReason: 'token missing' },
    telemetryCheckResult: { status: 'blocked_telemetry', blockedReason: 'permission missing' },
    verifiedAt: '2026-05-17T00:00:00.000Z',
  };
  assert.deepEqual(validateReleaseLedger(ledger), []);
  assert.ok(
    validateReleaseLedger({ ...ledger, deliveryCorrelation: undefined }).includes(
      'Missing required field: deliveryCorrelation',
    ),
  );
  assert.ok(
    validateReleaseLedger(ledger, { expectedDeliveryCorrelation: 'delivery-other123' }).includes(
      'deliveryCorrelation does not match the expected workflow dispatch',
    ),
  );
});

test('repair issue parser finds PRs and workflow runs', () => {
  const parsed = parseRepairIssueBody('Fix in PR #123. Workflow run: https://github.com/JueZ/api/actions/runs/456');
  assert.deepEqual(parsed.prNumbers, [123]);
  assert.deepEqual(parsed.workflowRunIds, ['456']);
});

test('repair issue decision closes PR-check issues only with merged PR and check evidence', () => {
  assert.equal(
    decideRepairIssueAction(
      { title: 'CI check failed', body: 'PR #1' },
      { prStates: [{ number: 1, merged: true, checksPassed: true }] },
    ).action,
    'close',
  );
});

test('policy guardrails detect high-risk paths and removed telemetry', () => {
  assert.deepEqual(highRiskPaths(['scripts/check-telemetry.mjs', 'README.md']), ['scripts/check-telemetry.mjs']);
  assert.ok(forbiddenDiffFindings('- npm run ops:check-telemetry').includes('telemetry-verification-removed'));
});

test('policy guardrails ignore negated disable warnings while blocking actual disable changes', () => {
  assert.ok(
    !forbiddenDiffFindings(
      '- Do not disable tests, weaken authentication, remove policy checks, or commit secrets.',
    ).includes('ci-policy-disabled'),
  );
  assert.ok(
    !forbiddenDiffFindings('+ Repair must happen without disabling CI or policy checks.').includes(
      'ci-policy-disabled',
    ),
  );
  assert.ok(forbiddenDiffFindings('+ dis' + 'able CI=true').includes('ci-policy-disabled'));
  assert.ok(forbiddenDiffFindings('+ continue-on-error: true').includes('ci-policy-disabled'));
  assert.ok(!forbiddenDiffFindings('+ return new BringDisabledError() || new BringPolicyError()').length);
});

test('policy guardrails distinguish OIDC hardening from client-secret authentication', () => {
  assert.ok(!forbiddenDiffFindings('+ persist-credentials: false').includes('oidc-replaced-by-secret'));
  assert.ok(!forbiddenDiffFindings("+ name: 'reddit-client-secret'").includes('oidc-replaced-by-secret'));
  assert.ok(forbiddenDiffFindings('+ AZURE_CLIENT_' + 'SECRET=unsafe').includes('oidc-replaced-by-secret'));
  assert.ok(forbiddenDiffFindings('+ client-' + 'secret: unsafe').includes('oidc-replaced-by-secret'));
  assert.ok(!forbiddenDiffFindings('+ added: /^\\+.*print' + 'env/im').includes('secret-logging-risk'));
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

test('smoke token mint supports a dedicated least-privilege canary identity', () => {
  const config = selectServiceAuthConfig({
    ENVIRONMENT_NAME: 'test',
    SERVICE_AUTH_PREFIX: 'BRING_CANARY',
    BRING_CANARY_SERVICE_AUTH_CLIENT_ID: 'canary-client',
    BRING_CANARY_SERVICE_AUTH_TENANT_ID: 'canary-tenant',
    BRING_CANARY_SERVICE_AUTH_SCOPE: 'api://example/.default',
  });
  assert.equal(config.prefix, 'BRING_CANARY');
  assert.equal(config.clientId, 'canary-client');
  assert.deepEqual(missingServiceAuthFields(config), []);
  assert.throws(() => selectServiceAuthConfig({ SERVICE_AUTH_PREFIX: '../../BAD' }), /SERVICE_AUTH_PREFIX/);
});

test('smoke token timeout override defaults and validates safe bounds', () => {
  assert.equal(parseSmokeTokenFetchTimeoutMs({}), DEFAULT_SMOKE_FETCH_TIMEOUT_MS);
  assert.equal(parseSmokeTokenFetchTimeoutMs({ SMOKE_FETCH_TIMEOUT_MS: '2500' }), 2500);
  assert.equal(parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: '1500' }), 1500);
  assert.throws(
    () => parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: '0' }),
    /SMOKE_TOKEN_FETCH_TIMEOUT_MS/,
  );
  assert.throws(
    () => parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: '120001' }),
    /SMOKE_TOKEN_FETCH_TIMEOUT_MS/,
  );
  assert.throws(
    () => parseSmokeTokenFetchTimeoutMs({ SMOKE_TOKEN_FETCH_TIMEOUT_MS: 'secret-ish' }),
    /SMOKE_TOKEN_FETCH_TIMEOUT_MS/,
  );
});

test('smoke token endpoint error code sanitizer avoids unsafe response text', () => {
  assert.equal(sanitizeTokenEndpointErrorCode('invalid_client'), 'invalid_client');
  assert.equal(sanitizeTokenEndpointErrorCode('invalid client: token abc123'), '');
  assert.equal(sanitizeTokenEndpointErrorCode('x'.repeat(97)), '');
});

test('fetchWithTimeout aborts slow fetch calls', async () => {
  const originalFetch = globalThis.fetch;
  const keepAlive = setTimeout(() => {}, 50);
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });

  try {
    await assert.rejects(fetchWithTimeout('https://example.test', {}, 1), (error) => isTimeoutError(error));
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
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

test('authenticated smoke retries transient health and protected endpoint 404s after deployment', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const path = new URL(String(url)).pathname;
      if (path === '/health' && calls.filter((call) => new URL(call).pathname === '/health').length === 1) {
        return new Response('not ready', { status: 404 });
      }
      if (path === '/api/hello' && calls.filter((call) => new URL(call).pathname === '/api/hello').length === 1) {
        return new Response('not ready', { status: 404 });
      }
      if (
        path === '/api/reddit/thread' &&
        calls.filter((call) => new URL(call).pathname === '/api/reddit/thread').length === 1
      ) {
        return new Response('not ready', { status: 404 });
      }
      if (path === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', environmentName: 'prod', deployedCommitSha: 'a'.repeat(40) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path === '/api/hello') {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/reddit/thread') {
        return new Response(JSON.stringify({ source: 'reddit' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const { result, exitCode } = await runAuthenticatedSmoke({
      env: {
        API_BASE_URL: 'https://api.example.test',
        AUTH_ACCESS_TOKEN: 'token',
        ENVIRONMENT_NAME: 'prod',
        EXPECTED_DEPLOYED_COMMIT_SHA: 'a'.repeat(40),
        SMOKE_RUN_ID: 'smoke-test',
        AUTH_HEALTH_RETRY_ATTEMPTS: '2',
        AUTH_HEALTH_RETRY_DELAY_MS: '0',
        AUTH_PROTECTED_RETRY_ATTEMPTS: '2',
        AUTH_PROTECTED_RETRY_DELAY_MS: '0',
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(result.status, 'passed');
    assert.equal(calls.filter((call) => new URL(call).pathname === '/health').length, 2);
    assert.equal(calls.filter((call) => new URL(call).pathname === '/api/hello').length, 2);
    assert.equal(calls.filter((call) => new URL(call).pathname === '/api/reddit/thread').length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated smoke reports only safe REC and permission evidence for authorization failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', environmentName: 'test', deployedCommitSha: 'c'.repeat(40) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path === '/api/hello') {
        return new Response(
          JSON.stringify({
            classification: 'authorization_context_mismatch',
            detail: 'Required permission is missing: catalogue.read.',
            repairable: true,
            retry_policy: { can_retry: true, same_request: false },
          }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const tokenPayload = Buffer.from(
      JSON.stringify({ idtyp: 'app', azpacr: '2', roles: ['api.service'], scp: '' }),
    ).toString('base64url');
    const { result, exitCode } = await runAuthenticatedSmoke({
      env: {
        API_BASE_URL: 'https://api.example.test',
        AUTH_ACCESS_TOKEN: `header.${tokenPayload}.signature`,
        ENVIRONMENT_NAME: 'test',
        EXPECTED_DEPLOYED_COMMIT_SHA: 'c'.repeat(40),
        SMOKE_RUN_ID: 'smoke-auth-denied',
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      result.checks.find((check) => check.name === 'token-authorization-context'),
      {
        name: 'token-authorization-context',
        status: 'observed',
        tokenFormat: 'jwt',
        tokenTypeMarker: 'app',
        hasClientCredentialAuthMethod: true,
        recognizedRoles: [],
        recognizedScopes: [],
        unrecognizedRoleCount: 1,
        unrecognizedScopeCount: 0,
      },
    );
    assert.deepEqual(
      result.checks.find((check) => check.name === 'authenticated-hello-authorization'),
      {
        name: 'authenticated-hello-authorization',
        status: 'failed',
        statusCode: 403,
        problemFormat: 'repairable_problem',
        classification: 'authorization_context_mismatch',
        requiredPermission: 'catalogue.read',
        repairable: true,
        canRetry: true,
        sameRequest: false,
      },
    );
    assert.equal(JSON.stringify(result).includes('api.service'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated share URL smoke passes only when expected post id matches', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: options.body ? JSON.parse(String(options.body)) : null });
      if (path === '/health') {
        return new Response(
          JSON.stringify({ status: 'ok', environmentName: 'test', deployedCommitSha: 'b'.repeat(40) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path === '/api/hello') {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/reddit/thread') {
        const body = JSON.parse(String(options.body));
        const postId = body.post.includes('/s/') ? '1tryldy' : '87';
        return new Response(JSON.stringify({ post: { id: postId } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const { result, exitCode } = await runAuthenticatedSmoke({
      env: {
        API_BASE_URL: 'https://api.example.test',
        AUTH_ACCESS_TOKEN: 'token',
        ENVIRONMENT_NAME: 'test',
        EXPECTED_DEPLOYED_COMMIT_SHA: 'b'.repeat(40),
        SMOKE_RUN_ID: 'smoke-test',
        REDDIT_SHARE_URL_SMOKE_ENABLED: 'true',
        REDDIT_SHARE_URL_SMOKE_URL: 'https://www.reddit.com/r/macbookpro/s/nnlryuZCNX',
        REDDIT_SHARE_URL_SMOKE_EXPECTED_POST_ID: '1tryldy',
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(result.status, 'passed');
    assert.deepEqual(
      result.checks.find((check) => check.name === 'reddit-share-url-resolution'),
      { name: 'reddit-share-url-resolution', status: 'passed', postId: '1tryldy' },
    );
    assert.equal(calls.filter((call) => call.path === '/api/reddit/thread').length, 2);
    assert.equal(calls.at(-1).body.post, 'https://www.reddit.com/r/macbookpro/s/nnlryuZCNX');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated share URL smoke records Reddit challenge as dependency blocked', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', environmentName: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/hello') {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/reddit/thread') {
        const body = JSON.parse(String(options.body));
        if (body.post.includes('/s/')) {
          return new Response(
            JSON.stringify({
              code: 'REDDIT_SHARE_RESOLUTION_BLOCKED',
              detail: 'Reddit web returned HTTP 403 challenge without exposing a canonical /comments/<id> redirect.',
              resolution: { httpStatus: 403 },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ post: { id: '87' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const { result, exitCode } = await runAuthenticatedSmoke({
      env: {
        API_BASE_URL: 'https://api.example.test',
        AUTH_ACCESS_TOKEN: 'token',
        ENVIRONMENT_NAME: 'test',
        SMOKE_RUN_ID: 'smoke-test',
        REDDIT_SHARE_URL_SMOKE_ENABLED: 'true',
        REDDIT_SHARE_URL_SMOKE_URL: 'https://www.reddit.com/r/macbookpro/s/nnlryuZCNX',
        REDDIT_SHARE_URL_SMOKE_EXPECTED_POST_ID: '1tryldy',
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(result.status, 'dependency_blocked');
    assert.equal(result.blockedReason, 'reddit web share URL resolution blocked from server egress');
    assert.deepEqual(
      result.checks.find((check) => check.name === 'reddit-share-url-resolution'),
      {
        name: 'reddit-share-url-resolution',
        status: 'dependency_blocked',
        statusCode: 400,
        upstreamStatusCode: 403,
        safeReason: 'reddit web returned a 403/challenge or rate limit without canonical metadata',
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('smoke and release ledger modules import without operational side effects', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalApiBaseUrl = process.env.API_BASE_URL;
  const tempDir = await mkdtemp(join(tmpdir(), 'ops-script-import-'));
  let fetchCalls = 0;

  t.after(async () => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
    await rm(tempDir, { recursive: true, force: true });
  });

  delete process.env.API_BASE_URL;
  process.chdir(tempDir);
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('import should not fetch');
  };

  const cacheBust = `?importSafety=${Date.now()}`;
  const runtimeSmoke = await import(
    `${pathToFileURL(resolve(originalCwd, 'scripts/smoke-runtime.mjs')).href}${cacheBust}`
  );
  const authSmoke = await import(`${pathToFileURL(resolve(originalCwd, 'scripts/smoke-auth.mjs')).href}${cacheBust}`);
  const releaseLedger = await import(
    `${pathToFileURL(resolve(originalCwd, 'scripts/write-release-ledger.mjs')).href}${cacheBust}`
  );

  assert.equal(typeof runtimeSmoke.runRuntimeSmoke, 'function');
  assert.equal(typeof authSmoke.runAuthenticatedSmoke, 'function');
  assert.equal(typeof releaseLedger.writeReleaseLedger, 'function');
  assert.equal(fetchCalls, 0);
  assert.equal(existsSync(join(tempDir, 'release-ledger.json')), false);
});
