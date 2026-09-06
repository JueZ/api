import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFrontendInventory } from '../frontend-inventory.mjs';
import { observeProductionState } from '../lib/production-state.mjs';
import { selectInstalledAcceptedRelease } from '../resolve-known-good-release.mjs';
import { verifyProductionBaseline } from '../verify-production-baseline.mjs';

const sourceRef = 'a'.repeat(40);
const functionDigest = createHash('sha256').update('function').digest('hex');
const renderedFrontendDigest = createHash('sha256').update('rendered-frontend-archive').digest('hex');
const sbomDigest = createHash('sha256').update('sbom').digest('hex');
const correlation = 'prod-34035317014-1';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'production-baseline-test-'));
  const releaseDirectory = join(root, 'release');
  const acceptedFrontendDirectory = join(root, 'accepted-frontend');
  const deployedFrontendDirectory = join(root, 'deployed-frontend');
  await mkdir(join(acceptedFrontendDirectory, 'assets'), { recursive: true });
  const frontendMetadataBytes = Buffer.from(
    `${JSON.stringify({
      service: 'api-catalogue-web',
      deployedCommitSha: sourceRef,
      environmentName: 'prod',
      deploymentRunId: '34035317014',
    })}\n`,
  );
  await writeFile(join(acceptedFrontendDirectory, 'index.html'), '<html>accepted</html>');
  await writeFile(join(acceptedFrontendDirectory, 'assets/config.js'), 'window.CONFIG={};\n');
  await writeFile(join(acceptedFrontendDirectory, 'assets/build-info.json'), frontendMetadataBytes);
  await writeFile(join(acceptedFrontendDirectory, 'assets/app.js'), 'accepted-app');
  await cp(acceptedFrontendDirectory, deployedFrontendDirectory, { recursive: true });
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(join(releaseDirectory, 'functionapp.zip'), 'function');
  await writeFile(join(releaseDirectory, 'frontend.tar.gz'), 'rendered-frontend-archive');
  await writeFile(join(releaseDirectory, 'sbom.cdx.json'), 'sbom');
  await writeFile(
    join(releaseDirectory, 'release-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceRef,
      artifacts: {
        functionapp: { file: 'functionapp.zip', sha256: functionDigest },
        frontend: { file: 'frontend.tar.gz', sha256: renderedFrontendDigest },
        sbom: { file: 'sbom.cdx.json', sha256: sbomDigest },
      },
    })}\n`,
  );
  const expectedResource = {
    environmentName: 'prod',
    resourceGroup: 'rg-api-prod',
    functionAppName: 'func-prod',
    staticStorageAccountName: 'staticprod',
    releaseStorageAccountName: 'releaseacct',
    apiBaseUrl: 'https://func-prod.azurewebsites.net',
    frontendUrl: 'https://staticprod.z6.web.core.windows.net',
  };
  const identity = {
    sourceRef,
    runId: '34035317014',
    deliveryCorrelation: null,
    function: {
      sourceRef,
      runId: '34035317014',
      deliveryCorrelation: null,
      digests: { function: functionDigest, renderedFrontend: renderedFrontendDigest, sbom: sbomDigest },
      package: {
        storageAccountName: 'releaseacct',
        containerName: 'function-releases',
        blobName: `functionapp-${functionDigest}.zip`,
        versionId: 'v1',
        functionDigest,
        contentSha256: functionDigest,
      },
    },
    frontend: {
      sourceRef,
      runId: '34035317014',
      deliveryCorrelation: null,
      metadataSha256: createHash('sha256').update(frontendMetadataBytes).digest('hex'),
    },
    health: { status: 'unavailable', sourceRef: null },
    resource: expectedResource,
  };
  const observation = { ok: true, state: 'coherent', errors: [], identity };
  const ledger = {
    environment: 'prod',
    deployedCommit: sourceRef,
    sourceRef,
    workflowRunId: '34035317014',
    deliveryCorrelation: correlation,
    functionAppName: 'func-prod',
    frontendUrl: 'https://staticprod.z6.web.core.windows.net',
    apiBaseUrl: 'https://func-prod.azurewebsites.net',
    frontendMetadataUrl: 'https://staticprod.z6.web.core.windows.net/assets/build-info.json',
    artifacts: {
      functionappSha256: functionDigest,
      frontendSha256: renderedFrontendDigest,
      sbomSha256: sbomDigest,
    },
    smokeRunId: 'smoke-prod-34035317014-1',
    smokeResults: { status: 'passed' },
    authenticatedSmokeResults: { status: 'passed' },
    telemetryCheckResult: { status: 'passed' },
    verifiedAt: '2026-09-06T13:20:00.000Z',
  };
  const selected = {
    sourceRef,
    runId: 34035317014,
    correlation,
    releaseArtifactName: `production-release-${sourceRef}-${correlation}`,
    ledgerArtifactName: `release-ledger-prod-${sourceRef}-${correlation}`,
  };
  return {
    root,
    releaseDirectory,
    acceptedFrontendDirectory,
    deployedFrontendDirectory,
    expectedResource,
    observation,
    ledger,
    selected,
  };
}

async function verify(current, overrides = {}) {
  return verifyProductionBaseline({
    observation: overrides.observation ?? current.observation,
    ledger: overrides.ledger ?? current.ledger,
    selected: overrides.selected ?? current.selected,
    releaseDirectory: current.releaseDirectory,
    acceptedFrontendDirectory: current.acceptedFrontendDirectory,
    deployedFrontendDirectory: current.deployedFrontendDirectory,
    expectedResource: overrides.expectedResource ?? current.expectedResource,
  });
}

test('legacy accepted ledger plus immutable package and full frontend inventory resolves the baseline', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const result = await verify(current);
  assert.equal(result.ok, true);
  assert.equal(result.baseline.sourceRef, sourceRef);
  assert.equal(result.baseline.digests.renderedFrontend, renderedFrontendDigest);
  assert.equal(result.baseline.identity.health.status, 'unavailable');
});

test('legacy installed state without correlation resolves only through its unique trusted source and run pair', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const metadataBytes = await readFile(join(current.deployedFrontendDirectory, 'assets/build-info.json'));
  const installed = observeProductionState({
    appSettings: [
      { name: 'DEPLOYED_SOURCE_REF', value: sourceRef },
      { name: 'DEPLOYED_COMMIT_SHA', value: sourceRef },
      { name: 'DEPLOYMENT_RUN_ID', value: String(current.selected.runId) },
      { name: 'RELEASE_FUNCTION_SHA256', value: functionDigest },
      { name: 'RELEASE_FRONTEND_SHA256', value: renderedFrontendDigest },
      { name: 'RELEASE_SBOM_SHA256', value: sbomDigest },
      {
        name: 'WEBSITE_RUN_FROM_PACKAGE',
        value: `https://releaseacct.blob.core.windows.net/function-releases/functionapp-${functionDigest}.zip?versionid=v1`,
      },
      { name: 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID', value: 'SystemAssigned' },
    ],
    frontendMetadata: JSON.parse(metadataBytes),
    frontendMetadataBytes: metadataBytes,
    frontendInventory: await createFrontendInventory(current.deployedFrontendDirectory),
    health: { status: 'unavailable' },
    packageContentSha256: functionDigest,
    resource: current.expectedResource,
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.identity.deliveryCorrelation, null);
  const releaseName = `production-release-${sourceRef}-${correlation}`;
  const ledgerName = `release-ledger-prod-${sourceRef}-${correlation}`;
  const selected = selectInstalledAcceptedRelease({
    artifacts: [
      { id: 1, name: releaseName, expired: false, workflow_run: { id: current.selected.runId } },
      { id: 2, name: ledgerName, expired: false, workflow_run: { id: current.selected.runId } },
    ],
    runs: [
      {
        id: current.selected.runId,
        repository: { full_name: 'JueZ/api' },
        conclusion: 'success',
        head_branch: 'main',
        head_sha: sourceRef,
        run_attempt: 1,
        created_at: '2026-09-06T10:00:00Z',
        path: '.github/workflows/delivery-v2.yml',
        event: 'workflow_dispatch',
        display_title: `Delivery v2 ${sourceRef}`,
      },
    ],
    repository: 'JueZ/api',
    installedIdentity: installed.identity,
    currentRunId: 99999999999,
  });
  assert.equal(selected.correlation, correlation);
  const result = await verify(current, { observation: installed, selected });
  assert.equal(result.ok, true);
});

