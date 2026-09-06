import { createHash } from 'node:crypto';
import { compareFrontendInventories, validateFrontendInventory } from '../frontend-inventory.mjs';

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const runIdPattern = /^[1-9][0-9]*$/;
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export function parseImmutablePackagePointer(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('WEBSITE_RUN_FROM_PACKAGE must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('WEBSITE_RUN_FROM_PACKAGE must be an anonymous HTTPS Azure Blob URL');
  }
  const hostMatch = /^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/.exec(parsed.hostname);
  if (!hostMatch) throw new Error('WEBSITE_RUN_FROM_PACKAGE must use an Azure Blob storage hostname');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) throw new Error('WEBSITE_RUN_FROM_PACKAGE must identify one container and blob');
  const [containerName, blobName] = segments.map(decodeURIComponent);
  const blobMatch = /^functionapp-([0-9a-f]{64})\.zip$/.exec(blobName);
  if (!blobMatch) throw new Error('WEBSITE_RUN_FROM_PACKAGE must use a digest-addressed Function package');
  const queryKeys = [...parsed.searchParams.keys()];
  if (queryKeys.length !== 1 || queryKeys[0].toLowerCase() !== 'versionid') {
    throw new Error('WEBSITE_RUN_FROM_PACKAGE must contain only one immutable versionid');
  }
  const versionId = parsed.searchParams.get(queryKeys[0]);
  if (!versionId || parsed.searchParams.getAll(queryKeys[0]).length !== 1) {
    throw new Error('WEBSITE_RUN_FROM_PACKAGE versionid is missing or ambiguous');
  }
  return {
    storageAccountName: hostMatch[1],
    containerName,
    blobName,
    versionId,
    functionDigest: blobMatch[1],
  };
}

