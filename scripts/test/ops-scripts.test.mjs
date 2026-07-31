import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseLedgerSchema, validateReleaseLedger, validateSchemaValue } from '../validate-release-ledger.mjs';
import { writeReleaseLedger } from '../write-release-ledger.mjs';
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
  decodeAccessTokenClaims,
  missingServiceAuthFields,
  parseSmokeTokenFetchTimeoutMs,
  sanitizeTokenEndpointErrorCode,
  selectServiceAuthConfig,
  serviceAuthConfigProblems,
  serviceTokenAudiences,
  validateServiceTokenClaims,
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

test('release ledger writer output satisfies the published JSON Schema contract', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tempDir = await mkdtemp(join(tmpdir(), 'release-ledger-contract-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const out = join(tempDir, 'release-ledger.json');
  const checkPath = join(tempDir, 'check.json');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(checkPath, '{"status":"passed"}\n'));
  await writeReleaseLedger({
    env: {
      RELEASE_LEDGER_PATH: out,
      ENVIRONMENT_NAME: 'test',
      EXPECTED_DEPLOYED_COMMIT_SHA: 'a'.repeat(40),
      DEPLOYED_SOURCE_REF: 'a'.repeat(40),
      GITHUB_RUN_ID: '123',
      DELIVERY_CORRELATION: 'delivery-12345678',
      EFFECTIVE_FUNCTIONAPP_NAME: 'func-test',
      API_BASE_URL: 'https://example.test',
      RELEASE_FUNCTION_SHA256: 'b'.repeat(64),
      RELEASE_FRONTEND_SHA256: 'c'.repeat(64),
      RELEASE_SBOM_SHA256: 'd'.repeat(64),
      SMOKE_RUN_ID: 'smoke-test-1',
      SMOKE_RESULTS_PATH: checkPath,
      AUTH_SMOKE_RESULTS_PATH: checkPath,
      TELEMETRY_RESULTS_PATH: checkPath,
    },
    argv: [],
  });
  const ledger = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(validateSchemaValue(ledger, releaseLedgerSchema), []);
  assert.deepEqual(validateReleaseLedger(ledger), []);
  assert.deepEqual(releaseLedgerSchema.properties.artifacts.required, [
    'functionappSha256',
    'frontendSha256',
    'sbomSha256',
  ]);
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
  const clientId = '22222222-2222-2222-2222-222222222222';
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const audienceId = '33333333-3333-3333-3333-333333333333';
  const config = selectServiceAuthConfig({
    ENVIRONMENT_NAME: 'prod',
    PROD_SERVICE_AUTH_CLIENT_ID: clientId,
    PROD_SERVICE_AUTH_TENANT_ID: tenantId,
    PROD_SERVICE_AUTH_SCOPE: `api://${audienceId}/.default`,
    SERVICE_AUTH_REQUIRED_ROLES: 'catalogue.read,reddit.read',
  });

  assert.equal(config.prefix, 'PROD');
  assert.deepEqual(config.requiredRoles, ['catalogue.read', 'reddit.read']);
  assert.deepEqual(missingServiceAuthFields(config), []);
  assert.deepEqual(serviceAuthConfigProblems(config), []);
  assert.deepEqual(serviceTokenAudiences(config.scope), [`api://${audienceId}`, audienceId]);
});

test('smoke token mint config detects missing service variables', () => {
  const config = selectServiceAuthConfig({ ENVIRONMENT_NAME: 'test', TEST_SERVICE_AUTH_CLIENT_ID: 'client-id' });

  assert.equal(config.prefix, 'TEST');
  assert.deepEqual(missingServiceAuthFields(config), ['tenantId', 'scope', 'requiredRoles']);
});

