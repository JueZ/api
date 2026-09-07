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
    web: { alwaysOn: true, linuxFxVersion: 'NODE|22', minimumElasticInstanceCount: 1 },
    managedSettings: {
      BRING_PASSWORD: `@Microsoft.KeyVault(SecretUri=${secretVersion})`,
      FEATURE_MODE: 'production',
    },
    secrets: [{ name: 'bring-password', versionUri: secretVersion, attributes: { enabled: true } }],
    roles: {
      [roleId.toLowerCase()]: { principalId: '10000000-0000-0000-0000-000000000001' },
    },
    retentionPolicy,
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
