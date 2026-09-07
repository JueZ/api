#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AzureCliCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { uploadExact } from './accepted-release-store.mjs';
import {
  applicationOnlyPreconditions,
  canonicalConfiguration,
  configurationPointer,
  createDeploymentConfiguration,
  decideApplicationOnly,
  validateConfigurationPointer,
  validateObservedConfiguration,
  verifyDeploymentConfiguration,
} from './deployment-configuration.mjs';
import {
  buildExpectedRuntimeSettings,
  validateArmRuntimeSettingsResponse,
} from './validate-deployed-runtime-settings.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const credential = new AzureCliCredential();
const same = (a, b) => canonicalConfiguration(a) === canonicalConfiguration(b);
const secretReferences = [
  ['reddit-client-secret', 'EXPECTED_REDDIT_CLIENT_SECRET_REFERENCE'],
  ['wlh-base-url', 'EXPECTED_WLH_BASE_URL_REFERENCE'],
  ['bring-client-api-key', 'EXPECTED_BRING_CLIENT_API_KEY_REFERENCE'],
  ['bring-email', 'EXPECTED_BRING_EMAIL_REFERENCE'],
  ['bring-password', 'EXPECTED_BRING_PASSWORD_REFERENCE'],
  ['bring-confirmation-hmac-key', 'EXPECTED_BRING_CONFIRMATION_HMAC_KEY_REFERENCE'],
  ['bring-mutation-encryption-key', 'EXPECTED_BRING_MUTATION_ENCRYPTION_KEY_REFERENCE'],
  ['google-weather-api-key', 'EXPECTED_GOOGLE_WEATHER_API_KEY_REFERENCE', 'WEATHER_ENABLED'],
  ['openai-api-key', 'EXPECTED_OPENAI_API_KEY_REFERENCE', 'REPAIRABLE_ERRORS_LLM_ENABLED'],
  ['supadata-api-key', 'EXPECTED_SUPADATA_API_KEY_REFERENCE', 'YOUTUBE_TRANSCRIPT_ENABLED'],
  ['youtube-transcript-cursor-hmac-key', 'EXPECTED_YOUTUBE_CURSOR_HMAC_KEY_REFERENCE', 'YOUTUBE_TRANSCRIPT_ENABLED'],
];

function privatePath(name) {
  if (!process.env.RUNNER_TEMP) throw new Error('Private runner directory is required.');
  const root = resolve(process.env.RUNNER_TEMP);
  const target = resolve(root, name);
  const path = relative(root, target);
  if (!path || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path))
    throw new Error('Configuration files must remain private to the runner.');
  return target;
}

async function writePrivate(name, value) {
  const path = privatePath(name);
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}