export function observeProductionState({
  appSettings,
  frontendMetadata,
  frontendMetadataBytes,
  frontendInventory,
  health = { status: 'unavailable' },
  packageContentSha256,
  resource = {},
}) {
  const errors = [];
  const settings = settingsMap(appSettings, errors);
  const sourceRef = lower(settings.DEPLOYED_SOURCE_REF);
  const deployedCommit = lower(settings.DEPLOYED_COMMIT_SHA);
  const runId = String(settings.DEPLOYMENT_RUN_ID ?? '');
  const deliveryCorrelation = String(settings.DELIVERY_CORRELATION ?? '');
  const mutationReceiptValues = [
    settings.DELIVERY_MUTATION_RUN_ID,
    settings.DELIVERY_MUTATION_CORRELATION,
    settings.DELIVERY_MUTATION_CONTROLLER_SHA,
    settings.DELIVERY_MUTATION_KIND,
  ];
  const mutationReceiptRecorded = mutationReceiptValues.some((value) => value !== undefined && value !== '');
  const mutationReceipt = mutationReceiptRecorded
    ? {
        recorded: true,
        runId: String(settings.DELIVERY_MUTATION_RUN_ID ?? ''),
        correlation: String(settings.DELIVERY_MUTATION_CORRELATION ?? ''),
        controllerRef: lower(settings.DELIVERY_MUTATION_CONTROLLER_SHA),
        kind: String(settings.DELIVERY_MUTATION_KIND ?? ''),
      }
    : {
        recorded: false,
        runId,
        correlation: deliveryCorrelation,
        controllerRef: sourceRef,
        kind: 'legacy-release',
      };
  const digests = {
    function: lower(settings.RELEASE_FUNCTION_SHA256),
    renderedFrontend: lower(settings.RELEASE_FRONTEND_SHA256),
    sbom: lower(settings.RELEASE_SBOM_SHA256),
  };

  requirePattern(sourceRef, shaPattern, 'DEPLOYED_SOURCE_REF', errors);
  requirePattern(deployedCommit, shaPattern, 'DEPLOYED_COMMIT_SHA', errors);
  if (sourceRef && deployedCommit && sourceRef !== deployedCommit) {
    errors.push('Function deployed source and commit settings disagree');
  }
  requirePattern(runId, runIdPattern, 'DEPLOYMENT_RUN_ID', errors);
  for (const [name, digest] of Object.entries(digests)) {
    requirePattern(digest, digestPattern, `Function ${name} digest`, errors);
  }
  if (deliveryCorrelation && !correlationPattern.test(deliveryCorrelation)) {
    errors.push('Function delivery correlation is invalid');
  }
  requirePattern(mutationReceipt.runId, runIdPattern, 'Production mutation receipt run ID', errors);
  if (mutationReceipt.recorded) {
    requirePattern(mutationReceipt.correlation, correlationPattern, 'Production mutation receipt correlation', errors);
    requirePattern(mutationReceipt.controllerRef, shaPattern, 'Production mutation receipt controller SHA', errors);
  }
  if (!['legacy-release', 'promotion', 'recovery'].includes(mutationReceipt.kind)) {
    errors.push('Production mutation receipt kind is invalid');
  }
  if (settings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID !== 'SystemAssigned') {
    errors.push('Function package pointer must use the system-assigned managed identity');
  }

  let packageIdentity = null;
  try {
    packageIdentity = parseImmutablePackagePointer(settings.WEBSITE_RUN_FROM_PACKAGE);
    if (digests.function && packageIdentity.functionDigest !== digests.function) {
      errors.push('Function package pointer digest disagrees with the release setting');
    }
  } catch (error) {
    errors.push(error.message);
  }
  const observedPackageDigest = lower(packageContentSha256);
  requirePattern(observedPackageDigest, digestPattern, 'Downloaded Function package digest', errors);
  if (digests.function && observedPackageDigest && digests.function !== observedPackageDigest) {
    errors.push('Downloaded immutable Function package bytes disagree with the release setting');
  }

  const frontendSourceRef = lower(frontendMetadata?.deployedCommitSha);
  const frontendRunId = String(frontendMetadata?.deploymentRunId ?? '');
  const frontendCorrelation = String(frontendMetadata?.deliveryCorrelation ?? '');
  const frontendEnvironment = String(frontendMetadata?.environmentName ?? '');
  requirePattern(frontendSourceRef, shaPattern, 'Frontend deployed source', errors);
  requirePattern(frontendRunId, runIdPattern, 'Frontend deployment run ID', errors);
  if (frontendEnvironment !== 'prod') errors.push('Frontend identity must report the production environment');
  if (sourceRef && frontendSourceRef && sourceRef !== frontendSourceRef) {
    errors.push('Function and frontend source identities disagree');
  }
  if (runId && frontendRunId && runId !== frontendRunId) {
    errors.push('Function and frontend deployment run identities disagree');
  }
  if (deliveryCorrelation && frontendCorrelation && deliveryCorrelation !== frontendCorrelation) {
    errors.push('Function and frontend delivery correlations disagree');
  }
  const metadataBytes = Buffer.isBuffer(frontendMetadataBytes)
    ? frontendMetadataBytes
    : Buffer.from(frontendMetadataBytes ?? '');
  const frontendMetadataSha256 = createHash('sha256').update(metadataBytes).digest('hex');
  if (metadataBytes.length === 0) errors.push('Frontend build metadata bytes are missing');
  let frontendInventorySha256 = '';
  let normalizedFrontendInventory = null;
  try {
    normalizedFrontendInventory = validateFrontendInventory(frontendInventory);
    frontendInventorySha256 = hashFrontendInventory(normalizedFrontendInventory);
  } catch (error) {
    errors.push(error.message);
  }

  const healthResult = normalizeHealth(health, errors);
  if (healthResult.status === 'available' && sourceRef && healthResult.sourceRef !== sourceRef) {
    errors.push('Health and installed Function source identities disagree');
  }

  if (resource.environmentName !== 'prod') errors.push('Observed resource must be the production environment');
  if (!resource.resourceGroup) errors.push('Observed production resource group is missing');
  if (!resource.functionAppName) errors.push('Observed production Function App name is missing');
  if (!resource.staticStorageAccountName) errors.push('Observed production static storage account is missing');
  if (
    packageIdentity &&
    resource.releaseStorageAccountName &&
    packageIdentity.storageAccountName !== resource.releaseStorageAccountName
  ) {
    errors.push('Function package pointer uses an unexpected release storage account');
  }

  const functionIdentity = {
    sourceRef,
    runId,
    deliveryCorrelation: deliveryCorrelation || null,
    digests,
    package: packageIdentity ? { ...packageIdentity, contentSha256: observedPackageDigest } : null,
  };
  const frontendIdentity = {
    sourceRef: frontendSourceRef,
    runId: frontendRunId,
    deliveryCorrelation: frontendCorrelation || null,
    metadataSha256: frontendMetadataSha256,
    inventorySha256: frontendInventorySha256,
    inventory: normalizedFrontendInventory,
  };
  const coherent =
    errors.length === 0 &&
    sourceRef === frontendSourceRef &&
    runId === frontendRunId &&
    (!deliveryCorrelation || !frontendCorrelation || deliveryCorrelation === frontendCorrelation);

  const partial =
    !coherent &&
    recognizablePartialState(functionIdentity, frontendIdentity) &&
    errors.every((error) => error.startsWith('Function and frontend '));
  return {
    ok: coherent,
    state: coherent ? 'coherent' : partial ? 'partial' : 'invalid',
    errors,
    identity: {
      sourceRef: coherent ? sourceRef : null,
      runId: coherent ? runId : null,
      deliveryCorrelation: coherent ? deliveryCorrelation || frontendCorrelation || null : null,
      function: functionIdentity,
      frontend: frontendIdentity,
      health: healthResult,
      resource: { ...resource },
      mutationReceipt,
    },
  };
}