test('smoke token mint supports a dedicated least-privilege canary identity', () => {
  const clientId = '55555555-5555-5555-5555-555555555555';
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const audienceId = '33333333-3333-3333-3333-333333333333';
  const config = selectServiceAuthConfig({
    ENVIRONMENT_NAME: 'test',
    SERVICE_AUTH_PREFIX: 'BRING_CANARY',
    BRING_CANARY_SERVICE_AUTH_CLIENT_ID: clientId,
    BRING_CANARY_SERVICE_AUTH_TENANT_ID: tenantId,
    BRING_CANARY_SERVICE_AUTH_SCOPE: `api://${audienceId}/.default`,
    SERVICE_AUTH_REQUIRED_ROLES: 'bring.read',
  });
  assert.equal(config.prefix, 'BRING_CANARY');
  assert.equal(config.clientId, clientId);
  assert.deepEqual(missingServiceAuthFields(config), []);
  assert.deepEqual(serviceAuthConfigProblems(config), []);
  assert.throws(() => selectServiceAuthConfig({ SERVICE_AUTH_PREFIX: '../../BAD' }), /SERVICE_AUTH_PREFIX/);
  assert.throws(
    () => selectServiceAuthConfig({ SERVICE_AUTH_REQUIRED_ROLES: 'bring.read,unsafe role' }),
    /SERVICE_AUTH_REQUIRED_ROLES/,
  );
  const duplicateRoleConfig = selectServiceAuthConfig({
    ENVIRONMENT_NAME: 'test',
    TEST_SERVICE_AUTH_CLIENT_ID: clientId,
    TEST_SERVICE_AUTH_TENANT_ID: tenantId,
    TEST_SERVICE_AUTH_SCOPE: `api://${audienceId}/.default`,
    SERVICE_AUTH_REQUIRED_ROLES: 'bring.read,bring.read',
  });
  assert.deepEqual(serviceAuthConfigProblems(duplicateRoleConfig), ['duplicate_required_roles']);
});

