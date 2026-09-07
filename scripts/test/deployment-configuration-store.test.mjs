import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptOptionalConfiguration,
  captureDeploymentConfiguration,
  readAcceptedConfiguration,
} from '../deployment-configuration-store.mjs';
import {
  configurationPointer,
  createDeploymentConfiguration,
  decideApplicationOnly,
} from '../deployment-configuration.mjs';
import { buildExpectedRuntimeSettings } from '../validate-deployed-runtime-settings.mjs';

const subscriptionId = '11111111-2222-3333-4444-555555555555';
const resourceGroup = 'rg-api-prod';
const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;
const functionAppId = `${scope}/Microsoft.Web/sites/api-prod`;
const planId = `${scope}/Microsoft.Web/serverfarms/api-prod-plan`;
const origin = {
  sourceRef: 'a'.repeat(40),
  controllerRef: 'b'.repeat(40),
  runId: '12345',
  correlation: 'delivery-12345',
};
const target = {
  subscriptionId,
  resourceGroup,
  environment: 'prod',
  functionAppId,
  releaseStorageAccount: 'releaseaccount',
};

const secretSpecs = [
  ['reddit-client-secret', 'EXPECTED_REDDIT_CLIENT_SECRET_REFERENCE'],
  ['wlh-base-url', 'EXPECTED_WLH_BASE_URL_REFERENCE'],
  ['bring-client-api-key', 'EXPECTED_BRING_CLIENT_API_KEY_REFERENCE'],
  ['bring-email', 'EXPECTED_BRING_EMAIL_REFERENCE'],
  ['bring-password', 'EXPECTED_BRING_PASSWORD_REFERENCE'],
  ['bring-confirmation-hmac-key', 'EXPECTED_BRING_CONFIRMATION_HMAC_KEY_REFERENCE'],
  ['bring-mutation-encryption-key', 'EXPECTED_BRING_MUTATION_ENCRYPTION_KEY_REFERENCE'],
];

test('optional evidence failure preserves a full release but cannot accept application-only drift', async () => {
  const failure = async () => {
    throw new Error('private credential-shaped details');
  };
  assert.deepEqual(await acceptOptionalConfiguration('full', failure), {
    status: 'configuration-unavailable',
    nextDeployment: 'full',
  });
  await assert.rejects(
    acceptOptionalConfiguration('application-only', failure),
    /Application-only configuration acceptance failed/,
  );
  await assert.rejects(acceptOptionalConfiguration('unknown', failure));
  let invoked = false;
  await assert.rejects(
    acceptOptionalConfiguration('unknown', async () => {
      invoked = true;
    }),
  );
  assert.equal(invoked, false);
  const accepted = { status: 'configuration-recorded' };
  assert.equal(await acceptOptionalConfiguration('application-only', async () => accepted), accepted);
});

