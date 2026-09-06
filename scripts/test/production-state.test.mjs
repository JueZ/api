import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  decidePromotionGuard,
  decideRollbackGuard,
  isBoundedFrontendTransition,
  observeProductionState,
  parseImmutablePackagePointer,
} from '../lib/production-state.mjs';

const acceptedSha = 'a'.repeat(40);
const failedSha = 'b'.repeat(40);
const newerSha = 'c'.repeat(40);
const functionDigest = '1'.repeat(64);
const frontendDigest = '2'.repeat(64);
const sbomDigest = '3'.repeat(64);

function observation(overrides = {}) {
  const sourceRef = overrides.functionSource ?? acceptedSha;
  const frontendSource = overrides.frontendSource ?? sourceRef;
  const runId = overrides.functionRun ?? '123';
  const frontendRun = overrides.frontendRun ?? runId;
  const packageDigest = overrides.packageDigest ?? functionDigest;
  const correlation = overrides.correlation ?? 'prod-123-1';
  const metadata = {
    service: 'api-catalogue-web',
    deployedCommitSha: frontendSource,
    environmentName: overrides.frontendEnvironment ?? 'prod',
    deploymentRunId: frontendRun,
    deliveryCorrelation: correlation,
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata)}\n`);
  const frontendInventory = {
    schemaVersion: 1,
    files: [
      {
        name: 'assets/build-info.json',
        sha256: createHash('sha256').update(metadataBytes).digest('hex'),
        size: metadataBytes.length,
      },
    ],
  };
  const appSettings = [
    { name: 'DEPLOYED_SOURCE_REF', value: sourceRef },
    { name: 'DEPLOYED_COMMIT_SHA', value: sourceRef },
    { name: 'DEPLOYMENT_RUN_ID', value: runId },
    { name: 'DELIVERY_CORRELATION', value: correlation },
    { name: 'RELEASE_FUNCTION_SHA256', value: functionDigest },
    { name: 'RELEASE_FRONTEND_SHA256', value: frontendDigest },
    { name: 'RELEASE_SBOM_SHA256', value: sbomDigest },
    {
      name: 'WEBSITE_RUN_FROM_PACKAGE',
      value: `https://releaseacct.blob.core.windows.net/function-releases/functionapp-${functionDigest}.zip?versionid=v1`,
    },
    { name: 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID', value: 'SystemAssigned' },
  ];
  if (overrides.mutationReceipt) {
    appSettings.push(
      { name: 'DELIVERY_MUTATION_RUN_ID', value: overrides.mutationReceipt.runId },
      { name: 'DELIVERY_MUTATION_CORRELATION', value: overrides.mutationReceipt.correlation },
      { name: 'DELIVERY_MUTATION_CONTROLLER_SHA', value: overrides.mutationReceipt.controllerRef },
      { name: 'DELIVERY_MUTATION_KIND', value: overrides.mutationReceipt.kind },
    );
  }
  return observeProductionState({
    appSettings,
    frontendMetadata: metadata,
    frontendMetadataBytes: metadataBytes,
    frontendInventory,
    health:
      overrides.health === 'unavailable'
        ? { status: 'unavailable' }
        : { status: 'available', body: { deployedSourceRef: overrides.healthSource ?? sourceRef } },
    packageContentSha256: packageDigest,
    resource: {
      environmentName: 'prod',
      resourceGroup: 'rg-api-prod',
      functionAppName: 'func-prod',
      staticStorageAccountName: 'staticprod',
      releaseStorageAccountName: 'releaseacct',
    },
  });
}

test('immutable package pointer requires a digest-addressed version and managed Azure Blob shape', () => {
  const parsed = parseImmutablePackagePointer(
    `https://releaseacct.blob.core.windows.net/function-releases/functionapp-${functionDigest}.zip?versionid=v1`,
  );
  assert.equal(parsed.functionDigest, functionDigest);
  assert.equal(parsed.versionId, 'v1');
  assert.throws(
    () =>
      parseImmutablePackagePointer(
        `https://releaseacct.blob.core.windows.net/function-releases/functionapp-${functionDigest}.zip`,
      ),
    /versionid/,
  );
});

test('health unavailability does not block coherent control-plane package and frontend identity', () => {
  const result = observation({ health: 'unavailable' });
  assert.equal(result.ok, true);
  assert.equal(result.identity.health.status, 'unavailable');
});

test('health disagreement fails closed even when package and frontend agree', () => {
  const result = observation({ healthSource: failedSha });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Health and installed Function source identities disagree/);
});

