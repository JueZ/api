import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDeploymentParameters } from '../prepare-deployment-parameters.mjs';

const script = fileURLToPath(new URL('../prepare-deployment-parameters.mjs', import.meta.url));

const environment = {
  ENVIRONMENT_NAME: 'test',
  AUTH_ENABLED: 'true',
  OIDC_ISSUER: 'https://login.example/tenant/v2.0',
  OIDC_AUDIENCE: 'api://catalogue',
  OIDC_ALLOWED_OBJECT_IDS: 'user-object-id',
  OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'delegated-client-id',
  OIDC_ALLOWED_TENANTS: 'tenant-id',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example',
  MCP_ALLOWED_ORIGINS: 'https://chat.example',
  AZURE_DEPLOYMENT_PRINCIPAL_OBJECT_ID: 'deployment-object-id',
  OPERATOR_ALERT_EMAIL: 'operator@example.com',
  TEST_WEB_AUTH_REDIRECT_URI: 'https://web.example/auth/callback?ignored=true',
  REDDIT_CLIENT_ID: 'reddit-client',
  REDDIT_CLIENT_SECRET: 'reddit-secret',
  REDDIT_USER_AGENT: 'catalogue/1.0',
  WLH_BASE_URL: 'https://private-wlh.example',
  GOOGLE_WEATHER_API_KEY: 'weather-key',
  SUPADATA_API_KEY: 'supadata-key',
  YOUTUBE_TRANSCRIPT_CURSOR_HMAC_KEY: 'youtube-cursor-key',
  BRING_ENABLED: 'false',
  BRING_ADD_ENABLED: 'false',
  BRING_DESTRUCTIVE_ENABLED: 'false',
  BRING_CLIENT_API_KEY: 'bring-key',
  BRING_EMAIL: 'bring@example.com',
  BRING_PASSWORD: 'bring-password',
  BRING_CONFIRMATION_HMAC_KEY: 'confirmation-key',
  BRING_MUTATION_ENCRYPTION_KEY: 'mutation-key',
  BRING_EXPECTED_ACCOUNT_FINGERPRINT: 'account-fingerprint',
  BRING_READABLE_LIST_UUIDS: 'readable-list',
  OPENAI_API_KEY: 'openai-key',
};

const privateConfig = {
  budgetStartDate: '2026-09-01T00:00:00Z',
  releaseRetentionPolicy: { rules: [{ name: 'retention', enabled: true }] },
};

const parameterNames = [
  'location',
  'environmentName',
  'workloadName',
  'authEnabled',
  'oidcIssuer',
  'oidcAudience',
  'oidcJwksUri',
  'oidcRequiredScopes',
  'oidcAllowedObjectIds',
  'oidcAllowedSubjects',
  'oidcAllowedAppObjectIds',
  'oidcAllowedClientIds',
  'oidcAllowedDelegatedClientIds',
  'oidcAllowedTenants',
  'authDebug',
  'apiCorsAllowedOrigins',
  'mcpResourceOrigin',
  'mcpAllowedOrigins',
  'deploymentPrincipalObjectId',
  'releaseRetentionPolicy',
  'operatorAlertEmail',
  'monthlyBudgetEur',
  'budgetStartDate',
  'redditClientId',
  'redditOAuthSecret',
  'redditUserAgent',
  'redditSnapshotContainer',
  'redditSnapshotTtlSeconds',
  'redditSnapshotMaxComments',
  'redditSnapshotMaxBytes',
  'youtubeTranscriptEnabled',
  'supadataApiKey',
  'youtubeTranscriptCursorHmacKey',
  'youtubeTranscriptContainer',
  'youtubeTranscriptCacheTtlSeconds',
  'wlhBaseUrl',
  'wlhCategoryBlobContainer',
  'wlhCategoryBlobName',
  'weatherEnabled',
  'googleWeatherApiKey',
  'bringEnabled',
  'bringAddEnabled',
  'bringDestructiveEnabled',
  'bringBaseUrl',
  'bringClientApiKey',
  'bringCountry',
  'bringEmail',
  'bringPassword',
  'bringExpectedAccountFingerprint',
  'bringConnectionGrants',
  'bringDefaultListUuid',
  'bringReadableListUuids',
  'bringWritableListUuids',
  'bringWritableSharedListUuids',
  'bringSessionCacheEnabled',
  'bringSessionCacheContainer',
  'bringSessionCacheBlob',
  'bringMutationContainer',
  'bringAuditContainer',
  'bringConfirmationHmacKey',
  'bringMutationEncryptionKey',
  'openAiCredential',
  'repairableErrorsLlmEnabled',
  'repairableErrorsLlmModel',
];