test('smoke token preflight proves the exact v1 or v2 app identity and role set', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const clientId = '22222222-2222-2222-2222-222222222222';
  const audienceId = '33333333-3333-3333-3333-333333333333';
  const config = {
    tenantId,
    clientId,
    scope: `api://${audienceId}/.default`,
    requiredRoles: ['catalogue.read', 'reddit.read'],
  };
  const claims = {
    ver: '2.0',
    tid: tenantId,
    azp: clientId,
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    aud: audienceId,
    sub: 'service-principal-subject',
    idtyp: 'app',
    roles: ['reddit.read', 'catalogue.read'],
  };
  const jwtHeader = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url');
  const jwtSignature = Buffer.from('signature').toString('base64url');
  const token = `${jwtHeader}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${jwtSignature}`;
  const v1Claims = {
    ver: '1.0',
    tid: tenantId,
    appid: clientId,
    iss: `https://sts.windows.net/${tenantId}/`,
    aud: `api://${audienceId}`,
    sub: 'service-principal-subject',
    appidacr: '2',
    roles: ['catalogue.read', 'reddit.read'],
  };
  assert.deepEqual(decodeAccessTokenClaims(token), claims);
  assert.deepEqual(validateServiceTokenClaims(claims, config), []);
  assert.deepEqual(validateServiceTokenClaims(v1Claims, config), []);
  assert.deepEqual(validateServiceTokenClaims({ ...v1Claims, aud: audienceId }, config), []);
  assert.ok(validateServiceTokenClaims({ ...v1Claims, azp: clientId }, config).includes('unexpected_azp'));
  assert.ok(validateServiceTokenClaims({ ...v1Claims, azpacr: '2' }, config).includes('unexpected_azpacr'));
  assert.deepEqual(validateServiceTokenClaims({ ...claims, roles: ['catalogue.read'] }, config), [
    'missing_roles:reddit.read',
  ]);
  assert.deepEqual(validateServiceTokenClaims({ ...claims, roles: [...claims.roles, 'bring.write'] }, config), [
    'unexpected_roles:bring.write',
  ]);
  assert.ok(validateServiceTokenClaims({ ...claims, ver: undefined }, config).includes('invalid_token_version'));
  assert.ok(validateServiceTokenClaims({ ...claims, ver: '3.0' }, config).includes('invalid_token_version'));
  assert.ok(validateServiceTokenClaims({ ...claims, tid: undefined }, config).includes('missing_or_invalid_tenant'));
  assert.ok(
    validateServiceTokenClaims({ ...claims, tid: '44444444-4444-4444-4444-444444444444' }, config).includes(
      'tenant_mismatch',
    ),
  );
  assert.ok(validateServiceTokenClaims({ ...claims, azp: undefined }, config).includes('missing_or_invalid_client'));
  assert.ok(
    validateServiceTokenClaims({ ...claims, azp: '44444444-4444-4444-4444-444444444444' }, config).includes(
      'azp_mismatch',
    ),
  );
  assert.ok(validateServiceTokenClaims({ ...claims, azp: [clientId] }, config).includes('missing_or_invalid_client'));
  assert.ok(validateServiceTokenClaims({ ...claims, appid: clientId }, config).includes('unexpected_appid'));
  assert.ok(
    validateServiceTokenClaims({ ...claims, appid: '44444444-4444-4444-4444-444444444444' }, config).includes(
      'appid_mismatch',
    ),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, iss: `https://sts.windows.net/${tenantId}/` }, config).includes(
      'issuer_mismatch',
    ),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, iss: 'https://login.microsoftonline.com/common/v2.0' }, config).includes(
      'issuer_mismatch',
    ),
  );
  assert.ok(validateServiceTokenClaims({ ...claims, iss: undefined }, config).includes('issuer_mismatch'));
  assert.ok(
    validateServiceTokenClaims(
      { ...claims, iss: `https://LOGIN.microsoftonline.com/${tenantId}/v2.0` },
      config,
    ).includes('issuer_mismatch'),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, aud: 'https://graph.microsoft.com' }, config).includes('audience_mismatch'),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, aud: `api://${audienceId}` }, config).includes('audience_mismatch'),
  );
  assert.ok(validateServiceTokenClaims({ ...claims, aud: [audienceId] }, config).includes('audience_mismatch'));
  assert.ok(validateServiceTokenClaims({ ...claims, aud: undefined }, config).includes('audience_mismatch'));
  assert.ok(validateServiceTokenClaims({ ...claims, sub: '   ' }, config).includes('missing_subject'));
  assert.ok(
    validateServiceTokenClaims({ ...claims, roles: 'catalogue.read reddit.read' }, config).includes(
      'invalid_roles_claim',
    ),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, roles: ['catalogue.read', 3] }, config).includes('invalid_roles_claim'),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, roles: [...claims.roles, claims.roles[0]] }, config).includes(
      'duplicate_roles_claim',
    ),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, scp: 'catalogue.read' }, config).includes('delegated_scope_present'),
  );
  assert.ok(validateServiceTokenClaims({ ...claims, idtyp: 'user' }, config).includes('invalid_idtyp'));
  assert.ok(validateServiceTokenClaims({ ...claims, azpacr: '0' }, config).includes('invalid_azpacr'));
  assert.ok(validateServiceTokenClaims({ ...claims, appidacr: '2' }, config).includes('unexpected_appidacr'));
  assert.ok(
    validateServiceTokenClaims({ ...claims, idtyp: undefined, azpacr: undefined }, config).includes(
      'missing_confidential_client_marker',
    ),
  );
  assert.ok(
    validateServiceTokenClaims({ ...claims, idtyp: undefined, azpacr: '0' }, config).includes(
      'missing_confidential_client_marker',
    ),
  );
  assert.ok(
    validateServiceTokenClaims(
      {
        ver: '1.0',
        tid: tenantId,
        iss: `https://sts.windows.net/${tenantId}/`,
        aud: `api://${audienceId}`,
        sub: 'service-principal-subject',
        appidacr: '2',
        roles: claims.roles,
      },
      config,
    ).includes('missing_or_invalid_client'),
  );
  assert.deepEqual(serviceAuthConfigProblems({ ...config, scope: `${config.scope} other/.default` }), [
    'invalid_scope',
  ]);
  assert.deepEqual(serviceAuthConfigProblems({ ...config, requiredRoles: [] }), ['missing_required_roles']);
  assert.deepEqual(serviceAuthConfigProblems({ ...config, requiredRoles: ['catalogue.read', 'catalogue.read'] }), [
    'duplicate_required_roles',
  ]);
  assert.deepEqual(serviceAuthConfigProblems({ ...config, requiredRoles: ['invalid role'] }), [
    'invalid_required_roles',
  ]);
  assert.deepEqual(validateServiceTokenClaims(claims, { ...config, requiredRoles: [] }), [
    'invalid_config:missing_required_roles',
  ]);
  assert.deepEqual(serviceAuthConfigProblems({ ...config, tenantId: [tenantId], clientId: [clientId] }), [
    'invalid_tenant_id',
    'invalid_client_id',
  ]);
  assert.deepEqual(validateServiceTokenClaims(claims, { ...config, tenantId: [tenantId], clientId: [clientId] }), [
    'invalid_config:invalid_tenant_id',
    'invalid_config:invalid_client_id',
  ]);
  assert.deepEqual(serviceTokenAudiences(`${config.scope} `), []);
  assert.deepEqual(serviceTokenAudiences(`${config.scope},https://graph.microsoft.com/.default`), []);
  assert.throws(() => decodeAccessTokenClaims('not-a-jwt'), /was not a compact JWT/);
  assert.throws(() => decodeAccessTokenClaims(`${token}\nAUTH_ACCESS_TOKEN=unsafe`), /was not a compact JWT/);
  assert.throws(
    () => decodeAccessTokenClaims(`${jwtHeader}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`),
    /was not a compact JWT/,
  );
  assert.throws(() => decodeAccessTokenClaims(`${jwtHeader}.eyJhIjoieCJ9A.${jwtSignature}`), /compact JWT/);
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

