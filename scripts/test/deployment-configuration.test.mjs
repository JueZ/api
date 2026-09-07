import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  configurationPointer,
  createDeploymentConfiguration,
  decideApplicationOnly,
  validateConfigurationPointer,
  verifyDeploymentConfiguration,
} from '../deployment-configuration.mjs';

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const LOW_ENTROPY_SECRET = 'hunter2';
const SUPPLIED_PASSWORD = 'Supplied-Password-Do-Not-Persist';

function fixture() {
  const subscriptionId = '11111111-2222-3333-4444-555555555555';
  const resourceGroup = 'rg-api-prod';
  const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;
  const functionAppId = `${scope}/Microsoft.Web/sites/api-prod`;
  const planId = `${scope}/Microsoft.Web/serverfarms/api-prod-plan`;
  const secretId = `${scope}/Microsoft.KeyVault/vaults/api-vault/secrets/bring-password`;
  const roleId = `${scope}/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
  const storageId = `${scope}/Microsoft.Storage/storageAccounts/releaseaccount`;
  const budgetId = `${scope}/Microsoft.Consumption/budgets/budget-api-prod`;
  const appSettingsId = `${functionAppId}/config/appsettings`;
  const retentionId = `${storageId}/managementPolicies/default`;
  const secretVersion = 'https://api-vault.vault.azure.net/secrets/bring-password/11111111111111111111111111111111';
  const target = {
    subscriptionId,
    resourceGroup,
    environment: 'prod',
    functionAppId,
    releaseStorageAccount: 'releaseaccount',
  };
  const origin = {
    sourceRef: 'a'.repeat(40),
    controllerRef: 'b'.repeat(40),
    runId: '12345',
    correlation: 'delivery-12345',
  };
  const retentionPolicy = {
    rules: [
      {
        name: 'retire',
        enabled: true,
        type: 'Lifecycle',
        definition: {
          actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 180 } } },
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['function-releases/functionapp-00'] },
        },
      },
    ],
  };
  const parameters = {
    workloadName: { value: 'api' },
    redditClientSecret: { value: LOW_ENTROPY_SECRET },
    bringPassword: { value: SUPPLIED_PASSWORD },
    budgetAmount: { value: 15 },
    budgetStartDate: { value: '2026-08-01' },
    releaseRetentionPolicy: { value: retentionPolicy },
  };
  const observed = {
    site: {
      name: 'api-prod',
      identity: {
        principalId: '10000000-0000-0000-0000-000000000001',
        tenantId: '20000000-0000-0000-0000-000000000002',
      },
      hostingPlan: {
        id: planId,
        kind: 'functionapp',
        location: 'westeurope',
        sku: { name: 'Y1', tier: 'Dynamic' },
      },
    },
    web: {
      linuxFxVersion: 'NODE|22',
      minimumElasticInstanceCount: 1,
      netFrameworkVersion: 'v4.0',
      localMySqlEnabled: false,
      cors: { allowedOrigins: ['https://app.example.test'], supportCredentials: false },
      ftpsState: 'Disabled',
      minTlsVersion: '1.2',
    },
    managedSettings: {
      BRING_PASSWORD: `@Microsoft.KeyVault(SecretUri=${secretVersion})`,
      FEATURE_MODE: 'production',
    },
    secrets: [{ name: 'bring-password', versionUri: secretVersion, attributes: { enabled: true } }],
    roles: {
      [roleId.toLowerCase()]: {
        principalId: '10000000-0000-0000-0000-000000000001',
        principalType: 'ServicePrincipal',
      },
    },
    retentionPolicy,
    resourceSettings: {
      [budgetId.toLowerCase()]: {
        type: 'Microsoft.Consumption/budgets',
        properties: { timePeriod: { startDate: '2026-08-01T00:00:00Z', endDate: '2036-08-01T00:00:00Z' } },
      },
    },
  };
  const inventory = [
    { id: functionAppId, type: 'Microsoft.Web/sites' },
    { id: planId, type: 'Microsoft.Web/serverfarms' },
    { id: appSettingsId, type: 'Microsoft.Web/sites/config' },
    { id: secretId, type: 'Microsoft.KeyVault/vaults/secrets' },
    { id: roleId, type: 'Microsoft.Authorization/roleAssignments' },
    { id: storageId, type: 'Microsoft.Storage/storageAccounts' },
    { id: budgetId, type: 'Microsoft.Consumption/budgets' },
    { id: retentionId, type: 'Microsoft.Storage/storageAccounts/managementPolicies' },
  ];
  const compiledTemplate = Buffer.from('{"template":"compiled"}\n');
  const toolchain = { az: '2.76.0', bicep: '0.38.5' };
  const record = createDeploymentConfiguration({
    parameters,
    compiledTemplate,
    toolchain,
    target,
    origin,
    inventory,
    observed,
    now: NOW,
  });
  return {
    parameters,
    compiledTemplate,
    toolchain,
    target,
    origin,
    observed,
    record,
    ids: { functionAppId, planId, appSettingsId, secretId, roleId, storageId, budgetId, retentionId },
  };
}

function completeWhatIf(record, replacements = new Map()) {
  return {
    status: 'Succeeded',
    changes: record.inventory.map(
      (resource) => replacements.get(resource.id.toLowerCase()) ?? { resourceId: resource.id, changeType: 'NoChange' },
    ),
  };
}

function modify(resourceId, path, extra = {}) {
  return {
    resourceId,
    changeType: 'Modify',
    delta: [{ path, propertyChangeType: 'Modify' }],
    ...extra,
  };
}

function decide(state, overrides = {}) {
  return decideApplicationOnly({
    record: state.record,
    inventory: state.record.inventory,
    parameters: state.parameters,
    compiledTemplate: state.compiledTemplate,
    toolchain: state.toolchain,
    target: state.target,
    observed: state.observed,
    whatIf: completeWhatIf(state.record),
    now: NOW,
    ...overrides,
  });
}

function assertFull(decision, message) {
  assert.equal(decision.mode, 'full', message);
  assert.ok(decision.reasons.length > 0, 'full reconciliation must carry a reason');
}

// Response kinds and values from the protected Azure shadow run. Resource names,
// identities and app-setting expression contents are synthetic; no cloud payload
// or secret values are retained in the fixture.
function azureDefaultsFixture() {
  const state = fixture();
  const scope = state.ids.storageId.split('/providers/')[0] + '/providers/';
  const extras = [
    [
      'insights',
      `${scope}Microsoft.Insights/components/api-prod`,
      'Microsoft.Insights/components',
      { Flow_Type: null, Request_Source: null },
    ],
    [
      'vault',
      `${scope}Microsoft.KeyVault/vaults/api-vault`,
      'Microsoft.KeyVault/vaults',
      { networkAcls: null, publicNetworkAccess: 'Enabled' },
    ],
    [
      'blobs',
      `${state.ids.storageId}/blobServices/default`,
      'Microsoft.Storage/storageAccounts/blobServices',
      { deleteRetentionPolicy: { enabled: true, days: 30, allowPermanentDelete: false } },
    ],
    [
      'container',
      `${state.ids.storageId}/blobServices/default/containers/function-releases`,
      'Microsoft.Storage/storageAccounts/blobServices/containers',
      { defaultEncryptionScope: '$account-encryption-key', denyEncryptionScopeOverride: false },
    ],
  ];
  for (const [key, id, type, properties] of extras) {
    state.ids[key] = id;
    state.record.inventory.push({ id, type });
    state.observed.resourceSettings[id.toLowerCase()] = { type, properties };
  }
  const delta = (path, propertyChangeType, before, after) => ({
    path,
    propertyChangeType,
    before,
    after,
    children: null,
  });
  const changes = [
    [state.ids.budgetId, [delta('properties.timePeriod.endDate', 'Delete', '2036-08-01T00:00:00Z', null)]],
    [
      state.ids.insights,
      [
        delta('properties.Flow_Type', 'Create', null, 'Bluefield'),
        delta('properties.Request_Source', 'Create', null, 'rest'),
      ],
    ],
    [
      state.ids.vault,
      [delta('properties.networkAcls', 'Create', null, { bypass: 'AzureServices', defaultAction: 'Allow' })],
    ],
    [state.ids.blobs, [delta('properties.deleteRetentionPolicy.allowPermanentDelete', 'Delete', false, null)]],
    [
      state.ids.container,
      [
        delta('properties.defaultEncryptionScope', 'Delete', '$account-encryption-key', null),
        delta('properties.denyEncryptionScopeOverride', 'Delete', false, null),
      ],
    ],
    [
      state.ids.roleId,
      [
        delta(
          'properties.principalId',
          'Modify',
          state.observed.site.identity.principalId,
          `[reference('${state.ids.functionAppId}', '2023-12-01', 'full').identity.principalId]`,
        ),
        delta('properties.principalType', 'NoEffect', null, 'ServicePrincipal'),
      ],
    ],
    [
      state.ids.functionAppId,
      [
        delta('properties.siteConfig.minimumElasticInstanceCount', 'Modify', 1, 0),
        ...['cors', 'ftpsState', 'localMySqlEnabled', 'minTlsVersion'].map((key) =>
          delta(`properties.siteConfig.${key}`, 'Create', null, state.observed.web[key]),
        ),
        delta('properties.siteConfig.netFrameworkVersion', 'Create', null, 'v4.6'),
      ],
    ],
    [
      state.ids.appSettingsId,
      [
        delta(
          'properties',
          'Create',
          null,
          "[union(variables('retainedReleaseIdentity'),variables('managedSettings'))]",
        ),
      ],
    ],
  ].map(([resourceId, entries]) => ({ resourceId, changeType: 'Modify', delta: entries }));
  state.whatIf = completeWhatIf(state.record, new Map(changes.map((entry) => [entry.resourceId.toLowerCase(), entry])));
  state.whatIf.changes.push({
    resourceId: `${scope}Microsoft.Storage/storageAccounts/retiredaccount`,
    changeType: 'Ignore',
  });
  state.whatIf.changes.find((change) => change.resourceId === state.ids.planId).delta = [
    delta('sku.tier', 'NoEffect', null, 'Dynamic'),
  ];
  return state;
}

test('NoChange permits only independently verified NoEffect role or hosting-plan metadata', () => {
  const state = azureDefaultsFixture();
  const role = state.whatIf.changes.find((change) => change.resourceId === state.ids.roleId);
  role.changeType = 'NoChange';
  role.delta = role.delta.filter((delta) => delta.path === 'properties.principalType');
  assert.equal(decide(state, { whatIf: state.whatIf }).mode, 'application-only');
  role.delta[0].path = 'properties.condition';
  assertFull(decide(state, { whatIf: state.whatIf }));
  const wrongPlan = azureDefaultsFixture();
  wrongPlan.whatIf.changes.find((change) => change.resourceId === wrongPlan.ids.planId).delta[0].after = 'Premium';
  assertFull(decide(wrongPlan, { whatIf: wrongPlan.whatIf }));
});

test('null child lists are leaf properties while malformed or empty nested lists remain incomplete', () => {
  for (const children of [{}, 'unknown', []]) {
    const state = azureDefaultsFixture();
    state.whatIf.changes.find((change) => change.resourceId === state.ids.budgetId).delta[0].children = children;
    assertFull(decide(state, { whatIf: state.whatIf }));
  }
});

test('Azure omitted defaults and reference substitutions qualify only with complete accepted current state', () => {
  const state = azureDefaultsFixture();
  assert.deepEqual(decide(state, { whatIf: state.whatIf }), { mode: 'application-only', reasons: [] });
});

test('each Azure default exception rejects a different provider value or change kind', async (t) => {
  const initial = azureDefaultsFixture();
  for (const [changeIndex, change] of initial.whatIf.changes.entries()) {
    for (const [deltaIndex, delta] of (change.delta ?? []).entries()) {
      if (delta.path === 'properties.principalId') continue; // Existing reference substitution has independent identity coverage.
      await t.test(`${changeIndex}:${delta.path}`, () => {
        const state = azureDefaultsFixture();
        const altered = state.whatIf.changes[changeIndex].delta[deltaIndex];
        altered.propertyChangeType = 'Array';
        assertFull(decide(state, { whatIf: state.whatIf }));
        altered.propertyChangeType = delta.propertyChangeType;
        altered.after = 'unrecognized-provider-value';
        assertFull(decide(state, { whatIf: state.whatIf }));
      });
    }
  }
});

test('actual out-of-band defaults and policy changes cannot be relabeled as unchanged Azure noise', async (t) => {
  const mutations = [
    [
      'budget expiry',
      (s) => {
        s.observed.resourceSettings[s.ids.budgetId.toLowerCase()].properties.timePeriod.endDate =
          '2027-08-01T00:00:00Z';
      },
    ],
    [
      'vault access',
      (s) => {
        s.observed.resourceSettings[s.ids.vault.toLowerCase()].properties.networkAcls = { defaultAction: 'Deny' };
      },
    ],
    [
      'insights metadata',
      (s) => {
        s.observed.resourceSettings[s.ids.insights.toLowerCase()].properties.Request_Source = 'changed';
      },
    ],
    [
      'permanent deletion',
      (s) => {
        s.observed.resourceSettings[s.ids.blobs.toLowerCase()].properties.deleteRetentionPolicy.allowPermanentDelete =
          true;
      },
    ],
    [
      'encryption scope',
      (s) => {
        s.observed.resourceSettings[s.ids.container.toLowerCase()].properties.defaultEncryptionScope = 'foreign-scope';
      },
    ],
    [
      'web setting',
      (s) => {
        s.observed.web.localMySqlEnabled = true;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, () => {
      const state = azureDefaultsFixture();
      state.observed = structuredClone(state.observed);
      mutate(state);
      assertFull(decide(state, { whatIf: state.whatIf }));
    });
});

test('ignored unrelated resources never replace managed coverage or permit foreign, duplicate, or changing resources', async (t) => {
  const cases = [
    [
      'foreign ignore',
      (s) => {
        s.whatIf.changes.at(-1).resourceId = s.whatIf.changes.at(-1).resourceId.replace('rg-api-prod', 'rg-foreign');
      },
    ],
    [
      'duplicate ignore',
      (s) => {
        s.whatIf.changes.push(structuredClone(s.whatIf.changes.at(-1)));
      },
    ],
    [
      'managed ignore',
      (s) => {
        s.whatIf.changes.find((c) => c.resourceId === s.ids.container).changeType = 'Ignore';
      },
    ],
    [
      'unmanaged modification',
      (s) => {
        s.whatIf.changes.at(-1).changeType = 'Modify';
      },
    ],
    [
      'ignored delta',
      (s) => {
        s.whatIf.changes.at(-1).delta = [{ path: 'properties.enabled', propertyChangeType: 'Delete' }];
      },
    ],
    [
      'missing managed child',
      (s) => {
        s.whatIf.changes = s.whatIf.changes.filter((c) => c.resourceId !== s.ids.appSettingsId);
      },
    ],
    [
      'missing captured default',
      (s) => {
        s.observed = structuredClone(s.observed);
        delete s.observed.resourceSettings[s.ids.blobs.toLowerCase()];
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, () => {
      const state = azureDefaultsFixture();
      mutate(state);
      assertFull(decide(state, { whatIf: state.whatIf }));
    });
});

test('accepted Azure defaults cannot hide an unrelated changed property or expired budget', () => {
  const state = azureDefaultsFixture();
  state.whatIf.changes
    .find((c) => c.resourceId === state.ids.vault)
    .delta.push({
      path: 'properties.enableRbacAuthorization',
      propertyChangeType: 'Modify',
      before: true,
      after: false,
    });
  assertFull(decide(state, { whatIf: state.whatIf }));
  const expired = azureDefaultsFixture();
  assertFull(decide(expired, { whatIf: expired.whatIf, now: Date.UTC(2036, 8, 7) }));
});

test('a matching but incorrect accepted default is not permission to skip its repair', async (t) => {
  const cases = [
    [
      'wrong budget interval',
      (s) => {
        s.observed.resourceSettings[s.ids.budgetId.toLowerCase()].properties.timePeriod.endDate =
          '2027-08-01T00:00:00Z';
        s.whatIf.changes.find((c) => c.resourceId === s.ids.budgetId).delta[0].before = '2027-08-01T00:00:00Z';
      },
    ],
    [
      'vault denial',
      (s) => {
        s.observed.resourceSettings[s.ids.vault.toLowerCase()].properties.networkAcls = { defaultAction: 'Deny' };
      },
    ],
    [
      'permanent deletion',
      (s) => {
        s.observed.resourceSettings[s.ids.blobs.toLowerCase()].properties.deleteRetentionPolicy.allowPermanentDelete =
          true;
      },
    ],
    [
      'custom encryption',
      (s) => {
        s.observed.resourceSettings[s.ids.container.toLowerCase()].properties.defaultEncryptionScope = 'custom-scope';
      },
    ],
    [
      'wrong role type',
      (s) => {
        s.observed.roles[s.ids.roleId.toLowerCase()].principalType = 'User';
      },
    ],
    [
      'foreign framework',
      (s) => {
        s.observed.web.netFrameworkVersion = 'unrecognized';
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, () => {
      const state = azureDefaultsFixture();
      mutate(state);
      // This fixture deliberately shares record.observed and live observed.
      assert.equal(state.record.observed, state.observed);
      assertFull(decide(state, { whatIf: state.whatIf }));
    });
});

test('Succeeded and exact ID coverage cannot conceal short-circuited analysis', async (t) => {
  const cases = [
    [
      'root diagnostic',
      (s) => {
        s.whatIf.diagnostics = [{ code: 'ShortCircuit' }];
      },
    ],
    [
      'potential change',
      (s) => {
        s.whatIf.potentialChanges = [{ resourceId: 'unresolved' }];
      },
    ],
    [
      'managed unsupported reason',
      (s) => {
        s.whatIf.changes[0].unsupportedReason = 'NotAnalyzed';
      },
    ],
    [
      'ignored unsupported reason',
      (s) => {
        s.whatIf.changes.at(-1).unsupportedReason = 'NestedLimit';
      },
    ],
    [
      'child diagnostic',
      (s) => {
        s.whatIf.changes[0].diagnostics = ['incomplete'];
      },
    ],
    [
      'malformed diagnostic',
      (s) => {
        s.whatIf.diagnostics = {};
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, () => {
      const state = azureDefaultsFixture();
      mutate(state);
      assertFull(decide(state, { whatIf: state.whatIf }));
    });
});

test('private accepted record commits inputs without retaining supplied secret or password values', () => {
  const state = fixture();
  const serialized = JSON.stringify(state.record);

  assert.deepEqual(Object.keys(state.record).sort(), [
    'comparisonKey',
    'inputCommitment',
    'inventory',
    'observed',
    'origin',
    'schemaVersion',
    'target',
    'templateSha256',
    'toolchain',
  ]);
  assert.match(state.record.inputCommitment, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(serialized, new RegExp(LOW_ENTROPY_SECRET));
  assert.doesNotMatch(serialized, new RegExp(SUPPLIED_PASSWORD));
  assert.deepEqual(state.record.observed, state.observed);
});

test('private pointer preserves the exact version and verifies immutable bytes before parsing', () => {
  const state = fixture();
  const bytes = Buffer.from(JSON.stringify(state.record));
  const versionId = '2026-09-07T12:00:00.0000000Z';
  const pointer = configurationPointer({
    target: state.target,
    origin: state.origin,
    versionId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  });

  assert.equal(pointer.versionId, versionId);
  assert.equal(pointer.size, bytes.byteLength);
  assert.deepEqual(
    verifyDeploymentConfiguration({ bytes, pointer, target: state.target, origin: state.origin }),
    state.record,
  );

  const changedBytes = Buffer.from(bytes);
  changedBytes[0] = '['.charCodeAt(0);
  assert.throws(
    () => verifyDeploymentConfiguration({ bytes: changedBytes, pointer, target: state.target, origin: state.origin }),
    /Private configuration byte binding failed/,
  );
});

test('foreign storage, foreign origin, and changed bytes cannot reuse a trusted pointer', () => {
  const state = fixture();
  const bytes = Buffer.from(JSON.stringify(state.record));
  const pointer = configurationPointer({
    target: state.target,
    origin: state.origin,
    versionId: 'trusted-version',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  });
  const foreignAccount = { ...pointer, account: 'foreignaccount' };
  const foreignOrigin = {
    ...pointer,
    blob: `accepted/${'c'.repeat(40)}/999/1/promotion/deployment-configuration.json`,
  };
  const changedBytes = Buffer.concat([bytes.subarray(0, -1), Buffer.from(']')]);

  assert.ok(validateConfigurationPointer(foreignAccount, state).length > 0);
  assert.ok(validateConfigurationPointer(foreignOrigin, state).length > 0);
  for (const [candidatePointer, candidateBytes] of [
    [foreignAccount, bytes],
    [foreignOrigin, bytes],
    [pointer, changedBytes],
  ]) {
    assert.throws(
      () =>
        verifyDeploymentConfiguration({
          bytes: candidateBytes,
          pointer: candidatePointer,
          target: state.target,
          origin: state.origin,
        }),
      /Private configuration byte binding failed/,
    );
  }
});

test('exact unchanged inputs, accepted live observations, and complete NoChange evidence qualify', () => {
  assert.deepEqual(decide(fixture()), { mode: 'application-only', reasons: [] });
});

test('legacy accepted configuration requires a new full deployment before using expanded resource evidence', () => {
  const state = fixture();
  const record = { ...state.record, schemaVersion: 1 };
  delete record.observed.resourceSettings;
  assertFull(decide(state, { record }));
});

test('a different deployment inventory cannot reuse an otherwise matching accepted configuration', () => {
  const state = fixture();
  assertFull(decide(state, { inventory: undefined }));
  assertFull(decide(state, { inventory: state.record.inventory.slice(1) }));
  const changed = structuredClone(state.record.inventory);
  changed[0].id += '-replacement';
  assertFull(decide(state, { inventory: changed }));
  assert.equal(decide(state, { inventory: [...state.record.inventory].reverse() }).mode, 'application-only');
});

test('a changed low-entropy secret input selects full reconciliation even when the live vault is unchanged', () => {
  const state = fixture();
  const parameters = structuredClone(state.parameters);
  parameters.redditClientSecret.value = 'hunter3';

  const result = decide(state, { parameters });
  assertFull(result);
  assert.ok(result.reasons.includes('Effective deployment inputs changed.'));
});

test('out-of-band secret version rotation with matching app settings still selects full reconciliation', () => {
  const state = fixture();
  const observed = structuredClone(state.observed);
  const rotatedVersion = 'https://api-vault.vault.azure.net/secrets/bring-password/22222222222222222222222222222222';
  observed.secrets[0].versionUri = rotatedVersion;
  observed.managedSettings.BRING_PASSWORD = `@Microsoft.KeyVault(SecretUri=${rotatedVersion})`;

  const result = decide(state, { observed });
  assertFull(result);
  assert.ok(result.reasons.includes('Installed configuration or identity drifted from accepted state.'));
});

test('the same Function App name with a new managed identity principal selects full reconciliation', () => {
  const state = fixture();
  const observed = structuredClone(state.observed);
  observed.site.identity.principalId = '10000000-0000-0000-0000-000000000099';

  const result = decide(state, { observed });
  assertFull(result);
  assert.equal(observed.site.name, state.observed.site.name);
  assert.ok(result.reasons.includes('Installed configuration or identity drifted from accepted state.'));
});

test('storage and budget what-if drift select full reconciliation', async (t) => {
  for (const [name, id, path] of [
    ['storage', fixture().ids.storageId, 'properties.allowBlobPublicAccess'],
    ['budget', fixture().ids.budgetId, 'properties.amount'],
  ]) {
    await t.test(name, () => {
      const state = fixture();
      const whatIf = completeWhatIf(state.record, new Map([[id.toLowerCase(), modify(id, path)]]));
      assertFull(decide(state, { whatIf }));
    });
  }
});

test('ignored or missing nested app-settings evidence selects full reconciliation', async (t) => {
  await t.test('ignored app-settings child', () => {
    const state = fixture();
    const whatIf = completeWhatIf(
      state.record,
      new Map([[state.ids.appSettingsId.toLowerCase(), { resourceId: state.ids.appSettingsId, changeType: 'Ignore' }]]),
    );
    assertFull(decide(state, { whatIf }));
  });

  await t.test('missing app-settings child', () => {
    const state = fixture();
    const whatIf = completeWhatIf(state.record);
    whatIf.changes = whatIf.changes.filter(
      (change) => change.resourceId.toLowerCase() !== state.ids.appSettingsId.toLowerCase(),
    );
    const result = decide(state, { whatIf });
    assertFull(result);
    assert.ok(result.reasons.includes('What-if omits managed resources, including nested children.'));
  });
});

test('malformed or incomplete whole-template what-if evidence fails closed', async (t) => {
  const cases = [
    ['missing result', null],
    ['nonterminal result', { status: 'Running', changes: [] }],
    ['missing changes', { status: 'Succeeded' }],
    ['provider error', { status: 'Succeeded', changes: [], error: { code: 'WhatIfFailed' } }],
  ];
  for (const [name, whatIf] of cases) {
    await t.test(name, () => assertFull(decide(fixture(), { whatIf })));
  }

  await t.test('empty modification evidence', () => {
    const state = fixture();
    const whatIf = completeWhatIf(
      state.record,
      new Map([
        [state.ids.secretId.toLowerCase(), { resourceId: state.ids.secretId, changeType: 'Modify', delta: [] }],
      ]),
    );
    assertFull(decide(state, { whatIf }));
  });
});

test('narrow unresolved substitutions qualify only with unchanged accepted live evidence', async (t) => {
  const scenarios = [
    {
      name: 'secret value',
      id: (state) => state.ids.secretId,
      path: 'properties.value',
      drift(observed) {
        const rotatedVersion =
          'https://api-vault.vault.azure.net/secrets/bring-password/33333333333333333333333333333333';
        observed.secrets[0].versionUri = rotatedVersion;
        observed.managedSettings.BRING_PASSWORD = `@Microsoft.KeyVault(SecretUri=${rotatedVersion})`;
      },
    },
    {
      name: 'role principal',
      id: (state) => state.ids.roleId,
      path: 'properties.principalId',
      drift(observed, state) {
        observed.roles[state.ids.roleId.toLowerCase()].principalId = '10000000-0000-0000-0000-000000000099';
      },
    },
    {
      name: 'app settings object',
      id: (state) => state.ids.appSettingsId,
      path: 'properties',
      drift(observed) {
        observed.managedSettings.FEATURE_MODE = 'out-of-band';
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const state = fixture();
      const id = scenario.id(state);
      const whatIf = completeWhatIf(state.record, new Map([[id.toLowerCase(), modify(id, scenario.path)]]));
      assert.deepEqual(decide(state, { whatIf }), { mode: 'application-only', reasons: [] });

      const observed = structuredClone(state.observed);
      scenario.drift(observed, state);
      assertFull(decide(state, { observed, whatIf }));
    });
  }
});

test('an allowed unresolved substitution cannot silence an arbitrary second property change', () => {
  const state = fixture();
  const whatIf = completeWhatIf(
    state.record,
    new Map([
      [
        state.ids.secretId.toLowerCase(),
        {
          resourceId: state.ids.secretId,
          changeType: 'Modify',
          delta: [
            { path: 'properties.value', propertyChangeType: 'Modify' },
            { path: 'properties.contentType', propertyChangeType: 'Modify' },
          ],
        },
      ],
    ]),
  );

  assertFull(decide(state, { whatIf }));
});

test('retention-only dynamic input needs exact accepted-live and intended-after what-if proof', () => {
  const state = fixture();
  const parameters = structuredClone(state.parameters);
  parameters.releaseRetentionPolicy.value.rules[0].definition.filters.prefixMatch = [
    'function-releases/functionapp-01',
  ];
  const exactTransition = modify(state.ids.retentionId, 'properties.policy.rules', {
    before: { properties: { policy: state.observed.retentionPolicy } },
    after: { properties: { policy: parameters.releaseRetentionPolicy.value } },
  });
  const whatIf = completeWhatIf(state.record, new Map([[state.ids.retentionId.toLowerCase(), exactTransition]]));

  assert.deepEqual(decide(state, { parameters, whatIf }), { mode: 'application-only', reasons: [] });

  const wrongBefore = structuredClone(whatIf);
  const retentionChange = wrongBefore.changes.find(
    (change) => change.resourceId.toLowerCase() === state.ids.retentionId.toLowerCase(),
  );
  retentionChange.before.properties.policy.rules[0].definition.filters.prefixMatch = [
    'function-releases/functionapp-99',
  ];
  assertFull(decide(state, { parameters, whatIf: wrongBefore }));

  const missingTransition = completeWhatIf(state.record);
  assertFull(decide(state, { parameters, whatIf: missingTransition }));
});