test('CLI skips disabled qualification before inputs or authentication and bounds optional full acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'configuration-optional-'));
  const script = fileURLToPath(new URL('../deployment-configuration-store.mjs', import.meta.url));
  const env = {
    ...process.env,
    ENVIRONMENT_NAME: 'prod',
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'JueZ/api',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'JueZ/api/.github/workflows/delivery-v2.yml@refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, 'outputs'),
    APPLICATION_ONLY_DEPLOYMENT_ENABLED: 'false',
    APPLICATION_ONLY_SHADOW_MEASURE: 'false',
    RECONCILE_CONFIGURATION: 'false',
  };
  const run = (command, overrides = {}) =>
    spawnSync(process.execPath, [script, command], {
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    const disabled = run('decide');
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout).mode, 'full');
    assert.equal(
      JSON.parse(await readFile(join(directory, 'deployment-configuration-decision.json'), 'utf8')).eligibleMode,
      null,
    );
    assert.equal(JSON.parse(run('accept').stdout).status, 'configuration-disabled');
    // Enabling qualification with unavailable private input must be absorbed only
    // by full-mode optional acceptance; no token or Azure call is needed here.
    const full = run('accept', { APPLICATION_ONLY_DEPLOYMENT_ENABLED: 'true' });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).status, 'configuration-unavailable');
    await writeFile(
      join(directory, 'deployment-configuration-decision.json'),
      JSON.stringify({ mode: 'application-only' }),
    );
    const required = run('accept', { APPLICATION_ONLY_DEPLOYMENT_ENABLED: 'true' });
    assert.equal(required.status, 1);
    await assert.rejects(readFile(join(directory, 'deployment-configuration-pointer.json')), { code: 'ENOENT' });
    assert.equal(run('accept', { GITHUB_ACTIONS: 'false' }).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function acceptedRecordFixture() {
  const secretVersion = 'https://api-vault.vault.azure.net/secrets/bring-password/11111111111111111111111111111111';
  const retentionPolicy = { rules: [{ name: 'retain-accepted', enabled: true, type: 'Lifecycle' }] };
  const observed = {
    site: {
      identity: { principalId: 'principal-id', tenantId: 'tenant-id' },
      hostingPlan: {
        id: planId,
        kind: 'functionapp',
        location: 'westeurope',
        sku: { name: 'Y1', tier: 'Dynamic' },
      },
    },
    web: { linuxFxVersion: 'NODE|22' },
    managedSettings: { BRING_PASSWORD: `@Microsoft.KeyVault(SecretUri=${secretVersion})` },
    secrets: [{ name: 'bring-password', versionUri: secretVersion, attributes: { enabled: true } }],
    roles: {},
    retentionPolicy,
  };
  const record = createDeploymentConfiguration({
    parameters: {
      suppliedSecret: { value: 'private-secret' },
      releaseRetentionPolicy: { value: retentionPolicy },
    },
    compiledTemplate: Buffer.from('{"template":"compiled"}\n'),
    toolchain: { nodeMajor: 22, azureCli: '2.76.0', bicep: '0.38.5' },
    target,
    origin,
    inventory: [
      { id: functionAppId, type: 'Microsoft.Web/sites' },
      { id: planId, type: 'Microsoft.Web/serverfarms' },
    ],
    observed,
  });
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const pointer = configurationPointer({
    target,
    origin,
    versionId: '2026-09-07T12:00:00.0000000Z',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  });
  const baseline = {
    status: 'accepted',
    acceptanceKind: 'promotion',
    sourceRef: origin.sourceRef,
    acceptanceRunId: origin.runId,
    acceptanceCorrelation: origin.correlation,
    identity: { mutationReceipt: { controllerRef: origin.controllerRef } },
    configurationBaseline: pointer,
  };
  return { baseline, bytes, pointer, record };
}

function storageFixture(bytes, contentLength = bytes.byteLength) {
  const calls = [];
  const storage = {
    getBlobClient(blob) {
      calls.push(['blob', blob]);
      return {
        withVersion(versionId) {
          calls.push(['version', versionId]);
          return {
            async getProperties() {
              calls.push(['properties']);
              return { contentLength };
            },
            async downloadToBuffer(offset, count) {
              calls.push(['download', offset, count]);
              return bytes;
            },
          };
        },
      };
    },
  };
  return { storage, calls };
}

test('accepted configuration reads the exact trusted blob version, size, and digest before parsing', async () => {
  const current = acceptedRecordFixture();
  const { storage, calls } = storageFixture(current.bytes);

  const record = await readAcceptedConfiguration({ baseline: current.baseline, target, storage });

  assert.deepEqual(record, current.record);
  assert.deepEqual(calls, [
    ['blob', current.pointer.blob],
    ['version', current.pointer.versionId],
    ['properties'],
    ['download', 0, current.pointer.size],
  ]);
});

test('accepted configuration rejects foreign account, origin, or version before storage access', async (t) => {
  const cases = [
    ['account', (pointer) => Object.assign(pointer, { account: 'foreignaccount' })],
    [
      'origin',
      (pointer) =>
        Object.assign(pointer, {
          blob: `accepted/${'c'.repeat(40)}/999/1/promotion/deployment-configuration.json`,
        }),
    ],
    ['version', (pointer) => Object.assign(pointer, { versionId: '' })],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const current = acceptedRecordFixture();
      mutate(current.baseline.configurationBaseline);
      const { storage, calls } = storageFixture(current.bytes);
      await assert.rejects(
        readAcceptedConfiguration({ baseline: current.baseline, target, storage }),
        /Accepted configuration pointer is unavailable/,
      );
      assert.deepEqual(calls, []);
    });
  }
});