export function decidePromotionGuard({
  candidateSourceRef,
  currentMainRef,
  recoveryReady,
  acceptedIdentity,
  observed,
}) {
  assertSha(candidateSourceRef, 'candidateSourceRef');
  assertSha(currentMainRef, 'currentMainRef');
  if (currentMainRef !== candidateSourceRef) {
    return decision('superseded', false, { supersededBy: currentMainRef, reason: 'current-main-advanced' });
  }
  if (!recoveryReady) return decision('blocked', false, { reason: 'recovery-bundle-not-ready' });
  if (!observed?.ok || observed?.state !== 'coherent') {
    return decision('blocked', false, { reason: 'production-observation-invalid' });
  }
  if (!matchesAcceptedProduction(acceptedIdentity, observed.identity)) {
    return decision('blocked', false, { reason: 'production-advanced-or-ambiguous' });
  }
  return decision('proceed', true, { reason: 'accepted-production-still-installed' });
}

export function decideRollbackGuard({
  acceptedIdentity,
  failedIntent,
  observed,
  rollbackAlreadyAttempted = false,
  reconcileConfiguration = false,
  currentMainRef,
  failedControllerRef,
}) {
  assertSha(currentMainRef, 'currentMainRef');
  assertSha(failedControllerRef, 'failedControllerRef');
  if (rollbackAlreadyAttempted) {
    return decision('blocked', false, { reason: 'rollback-already-attempted', configurationUncertain: true });
  }
  if (
    failedIntent?.persistedBeforeWrite !== true ||
    !['intent-recorded', 'application-ready'].includes(failedIntent?.phase)
  ) {
    return decision('blocked', false, {
      reason: 'production-mutation-evidence-invalid',
      configurationUncertain: true,
    });
  }
  if (!['coherent', 'partial'].includes(observed?.state)) {
    return decision('blocked', false, {
      reason: 'production-observation-invalid',
      configurationUncertain: Boolean(failedIntent?.configurationMayChange),
    });
  }
  const observedIdentity = observed.identity;
  const functionState = componentState(
    acceptedIdentity?.function,
    failedIntent?.expectedIdentity?.function,
    observedIdentity?.function,
    functionMatches,
  );
  const frontendState = frontendComponentState(
    acceptedIdentity?.frontend,
    failedIntent?.expectedIdentity?.frontend,
    observedIdentity?.frontend,
  );
  const componentStates = { function: functionState, frontend: frontendState };
  const configurationUncertain = Boolean(failedIntent?.configurationMayChange && failedIntent?.persistedBeforeWrite);
  if (Object.values(componentStates).includes('unknown')) {
    return decision('blocked', false, {
      reason: 'production-advanced-or-ambiguous',
      componentStates,
      configurationUncertain,
    });
  }
  if (Object.values(componentStates).every((state) => state === 'accepted')) {
    if (
      configurationUncertain &&
      reconcileConfiguration &&
      mutationReceiptMatches(failedIntent.expectedIdentity?.mutationReceipt, observedIdentity?.mutationReceipt)
    ) {
      return decision('configuration-reconciliation-required', true, {
        reason: 'explicit-reconciliation-of-exact-failed-mutation',
        componentStates,
        configurationUncertain: true,
      });
    }
    if (
      !configurationUncertain &&
      mutationReceiptMatches(failedIntent.expectedIdentity?.mutationReceipt, observedIdentity?.mutationReceipt)
    ) {
      return decision('failed-receipt-observed', true, {
        reason: 'failed-mutation-receipt-requires-verified-recovery',
        componentStates,
        configurationUncertain: false,
        mainAdvanced: currentMainRef !== failedControllerRef,
      });
    }
    if (!configurationUncertain && observedIdentity?.mutationReceipt?.kind === 'recovery') {
      return decision('recovery-observed', false, {
        reason: 'original-bundle-restored-with-recovery-receipt',
        componentStates,
        configurationUncertain: false,
        mainAdvanced: currentMainRef !== failedControllerRef,
      });
    }
    return decision(configurationUncertain ? 'configuration-uncertain' : 'production-unchanged', false, {
      reason: 'accepted-production-still-installed',
      componentStates,
      configurationUncertain,
      mainAdvanced: currentMainRef !== failedControllerRef,
    });
  }
  if (!mutationReceiptMatches(failedIntent.expectedIdentity?.mutationReceipt, observedIdentity?.mutationReceipt)) {
    return decision('blocked', false, {
      reason: 'failed-mutation-not-attributed',
      componentStates,
      configurationUncertain,
    });
  }
  return decision(
    Object.values(componentStates).every((state) => state === 'failed')
      ? 'failed-release-observed'
      : 'partial-release-observed',
    true,
    {
      reason: 'failed-mutation-state-is-bounded',
      componentStates,
      configurationUncertain,
      mainAdvanced: currentMainRef !== failedControllerRef,
    },
  );
}

