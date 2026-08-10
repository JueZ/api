import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTelemetryQuery,
  parseAzureMonitorQueryResult,
  sanitizeTelemetrySmokeRunId,
  telemetryDecision,
  shouldRetryTelemetry,
} from '../check-telemetry.mjs';
import { decideRuntimeTruth, summarizeLedger, validateWorkflowRunMetadata } from '../runtime-truth.mjs';
import {
  buildExpectedRuntimeSettings,
  optionalReleaseSettingNames,
  requiredManagedSettingNames,
  validateArmRuntimeSettingsResponse,
  validateDeployedRuntimeSettings,
} from '../validate-deployed-runtime-settings.mjs';

const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ledger = {
  environment: 'prod',
  deployedCommit: sha,
  sourceRef: sha,
  workflowRunId: '123',
  deliveryCorrelation: 'delivery-12345678',
  functionAppName: 'func-api',
  apiBaseUrl: 'https://example.test',
  artifacts: {
    functionappSha256: 'b'.repeat(64),
    frontendSha256: 'c'.repeat(64),
    sbomSha256: 'd'.repeat(64),
  },
  smokeRunId: 'smoke-prod-1',
  smokeResults: { status: 'passed' },
  authenticatedSmokeResults: { status: 'passed' },
  telemetryCheckResult: { status: 'passed', checks: { smokeEvidenceCount: 1 } },
  verifiedAt: '2026-05-17T00:00:00.000Z',
};

const runtimeSettingsEnv = {
  ENVIRONMENT_NAME: 'test',
  EFFECTIVE_HOST_STORAGE_ACCOUNT: 'hosttest123',
  EFFECTIVE_PRIVATE_STORAGE_ACCOUNT: 'privatetest123',
  TEST_WEB_AUTH_REDIRECT_URI: 'https://test.example.test/auth/callback',
  WEB_AUTH_REDIRECT_URI: 'https://prod.example.test/auth/callback',
  OIDC_ISSUER: 'https://login.example.test/tenant/v2.0',
  OIDC_AUDIENCE: 'api://catalogue',
  OIDC_JWKS_URI: 'https://login.example.test/tenant/discovery/v2.0/keys',
  OIDC_ALLOWED_OBJECT_IDS: 'user-object-id',
  OIDC_ALLOWED_SUBJECTS: 'subject-id',
  OIDC_ALLOWED_APP_OBJECT_IDS: 'app-object-id',
  OIDC_ALLOWED_CLIENT_IDS: 'client-id',
  OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'delegated-client-id',
  OIDC_ALLOWED_TENANTS: 'tenant-id',
  MCP_RESOURCE_ORIGIN: 'https://api.example.test',
  MCP_ALLOWED_ORIGINS: 'https://chatgpt.com',
  REDDIT_CLIENT_ID: 'reddit-client-id',
  REDDIT_USER_AGENT: 'catalogue-test',
  REPAIRABLE_ERRORS_LLM_ENABLED: 'true',
  EXPECTED_APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=metadata-only',
  EXPECTED_REDDIT_CLIENT_SECRET_REFERENCE:
    '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/reddit-client-secret/version)',
  EXPECTED_WLH_BASE_URL_REFERENCE: '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/wlh-base-url/version)',
  EXPECTED_BRING_CLIENT_API_KEY_REFERENCE:
    '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/bring-client-api-key/version)',
  EXPECTED_BRING_EMAIL_REFERENCE: '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/bring-email/version)',
  EXPECTED_BRING_PASSWORD_REFERENCE: '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/bring-password/version)',
  EXPECTED_BRING_CONFIRMATION_HMAC_KEY_REFERENCE:
    '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/bring-confirmation-hmac-key/version)',
  EXPECTED_BRING_MUTATION_ENCRYPTION_KEY_REFERENCE:
    '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/bring-mutation-encryption-key/version)',
  EXPECTED_OPENAI_API_KEY_REFERENCE: '@Microsoft.KeyVault(SecretUri=https://vault.test/secrets/openai-api-key/version)',
};

test('deployed runtime policy accepts the complete managed key set without reading secret values', () => {
  const settings = buildExpectedRuntimeSettings(runtimeSettingsEnv);
  const names = [...requiredManagedSettingNames, optionalReleaseSettingNames[0]];
  assert.deepEqual(validateDeployedRuntimeSettings(settings, names, runtimeSettingsEnv), []);
  const properties = Object.fromEntries(names.map((name) => [name, 'secret-value-not-reported']));
  Object.assign(properties, settings);
  assert.deepEqual(validateArmRuntimeSettingsResponse({ properties }, runtimeSettingsEnv), []);
  assert.equal(settings.OPENAI_API_KEY, runtimeSettingsEnv.EXPECTED_OPENAI_API_KEY_REFERENCE);
  assert.equal(settings.REDDIT_CLIENT_SECRET, runtimeSettingsEnv.EXPECTED_REDDIT_CLIENT_SECRET_REFERENCE);
});