test('a new unverified mutation receipt prevents same-byte production from matching the accepted baseline', () => {
  const accepted = observation().identity;
  const observed = observation({
    mutationReceipt: {
      runId: '456',
      correlation: 'prod-456-1',
      controllerRef: failedSha,
      kind: 'promotion',
    },
  });
  assert.equal(observed.ok, true);
  const decision = decidePromotionGuard({
    candidateSourceRef: failedSha,
    currentMainRef: failedSha,
    recoveryReady: true,
    acceptedIdentity: accepted,
    observed,
  });
  assert.equal(decision.reason, 'production-advanced-or-ambiguous');
  assert.equal(decision.mutate, false);
});

test('downloaded package mismatch fails with and without health', () => {
  for (const health of ['available', 'unavailable']) {
    const result = observation({ health, packageDigest: '9'.repeat(64) });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /package bytes disagree/);
  }
});

test('package and frontend source disagreement is retained as a recognizable partial state', () => {
  const result = observation({ frontendSource: failedSha });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'partial');
  assert.equal(result.identity.function.sourceRef, acceptedSha);
  assert.equal(result.identity.frontend.sourceRef, failedSha);
});

test('promotion guard supersedes stale main before considering production state', () => {
  const accepted = observation().identity;
  const result = decidePromotionGuard({
    candidateSourceRef: failedSha,
    currentMainRef: newerSha,
    recoveryReady: true,
    acceptedIdentity: accepted,
    observed: observation({ functionSource: newerSha, frontendSource: newerSha }),
  });
  assert.deepEqual(result, {
    state: 'superseded',
    mutate: false,
    supersededBy: newerSha,
    reason: 'current-main-advanced',
  });
});

test('promotion guard blocks an unexpected production advance and missing recovery readiness', () => {
  const accepted = observation().identity;
  assert.equal(
    decidePromotionGuard({
      candidateSourceRef: failedSha,
      currentMainRef: failedSha,
      recoveryReady: false,
      acceptedIdentity: accepted,
      observed: observation(),
    }).state,
    'blocked',
  );
  assert.equal(
    decidePromotionGuard({
      candidateSourceRef: failedSha,
      currentMainRef: failedSha,
      recoveryReady: true,
      acceptedIdentity: accepted,
      observed: observation({ functionSource: newerSha, frontendSource: newerSha }),
    }).reason,
    'production-advanced-or-ambiguous',
  );
});

test('rollback restores failed and known partial state once but never newer state', () => {
  const accepted = observation().identity;
  const failed = observation({ functionSource: failedSha, frontendSource: failedSha, functionRun: '456' }).identity;
  const failedIntent = {
    phase: 'application-ready',
    persistedBeforeWrite: true,
    configurationMayChange: true,
    expectedIdentity: failed,
  };
  const full = decideRollbackGuard({
    acceptedIdentity: accepted,
    failedIntent,
    observed: observation({ functionSource: failedSha, frontendSource: failedSha, functionRun: '456' }),
    currentMainRef: failedSha,
    failedControllerRef: failedSha,
  });
  assert.equal(full.state, 'failed-release-observed');
  assert.equal(full.mutate, true);
  assert.equal(full.configurationUncertain, true);

  const partial = decideRollbackGuard({
    acceptedIdentity: accepted,
    failedIntent,
    observed: {
      ok: false,
      state: 'partial',
      identity: { function: failed.function, frontend: accepted.frontend, mutationReceipt: failed.mutationReceipt },
    },
    currentMainRef: failedSha,
    failedControllerRef: failedSha,
  });
  assert.equal(partial.state, 'partial-release-observed');
  assert.equal(partial.mutate, true);

  assert.equal(
    decideRollbackGuard({
      acceptedIdentity: accepted,
      failedIntent,
      observed: observation({ functionSource: newerSha, frontendSource: newerSha, functionRun: '789' }),
      currentMainRef: failedSha,
      failedControllerRef: failedSha,
    }).mutate,
    false,
  );
  assert.equal(
    decideRollbackGuard({
      acceptedIdentity: accepted,
      failedIntent,
      observed: observation({ functionSource: failedSha, frontendSource: failedSha, functionRun: '456' }),
      rollbackAlreadyAttempted: true,
      currentMainRef: failedSha,
      failedControllerRef: failedSha,
    }).reason,
    'rollback-already-attempted',
  );
});

