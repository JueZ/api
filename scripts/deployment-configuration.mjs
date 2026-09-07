import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalConfiguration(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalConfiguration).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalConfiguration(value[key])}`)
      .join(',')}}`;
  if (
    value === null ||
    ['string', 'boolean'].includes(typeof value) ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new Error('Configuration contains an unsupported value.');
}

const equal = (left, right) => canonicalConfiguration(left) === canonicalConfiguration(right);
function exactKeys(value, keys) {
  return object(value) && equal(Object.keys(value).sort(), [...keys].sort());
}

function comparableParameters(parameters) {
  if (!object(parameters) || !object(parameters.releaseRetentionPolicy?.value))
    throw new Error('Complete deployment parameters and retention policy are required.');
  // Candidate/accepted release buckets change with each application release. Their
  // separate transition guard and exact control-plane update remain mandatory.
  return Object.fromEntries(Object.entries(parameters).filter(([name]) => name !== 'releaseRetentionPolicy'));
}

function commitment(parameters, key) {
  return createHmac('sha256', key)
    .update('juez-deployment-configuration-v1\0')
    .update(canonicalConfiguration(comparableParameters(parameters)))
    .digest('hex');
}

function validOrigin(origin) {
  return (
    exactKeys(origin, ['sourceRef', 'controllerRef', 'runId', 'correlation']) &&
    sha.test(origin.sourceRef) &&
    sha.test(origin.controllerRef) &&
    /^[1-9][0-9]*$/.test(origin.runId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(origin.correlation)
  );
}

function validTarget(target) {
  return (
    exactKeys(target, ['subscriptionId', 'resourceGroup', 'environment', 'functionAppId', 'releaseStorageAccount']) &&
    /^[0-9a-f-]{36}$/i.test(target.subscriptionId) &&
    target.environment === 'prod' &&
    /^[A-Za-z0-9._()-]{1,90}$/.test(target.resourceGroup) &&
    /^[a-z0-9]{3,24}$/.test(target.releaseStorageAccount) &&
    typeof target.functionAppId === 'string' &&
    target.functionAppId
      .toLowerCase()
      .startsWith(
        `/subscriptions/${target.subscriptionId}/resourcegroups/${target.resourceGroup}/providers/microsoft.web/sites/`.toLowerCase(),
      )
  );
}

function validInventory(inventory, target) {
  if (!Array.isArray(inventory) || inventory.length < 1 || inventory.length > 200) return false;
  const scope =
    `/subscriptions/${target.subscriptionId}/resourcegroups/${target.resourceGroup}/providers/`.toLowerCase();
  const ids = new Set();
  return inventory.every((item) => {
    if (
      !exactKeys(item, ['id', 'type']) ||
      typeof item.id !== 'string' ||
      typeof item.type !== 'string' ||
      !item.id.toLowerCase().startsWith(scope) ||
      !/^Microsoft\.[A-Za-z]+\/[A-Za-z/]+$/.test(item.type)
    )
      return false;
    const id = item.id.toLowerCase();
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

export function validateObservedConfiguration(observed, now = Date.now()) {
  const errors = [];
  if (!exactKeys(observed, ['site', 'web', 'managedSettings', 'secrets', 'roles', 'retentionPolicy']))
    return ['Observed configuration is incomplete.'];
  for (const key of ['site', 'web', 'managedSettings', 'roles', 'retentionPolicy'])
    if (!object(observed[key])) errors.push(`Observed ${key} is missing.`);
  if (!Array.isArray(observed.retentionPolicy?.rules) || observed.retentionPolicy.rules.length === 0)
    errors.push('Observed retention rules are missing.');
  if (!observed.site?.identity?.principalId || !observed.site?.identity?.tenantId)
    errors.push('Function identity is missing.');
  if (!Array.isArray(observed.secrets) || observed.secrets.length === 0) errors.push('Secret metadata is missing.');
  const names = new Set();
  for (const secret of Array.isArray(observed.secrets) ? observed.secrets : []) {
    if (
      !exactKeys(secret, ['name', 'versionUri', 'attributes']) ||
      !/^[a-z0-9-]+$/.test(secret.name) ||
      names.has(secret.name) ||
      !/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-z0-9-]+\/[0-9a-f]{32}$/i.test(secret.versionUri)
    ) {
      errors.push('Secret metadata identity is invalid.');
      continue;
    }
    names.add(secret.name);
    const attributes = secret.attributes;
    if (!object(attributes) || attributes.enabled !== true)
      errors.push('A required secret is disabled or unverifiable.');
    for (const [field, direction] of [
      ['nbf', 1],
      ['exp', -1],
    ]) {
      const time = attributes?.[field];
      if (
        time !== undefined &&
        time !== null &&
        (!Number.isFinite(time) || (direction === 1 ? time * 1000 > now : time * 1000 <= now))
      )
        errors.push('A required secret is outside its validity interval.');
    }
    if (!Object.values(observed.managedSettings ?? {}).includes(`@Microsoft.KeyVault(SecretUri=${secret.versionUri})`))
      errors.push('Secret version is not bound to installed managed settings.');
  }
  return errors;
}

/** Private comparison material: never stage this record with public release artifacts. */
export function createDeploymentConfiguration({
  parameters,
  compiledTemplate,
  toolchain,
  target,
  origin,
  inventory,
  observed,
  now,
}) {
  if (!validTarget(target) || !validOrigin(origin) || !validInventory(inventory, target))
    throw new Error('Accepted configuration identity is invalid.');
  if (validateObservedConfiguration(observed, now).length) throw new Error('Observed configuration is not acceptable.');
  if (!equal(parameters.releaseRetentionPolicy.value, observed.retentionPolicy))
    throw new Error('Installed retention policy differs from the intended transition.');
  const key = randomBytes(32);
  return {
    schemaVersion: 1,
    origin,
    target,
    templateSha256: hash(compiledTemplate),
    toolchain,
    comparisonKey: key.toString('base64'),
    inputCommitment: commitment(parameters, key),
    inventory: [...inventory].sort((a, b) => a.id.localeCompare(b.id)),
    observed,
  };
}

export function configurationPointer({ target, origin, versionId, sha256, size }) {
  const pointer = {
    account: target.releaseStorageAccount,
    container: 'function-releases',
    blob: `accepted/${origin.controllerRef}/${origin.runId}/1/promotion/deployment-configuration.json`,
    versionId,
    sha256,
    size,
  };
  if (!validTarget(target) || !validOrigin(origin) || validateConfigurationPointer(pointer, { target, origin }).length)
    throw new Error('Private configuration pointer is invalid.');
  return pointer;
}

export function validateConfigurationPointer(pointer, { target, origin } = {}) {
  const errors = [];
  if (!exactKeys(pointer, ['account', 'container', 'blob', 'versionId', 'sha256', 'size']))
    return ['Configuration pointer schema is invalid.'];
  if (
    !/^[a-z0-9]{3,24}$/.test(pointer.account) ||
    pointer.container !== 'function-releases' ||
    !/^accepted\/[0-9a-f]{40}\/[1-9][0-9]*\/1\/promotion\/deployment-configuration\.json$/.test(pointer.blob) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test(pointer.versionId) ||
    !digest.test(pointer.sha256) ||
    !Number.isSafeInteger(pointer.size) ||
    pointer.size <= 0 ||
    pointer.size > 2 * 1024 * 1024
  )
    errors.push('Configuration pointer coordinates are invalid.');
  if (target && pointer.account !== target.releaseStorageAccount)
    errors.push('Configuration storage does not match the production target.');
  if (
    origin &&
    pointer.blob !== `accepted/${origin.controllerRef}/${origin.runId}/1/promotion/deployment-configuration.json`
  )
    errors.push('Configuration pointer does not match accepted origin.');
  return errors;
}

/** Verify immutable bytes before parsing comparison material or trusting any payload field. */
export function verifyDeploymentConfiguration({ bytes, pointer, target, origin }) {
  if (
    !validTarget(target) ||
    !validOrigin(origin) ||
    validateConfigurationPointer(pointer, { target, origin }).length ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== pointer.size ||
    hash(bytes) !== pointer.sha256
  )
    throw new Error('Private configuration byte binding failed.');
  const record = JSON.parse(Buffer.from(bytes));
  if (
    !exactKeys(record, [
      'schemaVersion',
      'origin',
      'target',
      'templateSha256',
      'toolchain',
      'comparisonKey',
      'inputCommitment',
      'inventory',
      'observed',
    ]) ||
    record.schemaVersion !== 1 ||
    !equal(record.target, target) ||
    !equal(record.origin, origin) ||
    !digest.test(record.templateSha256) ||
    !digest.test(record.inputCommitment) ||
    typeof record.comparisonKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(record.comparisonKey) ||
    Buffer.from(record.comparisonKey, 'base64').length !== 32 ||
    !validInventory(record.inventory, target) ||
    !object(record.toolchain) ||
    validateObservedConfiguration(record.observed).length
  )
    throw new Error('Private accepted configuration is incompatible.');
  return record;
}

function deltaPaths(delta, prefix = '') {
  if (!Array.isArray(delta) || delta.length === 0) return null;
  const paths = [];
  for (const item of delta) {
    if (
      !object(item) ||
      typeof item.path !== 'string' ||
      !item.path ||
      !['Modify', 'Array', 'Create', 'Delete'].includes(item.propertyChangeType)
    )
      return null;
    const path = prefix ? `${prefix}.${item.path}` : item.path;
    if (item.children !== undefined) {
      const children = deltaPaths(item.children, path);
      if (!children) return null;
      paths.push(...children);
    } else paths.push({ path, kind: item.propertyChangeType });
  }
  return paths;
}

function whatIfErrors(whatIf, record, parameters) {
  const errors = [];
  if (whatIf?.status !== 'Succeeded' || !Array.isArray(whatIf.changes) || whatIf.error)
    return ['Whole-template what-if is unavailable or incomplete.'];
  const expected = new Map(record.inventory.map((item) => [item.id.toLowerCase(), item]));
  const seen = new Set();
  const retentionId =
    `/subscriptions/${record.target.subscriptionId}/resourcegroups/${record.target.resourceGroup}/providers/microsoft.storage/storageaccounts/${record.target.releaseStorageAccount}/managementpolicies/default`.toLowerCase();
  for (const change of whatIf.changes) {
    const id = typeof change?.resourceId === 'string' ? change.resourceId.toLowerCase() : '';
    const resource = expected.get(id);
    if (!resource || seen.has(id)) {
      errors.push('What-if resource coverage is unexpected or duplicated.');
      continue;
    }
    seen.add(id);
    if (change.changeType === 'NoChange' && (!change.delta || change.delta.length === 0)) {
      if (id === retentionId && !equal(record.observed.retentionPolicy, parameters.releaseRetentionPolicy.value))
        errors.push('What-if does not prove the required retention transition.');
      continue;
    }
    if (change.changeType !== 'Modify') {
      errors.push('What-if contains an unresolved or changing managed resource.');
      continue;
    }
    const paths = deltaPaths(change.delta);
    if (!paths) {
      errors.push('What-if modification has no complete property evidence.');
      continue;
    }
    if (
      id === retentionId &&
      equal(change.before?.properties?.policy, record.observed.retentionPolicy) &&
      equal(change.after?.properties?.policy, parameters.releaseRetentionPolicy.value) &&
      paths.every(({ path }) => path === 'properties.policy' || path.startsWith('properties.policy.'))
    )
      continue;
    const type = resource.type.toLowerCase();
    const allowed =
      type === 'microsoft.keyvault/vaults/secrets'
        ? 'properties.value'
        : type === 'microsoft.authorization/roleassignments' && object(record.observed.roles[id])
          ? 'properties.principalId'
          : id === `${record.target.functionAppId.toLowerCase()}/config/appsettings`
            ? 'properties'
            : null;
    if (!allowed || !paths.every(({ path, kind }) => path === allowed && kind === 'Modify'))
      errors.push('What-if contains a change outside verified reference substitutions.');
  }
  if (seen.size !== expected.size) errors.push('What-if omits managed resources, including nested children.');
  return errors;
}

/** Missing or uncertain evidence selects full reconciliation; this never authorizes a write by itself. */
export function applicationOnlyPreconditions({
  record,
  parameters,
  compiledTemplate,
  toolchain,
  target,
  observed,
  reconcileConfiguration = false,
  now,
}) {
  const reasons = [];
  try {
    if (reconcileConfiguration) reasons.push('Explicit configuration recovery requires full reconciliation.');
    if (!record || record.schemaVersion !== 1 || !equal(record.target, target))
      reasons.push('Accepted configuration baseline is unavailable.');
    else {
      if (record.templateSha256 !== hash(compiledTemplate) || !equal(record.toolchain, toolchain))
        reasons.push('Template or toolchain changed.');
      const actual = commitment(parameters, Buffer.from(record.comparisonKey, 'base64'));
      if (
        !digest.test(record.inputCommitment) ||
        !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(record.inputCommitment, 'hex'))
      )
        reasons.push('Effective deployment inputs changed.');
      reasons.push(...validateObservedConfiguration(observed, now));
      if (!equal(record.observed, observed))
        reasons.push('Installed configuration or identity drifted from accepted state.');
    }
  } catch {
    reasons.push('Configuration comparison evidence is malformed or incomplete.');
  }
  return [...new Set(reasons)];
}

export function decideApplicationOnly(inputs) {
  const reasons = applicationOnlyPreconditions(inputs);
  if (reasons.length === 0) {
    try {
      reasons.push(...whatIfErrors(inputs.whatIf, inputs.record, inputs.parameters));
    } catch {
      reasons.push('Whole-template what-if is malformed or incomplete.');
    }
  }
  return { mode: reasons.length ? 'full' : 'application-only', reasons: [...new Set(reasons)] };
}