test('deployed runtime policy rejects security drift, missing managed keys, and unmanaged settings', () => {
  const settings = {
    ...buildExpectedRuntimeSettings(runtimeSettingsEnv),
    OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'unexpected-client',
  };
  const names = [
    ...requiredManagedSettingNames.filter((name) => name !== 'BRING_WRITABLE_LIST_UUIDS'),
    'UNMANAGED_SECURITY_OVERRIDE',
  ];
  const errors = validateDeployedRuntimeSettings(settings, names, runtimeSettingsEnv);
  assert.ok(errors.some((error) => error.endsWith('BRING_WRITABLE_LIST_UUIDS')));
  assert.ok(errors.some((error) => error.endsWith('UNMANAGED_SECURITY_OVERRIDE')));
  assert.ok(errors.some((error) => error.endsWith('OIDC_ALLOWED_DELEGATED_CLIENT_IDS')));
});

test('deployed runtime policy rejects plaintext, wrong-version, and wrong-observability managed values', () => {
  const properties = buildExpectedRuntimeSettings(runtimeSettingsEnv);
  properties.APPLICATIONINSIGHTS_CONNECTION_STRING = 'InstrumentationKey=wrong-component';
  properties.REDDIT_CLIENT_SECRET = 'plaintext-secret';
  properties.OPENAI_API_KEY = '@Microsoft.KeyVault(SecretUri=https://other.test/secrets/openai-api-key/version)';

  const errors = validateArmRuntimeSettingsResponse({ properties }, runtimeSettingsEnv);
  assert.ok(errors.some((error) => error.endsWith('APPLICATIONINSIGHTS_CONNECTION_STRING')));
  assert.ok(errors.some((error) => error.endsWith('REDDIT_CLIENT_SECRET')));
  assert.ok(errors.some((error) => error.endsWith('OPENAI_API_KEY')));
});

test('deployed runtime policy requires expected metadata and enforces an empty disabled OpenAI setting', () => {
  const disabledSettings = buildExpectedRuntimeSettings({
    ...runtimeSettingsEnv,
    REPAIRABLE_ERRORS_LLM_ENABLED: 'false',
  });
  assert.equal(disabledSettings.OPENAI_API_KEY, '');

  const incompleteEnv = { ...runtimeSettingsEnv };
  delete incompleteEnv.EXPECTED_BRING_PASSWORD_REFERENCE;
  assert.throws(() => buildExpectedRuntimeSettings(incompleteEnv), /EXPECTED_BRING_PASSWORD_REFERENCE is required/);

  const missingDelegatedClientAllowlist = { ...runtimeSettingsEnv };
  delete missingDelegatedClientAllowlist.OIDC_ALLOWED_DELEGATED_CLIENT_IDS;
  assert.throws(
    () => buildExpectedRuntimeSettings(missingDelegatedClientAllowlist),
    /OIDC_ALLOWED_DELEGATED_CLIENT_IDS is required/,
  );
});

test('telemetry KQL sanitizes smoke run IDs', () => {
  assert.equal(sanitizeTelemetrySmokeRunId("smoke-prod'; drop table"), 'smoke-prod-drop-table');
  const query = buildTelemetryQuery({ timespanMinutes: 45, smokeRunId: "smoke-prod'; drop" });
  assert.ok(query.includes("let smokeRunId = 'smoke-prod-drop';"));
  assert.ok(query.includes('smokeTraceCount'));
  assert.ok(query.includes('smokeRequestCount'));
});

test('telemetry parser reads Azure Monitor output by column name', () => {
  const parsed = parseAzureMonitorQueryResult({
    tables: [
      {
        columns: [
          { name: 'smokeEvidenceCount' },
          { name: 'failedRequests' },
          { name: 'exceptions' },
          { name: 'http5xx' },
          { name: 'smokeTraceCount' },
          { name: 'smokeRequestCount' },
        ],
        rows: [[3, 0, 0, 0, 1, 2]],
      },
    ],
  });
  assert.deepEqual(parsed, {
    exceptions: 0,
    http5xx: 0,
    failedRequests: 0,
    smokeTraceCount: 1,
    smokeRequestCount: 2,
    smokeEvidenceCount: 3,
  });
});

test('telemetry decision passes with clean checks and smoke evidence', () => {
  const decision = telemetryDecision({
    environmentName: 'prod',
    failClosed: true,
    requireSmokeCorrelation: true,
    smokeRunId: 'smoke-prod',
    checks: { smokeEvidenceCount: 1 },
  });
  assert.equal(decision.status, 'passed');
});

test('telemetry decision fails when prod requires missing smoke correlation', () => {
  const decision = telemetryDecision({
    environmentName: 'prod',
    failClosed: true,
    requireSmokeCorrelation: true,
    smokeRunId: 'smoke-prod',
    checks: { smokeEvidenceCount: 0 },
  });
  assert.equal(decision.status, 'failed');
  assert.equal(decision.exitCode, 1);
});

test('telemetry decision fails for runtime errors', () => {
  for (const checks of [{ exceptions: 1 }, { http5xx: 1 }, { failedRequests: 1 }]) {
    assert.equal(telemetryDecision({ environmentName: 'prod', checks }).status, 'failed');
  }
});