export function matchesAcceptedProduction(expected, observed) {
  return (
    functionMatches(expected?.function, observed?.function) &&
    frontendMatches(expected?.frontend, observed?.frontend) &&
    mutationReceiptMatches(expected?.mutationReceipt, observed?.mutationReceipt)
  );
}

export function mutationReceiptMatches(expected, actual) {
  if (!expected || !actual) return false;
  return (
    expected.recorded === actual.recorded &&
    String(expected.runId) === String(actual.runId) &&
    expected.correlation === actual.correlation &&
    expected.controllerRef === actual.controllerRef &&
    expected.kind === actual.kind
  );
}

export function functionMatches(expected, actual) {
  if (!expected || !actual) return false;
  return (
    expected.sourceRef === actual.sourceRef &&
    String(expected.runId) === String(actual.runId) &&
    expected.digests?.function === actual.digests?.function &&
    expected.digests?.renderedFrontend === actual.digests?.renderedFrontend &&
    expected.digests?.sbom === actual.digests?.sbom &&
    expected.package?.functionDigest === actual.package?.functionDigest &&
    expected.package?.contentSha256 === actual.package?.contentSha256 &&
    expected.package?.storageAccountName === actual.package?.storageAccountName &&
    expected.package?.containerName === actual.package?.containerName &&
    expected.package?.blobName === actual.package?.blobName &&
    (!expected.package?.versionId || expected.package.versionId === actual.package?.versionId)
  );
}