test('matching frontend metadata cannot hide a different deployed asset', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await writeFile(join(current.deployedFrontendDirectory, 'assets/app.js'), 'different-app');
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /deployed frontend blob digest does not match/);
});

test('retained hashed frontend assets invalidate the exact accepted inventory', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await writeFile(join(current.deployedFrontendDirectory, 'chunk-ABCDEF12.js'), 'retained-cacheable-asset');
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unexpected deployed frontend blob: chunk-ABCDEF12\.js/);
});

test('unknown executable frontend extras fail closed even when the accepted entrypoint matches', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await writeFile(
    join(current.deployedFrontendDirectory, 'service-worker.js'),
    'self.addEventListener("fetch",()=>{});',
  );
  const result = await verify(current);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unexpected deployed frontend blob: service-worker\.js/);
});

test('blocked smoke, mismatched run, correlation, or digest rejects accepted baseline', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  for (const ledger of [
    { ...current.ledger, smokeResults: { status: 'blocked' } },
    { ...current.ledger, workflowRunId: '34035317015' },
    { ...current.ledger, deliveryCorrelation: 'prod-other-run' },
    {
      ...current.ledger,
      artifacts: { ...current.ledger.artifacts, frontendSha256: '9'.repeat(64) },
    },
  ]) {
    const result = await verify(current, { ledger });
    assert.equal(result.ok, false);
  }
});