test('accepted configuration checks byte length before download and digest before JSON parsing', async (t) => {
  await t.test('size mismatch', async () => {
    const current = acceptedRecordFixture();
    const { storage, calls } = storageFixture(current.bytes, current.bytes.byteLength + 1);
    await assert.rejects(
      readAcceptedConfiguration({ baseline: current.baseline, target, storage }),
      /Private configuration size differs from accepted evidence/,
    );
    assert.equal(
      calls.some(([kind]) => kind === 'download'),
      false,
    );
  });

  await t.test('digest mismatch on malformed JSON', async () => {
    const current = acceptedRecordFixture();
    const changedBytes = Buffer.from(current.bytes);
    changedBytes[0] = '['.charCodeAt(0);
    const { storage } = storageFixture(changedBytes);
    await assert.rejects(
      readAcceptedConfiguration({ baseline: current.baseline, target, storage }),
      /Private configuration byte binding failed/,
    );
  });
});

function captureFixture(mutate = () => {}) {
  const functionName = 'api-prod';
  const roleId = `${scope}/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
  const vaultId = `${scope}/Microsoft.KeyVault/vaults/api-vault`;
  const retentionId = `${scope}/Microsoft.Storage/storageAccounts/releaseaccount/managementPolicies/default`;
  const applicationInsightsId = `${scope}/Microsoft.Insights/components/api-prod-insights`;
  const secretUris = Object.fromEntries(
    secretSpecs.map(([name], index) => [
      name,
      `https://api-vault.vault.azure.net/secrets/${name}/${(index + 1).toString(16).padStart(32, '0')}`,
    ]),
  );
  const env = {
    ENVIRONMENT_NAME: 'prod',
    AZURE_SUBSCRIPTION_ID: subscriptionId,
    AZURE_RESOURCE_GROUP: resourceGroup,
    AZURE_FUNCTIONAPP_NAME: functionName,
    WEB_AUTH_REDIRECT_URI: 'https://app.example.test/auth/callback',
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
    REDDIT_USER_AGENT: 'catalogue-prod',
    WEATHER_ENABLED: 'false',
    YOUTUBE_TRANSCRIPT_ENABLED: 'false',
    REPAIRABLE_ERRORS_LLM_ENABLED: 'false',
    ...Object.fromEntries(
      secretSpecs.map(([name, variable]) => [variable, `@Microsoft.KeyVault(SecretUri=${secretUris[name]})`]),
    ),
  };
  const settingsEnv = {
    ...env,
    EFFECTIVE_HOST_STORAGE_ACCOUNT: 'hoststore',
    EFFECTIVE_PRIVATE_STORAGE_ACCOUNT: 'privatestore',
    EXPECTED_APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=metadata-only',
  };
  const resources = {
    deployment: {
      properties: {
        provisioningState: 'Succeeded',
        mode: 'Incremental',
        outputs: {
          functionAppResourceName: { value: functionName },
          releaseStorageAccountResourceName: { value: 'releaseaccount' },
          applicationInsightsResourceName: { value: 'api-prod-insights' },
          keyVaultResourceName: { value: 'api-vault' },
          hostStorageAccountResourceName: { value: 'hoststore' },
          privateStorageAccountResourceName: { value: 'privatestore' },
        },
        outputResources: [
          { id: functionAppId, resourceType: 'Microsoft.Web/sites' },
          { id: planId, resourceType: 'Microsoft.Web/serverfarms' },
          { id: `${functionAppId}/config/appsettings`, resourceType: 'Microsoft.Web/sites/config' },
          { id: roleId, resourceType: 'Microsoft.Authorization/roleAssignments' },
          { id: retentionId, resourceType: 'Microsoft.Storage/storageAccounts/managementPolicies' },
        ],
      },
    },
    site: {
      id: functionAppId,
      kind: 'functionapp,linux',
      location: 'westeurope',
      identity: {
        type: 'SystemAssigned',
        principalId: '10000000-0000-0000-0000-000000000001',
        tenantId: '20000000-0000-0000-0000-000000000002',
      },
      properties: { serverFarmId: planId, httpsOnly: true, publicNetworkAccess: 'Enabled' },
    },
    plan: {
      id: planId,
      kind: 'functionapp',
      location: 'westeurope',
      sku: { name: 'Y1', tier: 'Dynamic' },
    },
    web: {
      properties: {
        linuxFxVersion: 'NODE|22',
        minTlsVersion: '1.2',
        ftpsState: 'Disabled',
        http20Enabled: true,
        minimumElasticInstanceCount: 1,
        cors: { supportCredentials: false, allowedOrigins: ['https://app.example.test'] },
      },
    },
    settings: { properties: buildExpectedRuntimeSettings(settingsEnv) },
    insights: { properties: { ConnectionString: settingsEnv.EXPECTED_APPLICATIONINSIGHTS_CONNECTION_STRING } },
    retention: {
      properties: {
        policy: {
          rules: [
            {
              name: 'expire-retired-0-0',
              enabled: true,
              type: 'Lifecycle',
              definition: {
                actions: { version: { delete: { daysAfterCreationGreaterThan: 30 } } },
                filters: { blobTypes: ['blockBlob'], prefixMatch: ['function-releases/functionapp-00'] },
              },
            },
          ],
        },
      },
    },
    role: {
      properties: {
        scope: functionAppId,
        roleDefinitionId: `${scope}/Microsoft.Authorization/roleDefinitions/ffffffff-ffff-ffff-ffff-ffffffffffff`,
        principalId: '10000000-0000-0000-0000-000000000001',
        principalType: 'ServicePrincipal',
      },
    },
    secrets: Object.fromEntries(
      secretSpecs.map(([name]) => [
        name,
        { properties: { secretUriWithVersion: secretUris[name], attributes: { enabled: true } } },
      ]),
    ),
  };
  mutate({ env, resources, ids: { roleId, retentionId }, secretUris });

  const routes = new Map([
    [`GET ${scope}/Microsoft.Resources/deployments/main-prod`, resources.deployment],
    [`GET ${functionAppId}`, resources.site],
    [`GET ${planId}`, resources.plan],
    [`GET ${functionAppId}/config/web`, resources.web],
    [`POST ${functionAppId}/config/appsettings/list`, resources.settings],
    [`GET ${applicationInsightsId}`, resources.insights],
    [`GET ${retentionId}`, resources.retention],
    [`GET ${roleId}`, resources.role],
    ...secretSpecs.map(([name]) => [`GET ${vaultId}/secrets/${name}`, resources.secrets[name]]),
  ]);
  const calls = [];
  const readArm = async (id, apiVersion, method = 'GET', body) => {
    calls.push({ id, apiVersion, method, body });
    const response = routes.get(`${method} ${id}`);
    if (!response) throw new Error(`Unexpected ARM fixture read: ${method} ${id}`);
    return structuredClone(response);
  };
  return { env, readArm, calls, resources, ids: { roleId, retentionId }, secretUris };
}