async function armClient() {
  const access = await credential.getToken('https://management.azure.com/.default');
  if (!access?.token) throw new Error('Azure inspection authentication is unavailable.');
  return async (id, apiVersion, method = 'GET', body) => {
    if (
      !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\//i.test(id) ||
      !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}(?:-preview)?$/.test(apiVersion)
    )
      throw new Error('Invalid scoped resource inspection.');
    const response = await fetch(`https://management.azure.com${id}?api-version=${apiVersion}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('Required configuration control-plane operation failed.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Configuration response exceeds its bound.');
    return JSON.parse(Buffer.from(bytes));
  };
}

function project(value, keys) {
  const result = {};
  for (const key of keys) {
    if (!Object.hasOwn(value ?? {}, key)) throw new Error('Managed resource field is unavailable.');
    result[key] = value[key];
  }
  return result;
}

const resourceSettingsVersions = new Map([
  ['Microsoft.Consumption/budgets', '2024-08-01'],
  ['Microsoft.Insights/components', '2020-02-02'],
  ['Microsoft.KeyVault/vaults', '2023-07-01'],
  ['Microsoft.Storage/storageAccounts/blobServices', '2023-05-01'],
  ['Microsoft.Storage/storageAccounts/blobServices/containers', '2023-05-01'],
]);
const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;

async function inspectInBatches(items, inspect) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += 5)
    results.push(...(await Promise.all(items.slice(offset, offset + 5).map(inspect))));
  return results;
}

function projectResourceSettings(id, type, response) {
  if (
    !response ||
    response.error ||
    (Object.hasOwn(response, 'id') &&
      (typeof response.id !== 'string' || response.id.toLowerCase() !== id.toLowerCase())) ||
    (Object.hasOwn(response, 'type') &&
      (typeof response.type !== 'string' || response.type.toLowerCase() !== type.toLowerCase()))
  )
    throw new Error('Managed resource response identity is unavailable.');
  const properties = response.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties))
    throw new Error('Managed resource properties are unavailable.');
  switch (type) {
    case 'Microsoft.Consumption/budgets': {
      const timePeriod = project(properties.timePeriod, ['startDate', 'endDate']);
      if (!Object.values(timePeriod).every(nonemptyString))
        throw new Error('Managed budget time period is unavailable.');
      return { timePeriod };
    }
    case 'Microsoft.Insights/components':
      return { Flow_Type: properties.Flow_Type ?? null, Request_Source: properties.Request_Source ?? null };
    case 'Microsoft.KeyVault/vaults': {
      const { publicNetworkAccess } = project(properties, ['publicNetworkAccess']);
      if (!nonemptyString(publicNetworkAccess)) throw new Error('Managed vault network policy is unavailable.');
      return { networkAcls: properties.networkAcls ?? null, publicNetworkAccess };
    }
    case 'Microsoft.Storage/storageAccounts/blobServices': {
      const deleteRetentionPolicy = project(properties.deleteRetentionPolicy, [
        'enabled',
        'days',
        'allowPermanentDelete',
      ]);
      if (
        typeof deleteRetentionPolicy.enabled !== 'boolean' ||
        !Number.isInteger(deleteRetentionPolicy.days) ||
        typeof deleteRetentionPolicy.allowPermanentDelete !== 'boolean'
      )
        throw new Error('Managed blob retention policy is unavailable.');
      return { deleteRetentionPolicy };
    }
    case 'Microsoft.Storage/storageAccounts/blobServices/containers': {
      const settings = project(properties, ['defaultEncryptionScope', 'denyEncryptionScopeOverride']);
      if (!nonemptyString(settings.defaultEncryptionScope) || typeof settings.denyEncryptionScopeOverride !== 'boolean')
        throw new Error('Managed container encryption policy is unavailable.');
      return settings;
    }
    default:
      throw new Error('Unsupported managed resource settings.');
  }
}

export async function captureDeploymentConfiguration({ env, readArm }) {
  if (
    env.ENVIRONMENT_NAME !== 'prod' ||
    !/^[0-9a-f-]{36}$/i.test(env.AZURE_SUBSCRIPTION_ID ?? '') ||
    !/^[A-Za-z0-9._()-]{1,90}$/.test(env.AZURE_RESOURCE_GROUP ?? '')
  )
    throw new Error('Exact production configuration scope is required.');
  const scope = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers`;
  const inspect = async (id, apiVersion, method = 'GET', body) => {
    try {
      const response = await readArm(id, apiVersion, method, body);
      if (!response || typeof response !== 'object' || Array.isArray(response) || response.error)
        throw new Error('Unusable control-plane response.');
      return response;
    } catch {
      throw new Error('Required configuration control-plane inspection failed.');
    }
  };
  const deployment = await inspect(`${scope}/Microsoft.Resources/deployments/main-prod`, '2025-04-01');
  if (
    deployment.properties?.provisioningState !== 'Succeeded' ||
    deployment.properties?.mode !== 'Incremental' ||
    !Array.isArray(deployment.properties?.outputResources) ||
    deployment.properties.outputResources.length < 1 ||
    deployment.properties.outputResources.length > 200
  )
    throw new Error('Accepted deployment inventory is unavailable.');
  const inventoryIds = new Set();
  const inventory = deployment.properties.outputResources.map((item) => {
    const id = typeof item?.id === 'string' ? item.id.toLowerCase() : '';
    if (!id.startsWith(`${scope.toLowerCase()}/`) || inventoryIds.has(id) || typeof item?.resourceType !== 'string')
      throw new Error('Accepted deployment inventory is invalid.');
    inventoryIds.add(id);
    return { id: item.id, type: item.resourceType };
  });
  const outputs = deployment.properties.outputs;
  const output = (name) => {
    const value = outputs?.[name]?.value;
    if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value))
      throw new Error('Resolved resource identity is unavailable.');
    return value;
  };
  const functionName = output('functionAppResourceName');
  if (functionName !== env.AZURE_FUNCTIONAPP_NAME)
    throw new Error('Production Function identity differs from the configured target.');
  const target = {
    subscriptionId: env.AZURE_SUBSCRIPTION_ID,
    resourceGroup: env.AZURE_RESOURCE_GROUP,
    environment: 'prod',
    functionAppId: `${scope}/Microsoft.Web/sites/${functionName}`,
    releaseStorageAccount: output('releaseStorageAccountResourceName'),
  };
  const appInsightsId = `${scope}/Microsoft.Insights/components/${output('applicationInsightsResourceName')}`;
  const vaultId = `${scope}/Microsoft.KeyVault/vaults/${output('keyVaultResourceName')}`;
  const retentionId = `${scope}/Microsoft.Storage/storageAccounts/${target.releaseStorageAccount}/managementPolicies/default`;
  const [site, web, settings, insights, retention] = await Promise.all([
    inspect(target.functionAppId, '2023-12-01'),
    inspect(`${target.functionAppId}/config/web`, '2023-12-01'),
    inspect(`${target.functionAppId}/config/appsettings/list`, '2023-12-01', 'POST', {}),
    inspect(appInsightsId, '2020-02-02'),
    inspect(retentionId, '2023-05-01'),
  ]);
  const expectedEnv = {
    ...env,
    EFFECTIVE_HOST_STORAGE_ACCOUNT: output('hostStorageAccountResourceName'),
    EFFECTIVE_PRIVATE_STORAGE_ACCOUNT: output('privateStorageAccountResourceName'),
    EXPECTED_APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties?.ConnectionString,
  };
  const requiredSecrets = secretReferences.filter(([, , flag]) => !flag || env[flag] === 'true');
  const secrets = await inspectInBatches(requiredSecrets, async ([name, variable]) => {
    const secret = await inspect(`${vaultId}/secrets/${name}`, '2023-07-01');
    const versionUri = secret.properties?.secretUriWithVersion;
    expectedEnv[variable] = `@Microsoft.KeyVault(SecretUri=${versionUri})`;
    const attributes = secret.properties?.attributes;
    if (!attributes || typeof attributes.enabled !== 'boolean')
      throw new Error('Secret validity metadata is unavailable.');
    return {
      name,
      versionUri,
      attributes: { enabled: attributes.enabled, nbf: attributes.nbf ?? null, exp: attributes.exp ?? null },
    };
  });
  const policyErrors = validateArmRuntimeSettingsResponse(settings, expectedEnv);
  if (policyErrors.length) throw new Error('Complete installed runtime policy differs from intended configuration.');
  const roles = {};
  // Bounded parallel reads of only the immutable deployment inventory's assignments.
  const assignments = inventory.filter((item) => item.type === 'Microsoft.Authorization/roleAssignments');
  if (assignments.length > 50) throw new Error('Role inventory exceeds the inspection bound.');
  for (let offset = 0; offset < assignments.length; offset += 5) {
    await Promise.all(
      assignments.slice(offset, offset + 5).map(async ({ id }) => {
        const role = await inspect(id, '2022-04-01');
        roles[id.toLowerCase()] = {
          ...project(role.properties, ['scope', 'roleDefinitionId', 'principalId', 'principalType']),
          condition: role.properties.condition ?? null,
          conditionVersion: role.properties.conditionVersion ?? null,
          delegatedManagedIdentityResourceId: role.properties.delegatedManagedIdentityResourceId ?? null,
        };
      }),
    );
  }
  const staticBlobServiceId =
    `${scope}/Microsoft.Storage/storageAccounts/${outputs?.staticWebStorageAccountResourceName?.value}/blobServices/default`.toLowerCase();
  const resourceSettings = Object.fromEntries(
    await inspectInBatches(
      inventory.filter(({ type }) => resourceSettingsVersions.has(type)),
      async ({ id, type }) => {
        const apiVersion =
          type === 'Microsoft.Storage/storageAccounts/blobServices' && id.toLowerCase() === staticBlobServiceId
            ? '2025-08-01'
            : resourceSettingsVersions.get(type);
        const response =
          type === 'Microsoft.Insights/components' && id.toLowerCase() === appInsightsId.toLowerCase()
            ? insights
            : await inspect(id, apiVersion);
        return [id.toLowerCase(), { type, properties: projectResourceSettings(id, type, response) }];
      },
    ),
  );
  const observed = {
    site: {
      ...project(site, ['id', 'kind', 'location']),
      identity: project(site.identity, ['type', 'principalId', 'tenantId']),
      properties: project(site.properties, ['serverFarmId', 'httpsOnly', 'publicNetworkAccess']),
    },
    web: project(web.properties, [
      'linuxFxVersion',
      'minTlsVersion',
      'ftpsState',
      'http20Enabled',
      'minimumElasticInstanceCount',
      'cors',
      'localMySqlEnabled',
      'netFrameworkVersion',
    ]),
    managedSettings: buildExpectedRuntimeSettings(expectedEnv),
    secrets: secrets.sort((a, b) => a.name.localeCompare(b.name)),
    roles,
    resourceSettings,
    retentionPolicy: retention.properties?.policy,
  };
  const plan = inventory.filter((item) => item.type === 'Microsoft.Web/serverfarms');
  if (plan.length !== 1) throw new Error('The managed hosting plan is ambiguous.');
  const hostingPlan = await inspect(plan[0].id, '2023-12-01');
  observed.site.hostingPlan = {
    ...project(hostingPlan, ['id', 'kind', 'location']),
    sku: project(hostingPlan.sku, ['name', 'tier']),
  };
  if (
    observed.site.hostingPlan.sku.name !== 'Y1' ||
    observed.site.hostingPlan.sku.tier !== 'Dynamic' ||
    observed.site.properties.serverFarmId.toLowerCase() !== plan[0].id.toLowerCase() ||
    observed.site.properties.httpsOnly !== true ||
    observed.site.properties.publicNetworkAccess !== 'Enabled' ||
    observed.site.identity.type !== 'SystemAssigned' ||
    observed.web.linuxFxVersion !== 'NODE|22' ||
    observed.web.minTlsVersion !== '1.2' ||
    observed.web.ftpsState !== 'Disabled' ||
    observed.web.http20Enabled !== true ||
    typeof observed.web.localMySqlEnabled !== 'boolean' ||
    !nonemptyString(observed.web.netFrameworkVersion) ||
    // Azure documents this property as inapplicable to Y1/Dynamic. Preserve the
    // observed value for later drift comparison, without treating it as paid
    // Elastic capacity. Any other hosting plan is ineligible for this fast path.
    !Number.isInteger(observed.web.minimumElasticInstanceCount) ||
    observed.web.cors?.supportCredentials !== false ||
    !same(observed.web.cors.allowedOrigins, [observed.managedSettings.API_CORS_ALLOWED_ORIGINS]) ||
    validateObservedConfiguration(observed).length
  )
    throw new Error('Direct resource configuration is incompatible with the managed contract.');
  return { target, inventory, observed, outputs };
}