test('wrong production resource identity rejects baseline', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const result = await verify(current, {
    expectedResource: { ...current.expectedResource, functionAppName: 'other-prod' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Function App/);
});

test('ledger endpoints must bind the configured Function and static storage resources', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  for (const ledger of [
    { ...current.ledger, apiBaseUrl: 'https://other-prod.azurewebsites.net' },
    {
      ...current.ledger,
      frontendUrl: 'https://otherstatic.z6.web.core.windows.net',
      frontendMetadataUrl: 'https://otherstatic.z6.web.core.windows.net/assets/build-info.json',
    },
    {
      ...current.ledger,
      frontendUrl: 'https://staticprod.example.com',
      frontendMetadataUrl: 'https://staticprod.example.com/assets/build-info.json',
    },
    { ...current.ledger, frontendMetadataUrl: 'https://staticprod.z6.web.core.windows.net/other.json' },
  ]) {
    const result = await verify(current, { ledger });
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join('\n'),
      /production Function endpoint|production storage account|production frontend endpoint/,
    );
  }
});

test('verified recovery acceptance keeps the original bundle reference and uses the actual recovery receipt', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const recoveryRunId = '34040000000';
  const recoveryCorrelation = 'rollback-34040000000-1';
  current.observation.identity.mutationReceipt = {
    recorded: true,
    runId: recoveryRunId,
    correlation: recoveryCorrelation,
    controllerRef: 'b'.repeat(40),
    kind: 'recovery',
  };
  const selected = {
    ...current.selected,
    acceptanceRunId: recoveryRunId,
    acceptanceCorrelation: recoveryCorrelation,
    acceptanceKind: 'recovery',
  };
  const ledger = {
    ...current.ledger,
    workflowRunId: recoveryRunId,
    deliveryCorrelation: recoveryCorrelation,
    recovery: {
      status: 'verified',
      configurationUncertain: false,
      originalBundle: { sourceRef, runId: String(current.selected.runId), correlation },
    },
  };
  const result = await verify(current, { ledger, selected });
  assert.equal(result.ok, true);
  assert.equal(result.baseline.runId, String(current.selected.runId));
  assert.equal(result.baseline.acceptanceRunId, recoveryRunId);

  for (const recovery of [
    { ...ledger.recovery, status: 'incomplete' },
    { ...ledger.recovery, configurationUncertain: true },
    { ...ledger.recovery, originalBundle: { ...ledger.recovery.originalBundle, runId: '999' } },
  ]) {
    const rejected = await verify(current, { ledger: { ...ledger, recovery }, selected });
    assert.equal(rejected.ok, false);
  }
});