test('capture records complete policy, identity, expected roles, and secret metadata without Azure access', async () => {
  const current = captureFixture();
  const captured = await captureDeploymentConfiguration(current);

  assert.deepEqual(captured.observed.retentionPolicy, current.resources.retention.properties.policy);
  assert.deepEqual(captured.observed.site.identity, current.resources.site.identity);
  assert.deepEqual(captured.observed.site.hostingPlan, current.resources.plan);
  assert.deepEqual(captured.observed.roles[current.ids.roleId.toLowerCase()], {
    ...current.resources.role.properties,
    condition: null,
    conditionVersion: null,
    delegatedManagedIdentityResourceId: null,
  });
  assert.equal(captured.observed.web.minimumElasticInstanceCount, 1);
  assert.deepEqual(
    captured.observed.secrets.map((secret) => secret.name),
    secretSpecs.map(([name]) => name).sort(),
  );
  assert.ok(
    captured.observed.secrets.every(
      (secret) =>
        secret.attributes.enabled === true && secret.attributes.nbf === null && secret.attributes.exp === null,
    ),
  );
  assert.ok(current.calls.every((call) => call.apiVersion && call.id.startsWith(`/subscriptions/${subscriptionId}/`)));
  assert.deepEqual(
    current.calls.find((call) => call.id.endsWith('/config/appsettings/list')),
    {
      id: `${functionAppId}/config/appsettings/list`,
      apiVersion: '2023-12-01',
      method: 'POST',
      body: {},
    },
  );
  assert.deepEqual(
    current.calls.find((call) => call.id === planId),
    { id: planId, apiVersion: '2023-12-01', method: 'GET', body: undefined },
  );
});

