#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareFrontendInventories, createFrontendInventory } from './frontend-inventory.mjs';
import { validateReleaseLedger } from './validate-release-ledger.mjs';
import { verifyReleaseArtifacts } from './verify-release-artifacts.mjs';

export async function verifyProductionBaseline({
  observation,
  ledger,
  selected,
  releaseDirectory,
  acceptedFrontendDirectory,
  deployedFrontendDirectory,
  expectedResource,
}) {
  const errors = [];
  if (!observation?.ok || observation?.state !== 'coherent') {
    errors.push(
      ...(observation?.errors?.length ? observation.errors : ['Installed production identity is not coherent']),
    );
  }
  const identity = observation?.identity ?? {};
  if (identity.resource?.environmentName !== 'prod') errors.push('Installed identity is not production');
  for (const key of ['resourceGroup', 'functionAppName', 'staticStorageAccountName', 'releaseStorageAccountName']) {
    if (expectedResource?.[key] && identity.resource?.[key] !== expectedResource[key]) {
      errors.push(`Installed ${key} does not match the expected production resource`);
    }
  }

  const ledgerErrors = validateReleaseLedger(ledger, {
    expectedDeliveryCorrelation: selected?.acceptanceCorrelation ?? selected?.correlation,
  });
  errors.push(...ledgerErrors.map((error) => `Ledger: ${error}`));
  if (ledger?.environment !== 'prod') errors.push('Accepted ledger must be for production');
  if (ledger?.sourceRef !== selected?.sourceRef || ledger?.deployedCommit !== selected?.sourceRef) {
    errors.push('Accepted ledger source does not match the selected release');
  }
  if (String(ledger?.workflowRunId ?? '') !== String(selected?.acceptanceRunId ?? selected?.runId ?? '')) {
    errors.push('Accepted ledger run does not match the selected acceptance receipt');
  }
  for (const key of ['smokeResults', 'authenticatedSmokeResults', 'telemetryCheckResult']) {
    if (ledger?.[key]?.status !== 'passed') errors.push(`Accepted ledger ${key}.status must be passed`);
  }
  if (ledger?.functionAppName !== expectedResource?.functionAppName) {
    errors.push('Accepted ledger Function App does not match the expected production resource');
  }
  try {
    const apiUrl = new URL(ledger?.apiBaseUrl);
    const expectedApiUrl = new URL(expectedResource?.apiBaseUrl);
    if (
      apiUrl.origin !== expectedApiUrl.origin ||
      apiUrl.hostname !== `${expectedResource?.functionAppName}.azurewebsites.net`
    ) {
      errors.push('Accepted ledger API URL does not match the configured production Function endpoint');
    }
    const frontendUrl = new URL(ledger?.frontendUrl);
    const expectedFrontendUrl = new URL(expectedResource?.frontendUrl);
    if (
      frontendUrl.origin !== expectedFrontendUrl.origin ||
      frontendUrl.protocol !== 'https:' ||
      frontendUrl.pathname !== '/' ||
      frontendUrl.search ||
      frontendUrl.hash ||
      !frontendUrl.hostname.startsWith(`${expectedResource?.staticStorageAccountName}.`)
    ) {
      errors.push('Accepted ledger frontend URL does not match the expected production storage account');
    }
    if (ledger?.frontendMetadataUrl !== new URL('/assets/build-info.json', expectedFrontendUrl).href) {
      errors.push('Accepted ledger frontend metadata URL does not use the production frontend endpoint');
    }
  } catch {
    errors.push('Accepted ledger production endpoint URL is unavailable or invalid');
  }

  const release = await verifyReleaseArtifacts(releaseDirectory, selected?.sourceRef ?? '');
  errors.push(...release.errors.map((error) => `Recovery bundle: ${error}`));
  const manifestDigests = {
    function: release.manifest?.artifacts?.functionapp?.sha256,
    renderedFrontend: release.manifest?.artifacts?.frontend?.sha256,
    sbom: release.manifest?.artifacts?.sbom?.sha256,
  };
  const ledgerDigests = {
    function: ledger?.artifacts?.functionappSha256,
    renderedFrontend: ledger?.artifacts?.frontendSha256,
    sbom: ledger?.artifacts?.sbomSha256,
  };
  const installedDigests = identity.function?.digests ?? {};
  for (const key of Object.keys(manifestDigests)) {
    if (manifestDigests[key] !== ledgerDigests[key]) {
      errors.push(`Recovery bundle ${key} digest does not match the accepted ledger`);
    }
    if (ledgerDigests[key] !== installedDigests[key]) {
      errors.push(`Installed ${key} digest does not match the accepted ledger`);
    }
  }
  if (identity.sourceRef !== selected?.sourceRef || String(identity.runId) !== String(selected?.runId)) {
    errors.push('Installed source/run identity does not match the selected accepted release');
  }
  if (identity.deliveryCorrelation && identity.deliveryCorrelation !== selected?.correlation) {
    errors.push('Installed delivery correlation does not match the selected accepted release');
  }
  const expectedAcceptanceRunId = String(selected?.acceptanceRunId ?? selected?.runId ?? '');
  const expectedAcceptanceCorrelation = selected?.acceptanceCorrelation ?? selected?.correlation;
  const mutationReceipt =
    !identity.mutationReceipt || identity.mutationReceipt.recorded === false
      ? {
          recorded: false,
          runId: identity.runId,
          correlation: identity.deliveryCorrelation || selected?.correlation,
          controllerRef: identity.sourceRef,
          kind: 'legacy-release',
        }
      : identity.mutationReceipt;
  if (
    String(mutationReceipt.runId ?? '') !== expectedAcceptanceRunId ||
    mutationReceipt.correlation !== expectedAcceptanceCorrelation
  ) {
    errors.push('Installed mutation receipt does not match the selected acceptance evidence');
  }
  if (selected?.acceptanceKind === 'recovery') {
    if (mutationReceipt.kind !== 'recovery' || mutationReceipt.recorded !== true) {
      errors.push('Installed recovery is missing its explicit production mutation receipt');
    }
    if (
      ledger?.recovery?.status !== 'verified' ||
      ledger?.recovery?.configurationUncertain !== false ||
      ledger?.recovery?.originalBundle?.sourceRef !== selected.sourceRef ||
      String(ledger?.recovery?.originalBundle?.runId ?? '') !== String(selected.runId) ||
      ledger?.recovery?.originalBundle?.correlation !== selected.correlation
    ) {
      errors.push('Recovery ledger does not verify the installed original bundle without configuration uncertainty');
    }
  } else if (ledger?.recovery !== undefined) {
    errors.push('Normal accepted release ledger must not claim recovery evidence');
  }

  let acceptedInventory;
  let deployedInventory;
  try {
    acceptedInventory = await createFrontendInventory(acceptedFrontendDirectory);
    if (deployedFrontendDirectory) {
      deployedInventory = await createFrontendInventory(deployedFrontendDirectory);
      const inventoryResult = compareFrontendInventories(acceptedInventory, deployedInventory);
      errors.push(...inventoryResult.errors.map((error) => `Installed frontend: ${error}`));
    }
  } catch (error) {
    errors.push(`Installed frontend inventory could not be verified: ${error.message}`);
  }
  try {
    const acceptedMetadataBytes = await readFile(resolve(acceptedFrontendDirectory, 'assets/build-info.json'));
    const acceptedMetadataSha256 = createHash('sha256').update(acceptedMetadataBytes).digest('hex');
    if (identity.frontend?.metadataSha256 !== acceptedMetadataSha256) {
      errors.push('Installed frontend metadata identity does not match the accepted rendered archive');
    }
  } catch (error) {
    errors.push(`Accepted rendered frontend metadata is unavailable: ${error.message}`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    baseline: ok
      ? {
          schemaVersion: 1,
          status: 'accepted',
          sourceRef: selected.sourceRef,
          runId: String(selected.runId),
          correlation: selected.correlation,
          acceptanceRunId: expectedAcceptanceRunId,
          acceptanceCorrelation: expectedAcceptanceCorrelation,
          acceptanceKind: selected.acceptanceKind ?? 'promotion',
          releaseArtifactName: selected.releaseArtifactName,
          ledgerArtifactName: selected.ledgerArtifactName,
          digests: ledgerDigests,
          identity,
          frontendInventory: acceptedInventory,
        }
      : null,
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function appendOutputs(values, path) {
  if (!path) return;
  appendFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const selected = {
    sourceRef: args.get('--source'),
    runId: args.get('--run-id'),
    correlation: args.get('--correlation'),
    acceptanceRunId: args.get('--acceptance-run-id'),
    acceptanceCorrelation: args.get('--acceptance-correlation'),
    acceptanceKind: args.get('--acceptance-kind') || 'promotion',
    releaseArtifactName: args.get('--release-artifact'),
    ledgerArtifactName: args.get('--ledger-artifact'),
  };
  const result = await verifyProductionBaseline({
    observation: await readJson(args.get('--observation')),
    ledger: await readJson(args.get('--ledger')),
    selected,
    releaseDirectory: args.get('--release-dir'),
    acceptedFrontendDirectory: args.get('--accepted-frontend-dir'),
    deployedFrontendDirectory: args.get('--deployed-frontend-dir') || '',
    expectedResource: await readJson(args.get('--expected-resource')),
  });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const outputPath = args.get('--json-output');
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(result.baseline, null, 2)}\n`);
  appendOutputs(
    {
      baseline_status: 'accepted',
      baseline_source_ref: result.baseline.sourceRef,
      baseline_run_id: result.baseline.runId,
      baseline_correlation: result.baseline.correlation,
      baseline_acceptance_run_id: result.baseline.acceptanceRunId,
      baseline_acceptance_correlation: result.baseline.acceptanceCorrelation,
      baseline_release_artifact: result.baseline.releaseArtifactName,
      baseline_ledger_artifact: result.baseline.ledgerArtifactName,
    },
    args.get('--output'),
  );
  process.stdout.write(
    `${JSON.stringify({ status: result.baseline.status, sourceRef: result.baseline.sourceRef, runId: result.baseline.runId })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