function container(target) {
  return new BlobServiceClient(
    `https://${target.releaseStorageAccount}.blob.core.windows.net`,
    credential,
  ).getContainerClient('function-releases');
}

export async function readAcceptedConfiguration({ baseline, target, storage }) {
  const pointer = baseline?.configurationBaseline;
  if (baseline?.status !== 'accepted' || baseline.acceptanceKind !== 'promotion')
    throw new Error('Normal accepted configuration baseline is unavailable.');
  const origin = {
    sourceRef: baseline.sourceRef,
    controllerRef: baseline.identity?.mutationReceipt?.controllerRef,
    runId: String(baseline.acceptanceRunId),
    correlation: baseline.acceptanceCorrelation,
  };
  if (validateConfigurationPointer(pointer, { target, origin }).length)
    throw new Error('Accepted configuration pointer is unavailable.');
  const client = storage.getBlobClient(pointer.blob).withVersion(pointer.versionId);
  const properties = await client.getProperties();
  if (properties.contentLength !== pointer.size)
    throw new Error('Private configuration size differs from accepted evidence.');
  const bytes = await client.downloadToBuffer(0, pointer.size);
  return verifyDeploymentConfiguration({ bytes, pointer, target, origin });
}

function toolchain() {
  const run = (args) => {
    const result = spawnSync('az', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error('Deployment toolchain version is unavailable.');
    return result.stdout.trim();
  };
  return {
    nodeMajor: Number(process.versions.node.split('.')[0]),
    azureCli: JSON.parse(run(['version', '--output', 'json']))['azure-cli'],
    bicep: run(['bicep', 'version']),
  };
}

function whatIf(parametersPath) {
  const started = Date.now();
  const result = spawnSync(
    'az',
    [
      'deployment',
      'group',
      'what-if',
      '--resource-group',
      process.env.AZURE_RESOURCE_GROUP,
      '--template-file',
      privatePath('deployment-template.json'),
      '--parameters',
      `@${parametersPath}`,
      '--result-format',
      'FullResourcePayloads',
      '--no-pretty-print',
      '--only-show-errors',
      '--output',
      'json',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
  );
  // Raw what-if output can contain secure inputs. It never leaves this process.
  if (result.error || result.status !== 0) return { result: null, durationMs: Date.now() - started };
  try {
    return { result: JSON.parse(result.stdout), durationMs: Date.now() - started };
  } catch {
    return { result: null, durationMs: Date.now() - started };
  }
}

export function summarizeWhatIf(value) {
  const counts = {};
  const changes = [];
  for (const item of Array.isArray(value?.changes) ? value.changes : []) {
    const kind = ['NoChange', 'Modify', 'Create', 'Delete', 'Ignore', 'Deploy'].includes(item?.changeType)
      ? item.changeType
      : 'Unknown';
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind !== 'NoChange')
      changes.push({
        type:
          String(item?.after?.type ?? item?.before?.type ?? '').match(/^Microsoft\.[A-Za-z]+\/[A-Za-z/]+$/)?.[0] ??
          'unknown',
        kind,
        paths: (Array.isArray(item?.delta) ? item.delta : [])
          .map((delta) => (/^[A-Za-z0-9_.[\]-]{1,160}$/.test(delta.path ?? '') ? delta.path : 'unknown'))
          .slice(0, 30),
      });
  }
  return { status: value?.status === 'Succeeded' ? 'succeeded' : 'unavailable', counts, changes: changes.slice(0, 80) };
}

export async function acceptOptionalConfiguration(mode, accept) {
  if (!['full', 'application-only'].includes(mode)) throw new Error('Unknown configuration acceptance mode.');
  try {
    return await accept();
  } catch {
    if (mode !== 'full') throw new Error('Application-only configuration acceptance failed.');
    // Full reconciliation already passed mandatory runtime policy and verification.
    // Without a pointer, the next delivery cannot use the optional fast path.
    return { status: 'configuration-unavailable', nextDeployment: 'full' };
  }
}

async function deploymentInputs() {
  const parametersPath = privatePath('deployment-parameters.json');
  const parametersFile = await json(parametersPath);
  return {
    parametersPath,
    parameters: parametersFile.parameters ?? parametersFile,
    compiledTemplate: await readFile(privatePath('deployment-template.json')),
    readArm: await armClient(),
  };
}

async function main() {
  const command = process.argv[2];
  if (
    !['decide', 'accept', 'update-retention'].includes(command) ||
    process.env.ENVIRONMENT_NAME !== 'prod' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'JueZ/api' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_WORKFLOW_REF !== 'JueZ/api/.github/workflows/delivery-v2.yml@refs/heads/main' ||
    process.env.GITHUB_RUN_ATTEMPT !== '1'
  )
    throw new Error('Invalid production configuration operation.');
  const enabled = process.env.APPLICATION_ONLY_DEPLOYMENT_ENABLED === 'true';
  const shadow = process.env.APPLICATION_ONLY_SHADOW_MEASURE === 'true';
  if (command === 'update-retention') {
    const { parameters, readArm } = await deploymentInputs();
    const decision = await json(privatePath('deployment-configuration-decision.json'));
    if (decision.mode !== 'application-only')
      throw new Error('Retention update requires the qualified application-only decision.');
    const captured = await captureDeploymentConfiguration({ env: process.env, readArm });
    const earlier = await json(privatePath('deployment-configuration-observation.json'));
    if (!same(earlier, captured)) throw new Error('Configuration changed after the application-only decision.');
    const id = `/subscriptions/${captured.target.subscriptionId}/resourceGroups/${captured.target.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${captured.target.releaseStorageAccount}/managementPolicies/default`;
    await readArm(id, '2023-05-01', 'PUT', { properties: { policy: parameters.releaseRetentionPolicy.value } });
    const installed = await readArm(id, '2023-05-01');
    if (!same(installed.properties?.policy, parameters.releaseRetentionPolicy.value))
      throw new Error('Retention update readback failed.');
    return { status: 'retention-updated' };
  }
  if (command === 'decide') {
    if ((!enabled && !shadow) || process.env.RECONCILE_CONFIGURATION === 'true') {
      const decision = {
        mode: 'full',
        eligibleMode: null,
        reasons: [
          process.env.RECONCILE_CONFIGURATION === 'true'
            ? 'Explicit configuration recovery requires full reconciliation.'
            : 'Application-only qualification is disabled.',
        ],
      };
      await writePrivate('deployment-configuration-decision.json', decision);
      await appendFile(process.env.GITHUB_OUTPUT, 'mode=full\n');
      return decision;
    }
    const started = Date.now();
    let decision;
    let observation;
    let prediction;
    try {
      const { parametersPath, parameters, compiledTemplate, readArm } = await deploymentInputs();
      observation = await captureDeploymentConfiguration({ env: process.env, readArm });
      const baseline = await json(privatePath('accepted-baseline/accepted-baseline.json'));
      const record = await readAcceptedConfiguration({
        baseline,
        target: observation.target,
        storage: container(observation.target),
      });
      const comparison = {
        record,
        parameters,
        compiledTemplate,
        toolchain: toolchain(),
        target: observation.target,
        inventory: observation.inventory,
        observed: observation.observed,
        reconcileConfiguration: process.env.RECONCILE_CONFIGURATION === 'true',
      };
      const preconditions = applicationOnlyPreconditions(comparison);
      if (preconditions.length) decision = { mode: 'full', reasons: preconditions };
      else {
        prediction = whatIf(parametersPath);
        decision = decideApplicationOnly({ ...comparison, whatIf: prediction.result });
      }
    } catch {
      // An optional optimization cannot turn missing evidence into permission or
      // obstruct ordinary full reconciliation. No raw Azure/secret errors escape.
      decision = { mode: 'full', reasons: ['Configuration baseline or inspection is unavailable.'] };
    }
    const eligibleMode = decision.mode;
    if (!enabled) decision.mode = 'full';
    decision = {
      ...decision,
      eligibleMode,
      durationMs: Date.now() - started,
      whatIfDurationMs: prediction?.durationMs ?? null,
      ...(prediction ? { whatIf: summarizeWhatIf(prediction.result) } : {}),
    };
    await writePrivate('deployment-configuration-decision.json', decision);
    if (observation) await writePrivate('deployment-configuration-observation.json', observation);
    await appendFile(process.env.GITHUB_OUTPUT, `mode=${decision.mode}\n`);
    return decision;
  }
  // Called only after the existing public/authenticated smoke, telemetry and exact
  // installed-release checks passed. The record is stored before its ledger pointer.
  const decision = await json(privatePath('deployment-configuration-decision.json'));
  return acceptOptionalConfiguration(decision.mode, async () => {
    if (decision.mode === 'full' && !enabled && !shadow) return { status: 'configuration-disabled' };
    const { parametersPath, parameters, compiledTemplate, readArm } = await deploymentInputs();
    const captured = await captureDeploymentConfiguration({ env: process.env, readArm });
    if (decision.mode === 'application-only') {
      const earlier = await json(privatePath('deployment-configuration-observation.json'));
      if (
        !same({ ...earlier.observed, retentionPolicy: parameters.releaseRetentionPolicy.value }, captured.observed) ||
        !same(earlier.target, captured.target) ||
        !same(earlier.inventory, captured.inventory)
      )
        throw new Error('Post-deployment configuration cannot refresh accepted drift.');
    }
    const origin = {
      sourceRef: process.env.SOURCE_REF,
      controllerRef: process.env.GITHUB_SHA,
      runId: String(process.env.GITHUB_RUN_ID),
      correlation: process.env.DELIVERY_CORRELATION,
    };
    const record = createDeploymentConfiguration({
      parameters,
      compiledTemplate,
      toolchain: toolchain(),
      origin,
      ...captured,
    });
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    const blob = `accepted/${origin.controllerRef}/${origin.runId}/1/promotion/deployment-configuration.json`;
    const uploaded = await uploadExact(container(captured.target), blob, bytes);
    const pointer = configurationPointer({ target: captured.target, origin, ...uploaded });
    await writePrivate('deployment-configuration-pointer.json', pointer);
    // Initial rollout measures whole-template response shapes under full reconcile.
    // Summary contains counts/property paths only, never before/after values.
    if (!decision.whatIf && shadow) {
      const prediction = whatIf(parametersPath);
      return {
        status: 'configuration-recorded',
        whatIfDurationMs: prediction.durationMs,
        whatIf: summarizeWhatIf(prediction.result),
      };
    }
    return { status: 'configuration-recorded' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await main()));
  } catch {
    console.error('Production configuration operation failed; no new comparison evidence is accepted.');
    process.exitCode = 1;
  }
}