export function frontendMatches(expected, actual) {
  if (!expected || !actual) return false;
  const inventoryMatches =
    expected.inventory && actual.inventory
      ? compareFrontendInventories(expected.inventory, actual.inventory).ok
      : expected.inventorySha256 === actual.inventorySha256;
  return (
    expected.sourceRef === actual.sourceRef &&
    String(expected.runId) === String(actual.runId) &&
    expected.metadataSha256 === actual.metadataSha256 &&
    inventoryMatches
  );
}

function frontendComponentState(accepted, failed, observed) {
  if (frontendMatches(accepted, observed)) return 'accepted';
  if (frontendMatches(failed, observed)) return 'failed';
  if (isBoundedFrontendTransition(accepted, failed, observed)) return 'partial';
  return 'unknown';
}

export function isBoundedFrontendTransition(accepted, failed, observed) {
  if (!accepted?.inventory || !failed?.inventory || !observed?.inventory) return false;
  let acceptedInventory;
  let failedInventory;
  let observedInventory;
  try {
    acceptedInventory = validateFrontendInventory(accepted.inventory);
    failedInventory = validateFrontendInventory(failed.inventory);
    observedInventory = validateFrontendInventory(observed.inventory);
  } catch {
    return false;
  }
  const permitted = new Map();
  for (const file of [...acceptedInventory.files, ...failedInventory.files]) {
    const identities = permitted.get(file.name) ?? new Set();
    identities.add(`${file.size}:${file.sha256}`);
    permitted.set(file.name, identities);
  }
  const observedNames = new Set(observedInventory.files.map((file) => file.name));
  const candidateNames = new Set(failedInventory.files.map((file) => file.name));
  if (acceptedInventory.files.some((file) => candidateNames.has(file.name) && !observedNames.has(file.name))) {
    return false;
  }
  return observedInventory.files.every((file) => permitted.get(file.name)?.has(`${file.size}:${file.sha256}`));
}

function componentState(accepted, failed, observed, compare) {
  if (compare(accepted, observed)) return 'accepted';
  if (compare(failed, observed)) return 'failed';
  return 'unknown';
}

function decision(state, mutate, details) {
  return { state, mutate, ...details };
}

function normalizeHealth(health, errors) {
  if (health?.status === 'unavailable') return { status: 'unavailable', sourceRef: null };
  if (health?.status !== 'available') {
    errors.push('Health observation status is invalid');
    return { status: 'invalid', sourceRef: null };
  }
  const sourceRef = lower(health.body?.deployedSourceRef || health.body?.deployedCommitSha);
  if (!shaPattern.test(sourceRef)) {
    errors.push('Available health response lacks an immutable source identity');
    return { status: 'invalid', sourceRef: null };
  }
  return { status: 'available', sourceRef };
}

function settingsMap(appSettings, errors) {
  if (!Array.isArray(appSettings)) {
    errors.push('Azure app settings response must be an array');
    return {};
  }
  const result = {};
  for (const entry of appSettings) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      errors.push('Azure app settings response contains invalid entries');
      continue;
    }
    if (entry.name in result) errors.push(`Azure app setting is duplicated: ${entry.name}`);
    result[entry.name] = entry.value;
  }
  return result;
}

function recognizablePartialState(functionIdentity, frontendIdentity) {
  return (
    shaPattern.test(functionIdentity.sourceRef) &&
    runIdPattern.test(functionIdentity.runId) &&
    shaPattern.test(frontendIdentity.sourceRef) &&
    runIdPattern.test(frontendIdentity.runId)
  );
}

export function hashFrontendInventory(inventory) {
  const validated = validateFrontendInventory(inventory);
  return createHash('sha256').update(JSON.stringify(validated)).digest('hex');
}

function requirePattern(value, pattern, name, errors) {
  if (!pattern.test(value ?? '')) errors.push(`${name} is missing or invalid`);
}

function assertSha(value, name) {
  if (!shaPattern.test(value ?? '')) throw new Error(`${name} must be a lowercase 40-character SHA`);
}

function lower(value) {
  return String(value ?? '').toLowerCase();
}