const compiledLiteralDefaults = {
  location: 'westeurope',
  workloadName: 'api-catalogue',
  redditSnapshotContainer: 'reddit-snapshots',
  redditSnapshotTtlSeconds: 86400,
  redditSnapshotMaxComments: 100000,
  redditSnapshotMaxBytes: 100663296,
  youtubeTranscriptContainer: 'youtube-transcripts',
  youtubeTranscriptCacheTtlSeconds: 86400,
};

const compiledTemplate = {
  parameters: Object.fromEntries(
    parameterNames.map((name) => [
      name,
      Object.hasOwn(compiledLiteralDefaults, name)
        ? { type: 'string', defaultValue: compiledLiteralDefaults[name] }
        : { type: 'string' },
    ]),
  ),
};
compiledTemplate.parameters.monthlyBudgetEur = {
  type: 'int',
  defaultValue: "[if(equals(parameters('environmentName'), 'prod'), 15, 10)]",
};
compiledTemplate.parameters.budgetStartDate = {
  type: 'string',
  defaultValue: "[utcNow('yyyy-MM-01T00:00:00Z')]",
};

test('compiled template metadata drives complete parameter coverage and literal defaults', () => {
  const extendedTemplate = structuredClone(compiledTemplate);
  extendedTemplate.parameters.futureLiteralDefault = { type: 'int', defaultValue: 7 };
  const result = buildDeploymentParameters(environment, privateConfig, extendedTemplate);

  assert.deepEqual(Object.keys(result), ['parameters']);
  assert.deepEqual(Object.keys(result.parameters), [...parameterNames, 'futureLiteralDefault']);
  assert.equal(result.parameters.futureLiteralDefault.value, 7);
  for (const entry of Object.values(result.parameters)) {
    assert.deepEqual(Object.keys(entry), ['value']);
    assert.notEqual(entry.value, undefined);
  }

  const requiredDrift = structuredClone(compiledTemplate);
  requiredDrift.parameters.futureRequired = { type: 'string' };
  assert.throws(
    () => buildDeploymentParameters(environment, privateConfig, requiredDrift),
    /no effective workflow value/,
  );
  const expressionDrift = structuredClone(compiledTemplate);
  expressionDrift.parameters.futureExpression = { type: 'string', defaultValue: '[resourceGroup().name]' };
  assert.throws(
    () => buildDeploymentParameters(environment, privateConfig, expressionDrift),
    /no effective workflow value/,
  );
});

test('preserves exact workflow booleans, integers, overrides, and compiled literal defaults', () => {
  const { parameters } = buildDeploymentParameters(environment, privateConfig, compiledTemplate);
  const value = (name) => parameters[name].value;
  const grants = JSON.stringify({
    schemaVersion: 1,
    grants: [
      { connectionId: 'operator', principal: { tokenType: 'user', tenantId: 'tenant', objectId: 'operator-id' } },
    ],
  });
  const configured = buildDeploymentParameters(
    { ...environment, BRING_CONNECTION_GRANTS: grants, OIDC_REQUIRED_SCOPES: 'catalogue.read,youtube.read' },
    privateConfig,
    compiledTemplate,
  );
  assert.equal(configured.parameters.bringConnectionGrants.value, grants);
  assert.equal(configured.parameters.oidcRequiredScopes.value, 'catalogue.read,youtube.read');

  assert.equal(value('authEnabled'), true);
  assert.equal(value('authDebug'), false);
  assert.equal(value('weatherEnabled'), true);
  assert.equal(value('youtubeTranscriptEnabled'), false);
  assert.equal(value('bringEnabled'), false);
  assert.equal(value('bringSessionCacheEnabled'), true);
  assert.equal(value('monthlyBudgetEur'), 10);
  assert.equal(value('redditSnapshotTtlSeconds'), 86400);
  assert.equal(value('redditSnapshotMaxComments'), 100000);
  assert.equal(value('redditSnapshotMaxBytes'), 100663296);
  assert.equal(value('youtubeTranscriptCacheTtlSeconds'), 86400);
  assert.equal(value('location'), 'westeurope');
  assert.equal(value('workloadName'), 'api-catalogue');
  assert.equal(value('redditSnapshotContainer'), 'reddit-snapshots');
  assert.equal(value('youtubeTranscriptContainer'), 'youtube-transcripts');
  assert.equal(value('bringBaseUrl'), 'https://api.getbring.com/rest/');
  assert.equal(value('bringCountry'), 'AT');
  assert.equal(value('bringSessionCacheContainer'), 'bring-private');
  assert.equal(value('bringSessionCacheBlob'), 'session-v1.json');
  assert.equal(value('bringMutationContainer'), 'bring-mutations');
  assert.equal(value('bringAuditContainer'), 'bring-audit');
  assert.equal(value('apiCorsAllowedOrigins'), 'https://web.example');
  assert.equal(
    value('oidcRequiredScopes'),
    'catalogue.read,reddit.read,youtube.read,wlh.read,weather.read,bring.read,bring.write,bring.complete,bring.remove',
  );
  assert.deepEqual(value('releaseRetentionPolicy'), privateConfig.releaseRetentionPolicy);
  assert.equal(value('budgetStartDate'), privateConfig.budgetStartDate);
  assert.equal(value('redditOAuthSecret'), environment.REDDIT_CLIENT_SECRET);
  assert.equal(value('openAiCredential'), '');

  const prod = buildDeploymentParameters(
    {
      ...environment,
      ENVIRONMENT_NAME: 'prod',
      WEB_AUTH_REDIRECT_URI: 'https://prod.example/callback',
      REPAIRABLE_ERRORS_LLM_ENABLED: 'true',
    },
    privateConfig,
    compiledTemplate,
  );
  assert.equal(prod.parameters.monthlyBudgetEur.value, 15);
  assert.equal(prod.parameters.apiCorsAllowedOrigins.value, 'https://prod.example');
  assert.equal(prod.parameters.openAiCredential.value, environment.OPENAI_API_KEY);
});