test('newer neutral main does not prevent rollback while the exact failed release remains installed', () => {
  const accepted = observation().identity;
  const failed = observation({ functionSource: failedSha, frontendSource: failedSha, functionRun: '456' }).identity;
  const decision = decideRollbackGuard({
    acceptedIdentity: accepted,
    failedIntent: {
      phase: 'application-ready',
      persistedBeforeWrite: true,
      configurationMayChange: true,
      expectedIdentity: failed,
    },
    observed: observation({ functionSource: failedSha, frontendSource: failedSha, functionRun: '456' }),
    currentMainRef: newerSha,
    failedControllerRef: failedSha,
  });
  assert.equal(decision.state, 'failed-release-observed');
  assert.equal(decision.mainAdvanced, true);
  assert.equal(decision.mutate, true);
});

test('configuration uncertainty is never reported as production unchanged', () => {
  const accepted = observation().identity;
  const decision = decideRollbackGuard({
    acceptedIdentity: accepted,
    failedIntent: {
      phase: 'application-ready',
      persistedBeforeWrite: true,
      configurationMayChange: true,
      expectedIdentity: accepted,
    },
    observed: observation(),
    currentMainRef: failedSha,
    failedControllerRef: failedSha,
  });
  assert.equal(decision.state, 'configuration-uncertain');
  assert.equal(decision.mutate, false);
  assert.equal(decision.configurationUncertain, true);
});

test('invalid observation cannot pass component comparisons', () => {
  const accepted = observation().identity;
  const invalid = observation({ packageDigest: '9'.repeat(64) });
  assert.equal(
    decidePromotionGuard({
      candidateSourceRef: failedSha,
      currentMainRef: failedSha,
      recoveryReady: true,
      acceptedIdentity: accepted,
      observed: invalid,
    }).reason,
    'production-observation-invalid',
  );
  assert.equal(
    decideRollbackGuard({
      acceptedIdentity: accepted,
      failedIntent: { phase: 'application-ready', persistedBeforeWrite: true, expectedIdentity: accepted },
      observed: invalid,
      currentMainRef: failedSha,
      failedControllerRef: failedSha,
    }).reason,
    'production-observation-invalid',
  );
});

test('partial frontend is bounded only when every deployed file matches accepted or failed inventory content', () => {
  const file = (name, marker) => ({
    name,
    sha256: createHash('sha256').update(marker).digest('hex'),
    size: Buffer.byteLength(marker),
  });
  const accepted = { inventory: { schemaVersion: 1, files: [file('index.html', 'accepted')] } };
  const failed = {
    inventory: {
      schemaVersion: 1,
      files: [file('chunk-ABCDEF12.js', 'candidate'), file('index.html', 'candidate')],
    },
  };
  assert.equal(isBoundedFrontendTransition(accepted, failed, { inventory: { schemaVersion: 1, files: [] } }), false);
  assert.equal(
    isBoundedFrontendTransition(accepted, failed, {
      inventory: { schemaVersion: 1, files: [file('chunk-ABCDEF12.js', 'candidate')] },
    }),
    false,
  );
  assert.equal(
    isBoundedFrontendTransition(accepted, failed, {
      inventory: {
        schemaVersion: 1,
        files: [file('chunk-ABCDEF12.js', 'candidate'), file('index.html', 'accepted')],
      },
    }),
    true,
  );
  assert.equal(
    isBoundedFrontendTransition(accepted, failed, {
      inventory: {
        schemaVersion: 1,
        files: [file('index.html', 'accepted'), file('service-worker.js', 'unknown')],
      },
    }),
    false,
  );
});

test('partial content cannot authorize rollback without the exact failed mutation receipt', () => {
  const accepted = observation().identity;
  const failed = observation({ functionSource: failedSha, frontendSource: failedSha, functionRun: '456' }).identity;
  for (const mutationReceipt of [undefined, accepted.mutationReceipt, { ...failed.mutationReceipt, runId: '789' }]) {
    const decision = decideRollbackGuard({
      acceptedIdentity: accepted,
      failedIntent: { phase: 'application-ready', persistedBeforeWrite: true, expectedIdentity: failed },
      observed: {
        ok: false,
        state: 'partial',
        identity: { function: failed.function, frontend: accepted.frontend, mutationReceipt },
      },
      currentMainRef: newerSha,
      failedControllerRef: failedSha,
    });
    assert.equal(decision.mutate, false);
    assert.equal(decision.reason, 'failed-mutation-not-attributed');
  }
});