test('telemetry decision blocks when query config is missing', () => {
  const decision = telemetryDecision({
    environmentName: 'prod',
    querySucceeded: false,
    blockedReason: 'Application Insights identifier is not configured.',
  });
  assert.equal(decision.status, 'blocked_telemetry');
  assert.equal(decision.exitCode, 2);
});

test('telemetry retry is limited to transient query or missing required smoke evidence', () => {
  assert.equal(
    shouldRetryTelemetry({
      decision: { checks: { smokeEvidenceCount: 0 } },
      smokeRunId: 'smoke',
      requireSmokeCorrelation: true,
      attempt: 1,
      maxAttempts: 2,
      querySucceeded: true,
    }),
    true,
  );
  assert.equal(
    shouldRetryTelemetry({
      decision: { checks: { smokeEvidenceCount: 1 } },
      smokeRunId: 'smoke',
      requireSmokeCorrelation: true,
      attempt: 1,
      maxAttempts: 2,
      querySucceeded: true,
    }),
    false,
  );
  assert.equal(
    shouldRetryTelemetry({
      decision: {},
      smokeRunId: 'smoke',
      requireSmokeCorrelation: true,
      attempt: 2,
      maxAttempts: 2,
      querySucceeded: false,
    }),
    false,
  );
});

test('runtime truth decision verifies live health and ledger match', () => {
  const decision = decideRuntimeTruth({
    live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } },
    ledger,
    options: { includeLedger: true, environment: 'prod', expectedSha: sha },
    ledgerErrors: [],
  });
  assert.equal(decision.status, 'verified');
  assert.equal(summarizeLedger(ledger).smokeResultsStatus, 'passed');
});

test('runtime truth decision detects live health mismatch', () => {
  const decision = decideRuntimeTruth({
    live: {
      status: 'passed',
      runtime: { environmentName: 'prod', deployedCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    },
    ledger,
    options: { includeLedger: true, environment: 'prod', expectedSha: sha },
    ledgerErrors: [],
  });
  assert.equal(decision.status, 'failed');
});

test('runtime truth decision rejects a ledger from another dispatch correlation', () => {
  const decision = decideRuntimeTruth({
    live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } },
    ledger,
    options: {
      includeLedger: true,
      environment: 'prod',
      expectedSha: sha,
      expectedDeliveryCorrelation: 'delivery-other123',
    },
    ledgerErrors: [],
  });
  assert.equal(decision.status, 'failed');
});

test('runtime truth decision rejects a ledger from another workflow run', () => {
  const decision = decideRuntimeTruth({
    live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } },
    ledger,
    options: {
      includeLedger: true,
      environment: 'prod',
      expectedSha: sha,
      expectedDeliveryCorrelation: ledger.deliveryCorrelation,
      runId: '456',
    },
    ledgerErrors: [],
  });
  assert.equal(decision.status, 'failed');
});

test('runtime truth validates exact deployment workflow run metadata', () => {
  const options = {
    runId: ledger.workflowRunId,
    repo: 'JueZ/api',
    workflow: 'delivery-v2.yml',
    expectedSha: sha,
    expectedDeliveryCorrelation: ledger.deliveryCorrelation,
  };
  const run = {
    id: Number(ledger.workflowRunId),
    repository: { full_name: 'JueZ/api' },
    path: '.github/workflows/delivery-v2.yml',
    name: `Delivery v2 ${sha}`,
    event: 'push',
    run_attempt: 1,
    conclusion: 'success',
    head_branch: 'main',
    head_sha: sha,
    display_title: `Delivery v2 ${sha}`,
  };
  assert.deepEqual(validateWorkflowRunMetadata(run, options), []);
  assert.deepEqual(validateWorkflowRunMetadata({ ...run, name: 'Delivery v2' }, options), []);
  assert.ok(validateWorkflowRunMetadata({ ...run, head_sha: 'b'.repeat(40) }, options).length > 0);
  assert.ok(validateWorkflowRunMetadata({ ...run, name: 'unrelated workflow' }, options).length > 0);
  assert.ok(validateWorkflowRunMetadata({ ...run, display_title: 'Delivery v2' }, options).length > 0);
  assert.ok(validateWorkflowRunMetadata({ ...run, run_attempt: 2 }, options).length > 0);
});

test('runtime truth decision blocks when ledger evidence is missing', () => {
  const decision = decideRuntimeTruth({
    live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } },
    ledger: null,
    options: { includeLedger: true, environment: 'prod', expectedSha: sha },
    ledgerErrors: [],
  });
  assert.equal(decision.status, 'blocked');
});

test('runtime truth decision detects live and ledger SHA mismatch', () => {
  const decision = decideRuntimeTruth({
    live: { status: 'passed', runtime: { environmentName: 'prod', deployedCommitSha: sha } },
    ledger: { ...ledger, deployedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    options: { includeLedger: true, environment: 'prod', expectedSha: '' },
    ledgerErrors: [],
  });
  assert.equal(decision.status, 'failed');
});