test('authenticated smoke reports only API-validated REC permission evidence for authorization failures', async () => {
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
            status: 403,
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

    const { result, exitCode } = await runAuthenticatedSmoke({
      env: {
        API_BASE_URL: 'https://api.example.test',
        AUTH_ACCESS_TOKEN: 'opaque-token-never-emitted',
        ENVIRONMENT_NAME: 'test',
        EXPECTED_DEPLOYED_COMMIT_SHA: 'c'.repeat(40),
        SMOKE_RUN_ID: 'smoke-auth-denied',
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      result.checks.find((check) => check.name === 'authenticated-hello-authorization'),
      {
        name: 'authenticated-hello-authorization',
        status: 'failed',
        statusCode: 403,
        evidenceFormat: 'api_verified_permission_denial',
        classification: 'authorization_context_mismatch',
        requiredPermission: 'catalogue.read',
      },
    );
    assert.equal(JSON.stringify(result).includes('opaque-token-never-emitted'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated smoke does not validate incomplete authorization REC metadata', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', environmentName: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/hello') {
        return new Response(JSON.stringify({ classification: 'authorization_context_mismatch', repairable: true }), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const { result, exitCode } = await runAuthenticatedSmoke({
      env: {
        API_BASE_URL: 'https://api.example.test',
        AUTH_ACCESS_TOKEN: 'opaque-token-never-emitted',
        ENVIRONMENT_NAME: 'test',
        SMOKE_RUN_ID: 'smoke-invalid-rec',
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(
      result.checks.find((check) => check.name === 'authenticated-hello-authorization'),
      {
        name: 'authenticated-hello-authorization',
        status: 'failed',
        statusCode: 403,
        evidenceFormat: 'unusable',
        classification: undefined,
        requiredPermission: undefined,
      },
    );
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