test('strict Dynamic Y1 capture preserves either observed minimum-elastic raw value', async (t) => {
  for (const minimumElasticInstanceCount of [0, 1]) {
    await t.test(String(minimumElasticInstanceCount), async () => {
      const current = captureFixture(({ resources }) => {
        resources.web.properties.minimumElasticInstanceCount = minimumElasticInstanceCount;
      });
      const captured = await captureDeploymentConfiguration(current);
      assert.deepEqual(captured.observed.site.hostingPlan.sku, { name: 'Y1', tier: 'Dynamic' });
      assert.equal(captured.observed.web.minimumElasticInstanceCount, minimumElasticInstanceCount);
    });
  }
});

test('minimum-elastic raw observation changes still select full reconciliation against the accepted baseline', async () => {
  const accepted = await captureDeploymentConfiguration(
    captureFixture(({ resources }) => {
      resources.web.properties.minimumElasticInstanceCount = 0;
    }),
  );
  const live = await captureDeploymentConfiguration(captureFixture());
  const parameters = { releaseRetentionPolicy: { value: accepted.observed.retentionPolicy } };
  const compiledTemplate = Buffer.from('{"template":"compiled"}\n');
  const toolchain = { nodeMajor: 22, azureCli: '2.76.0', bicep: '0.38.5' };
  const record = createDeploymentConfiguration({
    parameters,
    compiledTemplate,
    toolchain,
    target: accepted.target,
    origin,
    inventory: accepted.inventory,
    observed: accepted.observed,
  });
  const whatIf = {
    status: 'Succeeded',
    changes: record.inventory.map((resource) => ({ resourceId: resource.id, changeType: 'NoChange' })),
  };

  const decision = decideApplicationOnly({
    record,
    parameters,
    compiledTemplate,
    toolchain,
    target: live.target,
    observed: live.observed,
    whatIf,
  });
  assert.equal(decision.mode, 'full');
  assert.ok(decision.reasons.includes('Installed configuration or identity drifted from accepted state.'));
});

test('capture rejects disabled, expired, or incomplete secret metadata', async (t) => {
  const cases = [
    [
      'disabled secret',
      ({ resources }) => {
        resources.secrets['bring-password'].properties.attributes.enabled = false;
      },
    ],
    [
      'expired secret',
      ({ resources }) => {
        resources.secrets['bring-password'].properties.attributes.exp = 1;
      },
    ],
    [
      'missing enabled state',
      ({ resources }) => {
        delete resources.secrets['bring-password'].properties.attributes.enabled;
      },
    ],
    [
      'missing version URI',
      ({ resources }) => {
        delete resources.secrets['bring-password'].properties.secretUriWithVersion;
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      await assert.rejects(captureDeploymentConfiguration(captureFixture(mutate)));
    });
  }
});

test('capture rejects incomplete retention, identity, role, and web policy fields', async (t) => {
  const cases = [
    [
      'missing retention policy',
      ({ resources }) => {
        delete resources.retention.properties.policy;
      },
    ],
    [
      'retention policy without rules',
      ({ resources }) => {
        resources.retention.properties.policy = {};
      },
    ],
    [
      'managed identity',
      ({ resources }) => {
        delete resources.site.identity.tenantId;
      },
    ],
    [
      'missing plan SKU tier',
      ({ resources }) => {
        delete resources.plan.sku.tier;
      },
    ],
    [
      'non-Dynamic plan tier',
      ({ resources }) => {
        resources.plan.sku.tier = 'ElasticPremium';
      },
    ],
    [
      'non-Y1 plan name',
      ({ resources }) => {
        resources.plan.sku.name = 'EP1';
      },
    ],
    [
      'role assignment',
      ({ resources }) => {
        delete resources.role.properties.principalId;
      },
    ],
    [
      'web policy',
      ({ resources }) => {
        delete resources.web.properties.http20Enabled;
      },
    ],
    [
      'non-integer minimum elastic observation',
      ({ resources }) => {
        resources.web.properties.minimumElasticInstanceCount = '1';
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      await assert.rejects(captureDeploymentConfiguration(captureFixture(mutate)));
    });
  }
});