test('private config shape is exactly the two externally resolved values and no fingerprints are returned', () => {
  const first = buildDeploymentParameters({ ...environment, BRING_PASSWORD: 'one' }, privateConfig, compiledTemplate);
  const second = buildDeploymentParameters({ ...environment, BRING_PASSWORD: 'two' }, privateConfig, compiledTemplate);

  assert.deepEqual(Object.keys(first), ['parameters']);
  assert.equal(first.parameters.bringPassword.value, 'one');
  assert.equal(second.parameters.bringPassword.value, 'two');
  assert.equal('canonicalPrivateInputs' in first, false);
  assert.equal('canonicalEffectiveConfig' in first, false);
  assert.throws(
    () =>
      buildDeploymentParameters(
        environment,
        { ...privateConfig, bringPassword: 'must-not-be-configured-here' },
        compiledTemplate,
      ),
    /unsupported shape/,
  );
});

test('CLI creates one restrictive parameter file under RUNNER_TEMP and reports only sanitized status', async (context) => {
  const runnerTemp = await mkdtemp(join(tmpdir(), 'deployment-parameters-'));
  context.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const configPath = join(runnerTemp, 'private-input.json');
  await writeFile(configPath, JSON.stringify(privateConfig), { mode: 0o600 });
  await writeFile(join(runnerTemp, 'deployment-template.json'), JSON.stringify(compiledTemplate), { mode: 0o600 });
  const outputName = 'prepared.json';
  const child = spawnSync(process.execPath, [script, '--config-json', configPath, '--output', outputName], {
    encoding: 'utf8',
    env: { ...process.env, ...environment, RUNNER_TEMP: runnerTemp },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { status: 'prepared', parameters: parameterNames.length });
  for (const secret of [
    environment.REDDIT_CLIENT_SECRET,
    environment.BRING_PASSWORD,
    environment.BRING_CONFIRMATION_HMAC_KEY,
  ]) {
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, new RegExp(secret));
  }

  const outputPath = join(runnerTemp, outputName);
  const written = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(Object.keys(written), parameterNames);
  assert.equal(written.redditOAuthSecret.value, environment.REDDIT_CLIENT_SECRET);
  if (process.platform !== 'win32') assert.equal((await stat(outputPath)).mode & 0o777, 0o600);

  const second = spawnSync(process.execPath, [script, '--config-json', configPath, '--output', outputName], {
    encoding: 'utf8',
    env: { ...process.env, ...environment, RUNNER_TEMP: runnerTemp },
  });
  assert.notEqual(second.status, 0);
  assert.equal(second.stdout, '');
  assert.equal(second.stderr, 'Deployment parameter preparation failed.\n');
});

test('CLI errors never echo secret-bearing environment or invalid input', async (context) => {
  const runnerTemp = await mkdtemp(join(tmpdir(), 'deployment-parameters-error-'));
  context.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const rawSecret = 'lowentropysecret';
  const configPath = join(runnerTemp, 'private-input.json');
  await writeFile(configPath, JSON.stringify(privateConfig), { mode: 0o600 });
  await writeFile(join(runnerTemp, 'deployment-template.json'), JSON.stringify(compiledTemplate), { mode: 0o600 });
  const child = spawnSync(process.execPath, [script, '--config-json', configPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...environment,
      BRING_PASSWORD: rawSecret,
      TEST_WEB_AUTH_REDIRECT_URI: `not-a-url-${rawSecret}`,
      RUNNER_TEMP: runnerTemp,
    },
  });

  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'Deployment parameter preparation failed.\n');
  assert.doesNotMatch(`${child.stdout}${child.stderr}`, new RegExp(rawSecret));
});
