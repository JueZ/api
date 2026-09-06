#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getSmokeRunId } from './lib/smoke-utils.mjs';

async function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { status: 'blocked', blockedReason: `Could not read ${path}: ${error.message}` };
  }
}

export async function writeReleaseLedger({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const out = env.RELEASE_LEDGER_PATH || argv[0] || 'release-ledger.json';
  const smokeRunId = getSmokeRunId(env.SMOKE_RUN_ID);
  const installationValues = [
    env.INSTALLED_RELEASE_RUN_ID,
    env.INSTALLED_RELEASE_CORRELATION,
    env.RELEASE_PACKAGE_STORAGE_ACCOUNT,
    env.RELEASE_PACKAGE_CONTAINER,
    env.RELEASE_PACKAGE_BLOB,
    env.RELEASE_PACKAGE_VERSION_ID,
    env.FRONTEND_METADATA_SHA256,
    env.FRONTEND_INVENTORY_SHA256,
  ];
  const installation = installationValues.every((value) => String(value || '') !== '')
    ? {
        runId: String(env.INSTALLED_RELEASE_RUN_ID),
        correlation: String(env.INSTALLED_RELEASE_CORRELATION),
        functionPackage: {
          storageAccountName: String(env.RELEASE_PACKAGE_STORAGE_ACCOUNT),
          containerName: String(env.RELEASE_PACKAGE_CONTAINER),
          blobName: String(env.RELEASE_PACKAGE_BLOB),
          versionId: String(env.RELEASE_PACKAGE_VERSION_ID),
        },
        frontend: {
          metadataSha256: String(env.FRONTEND_METADATA_SHA256).toLowerCase(),
          inventorySha256: String(env.FRONTEND_INVENTORY_SHA256).toLowerCase(),
        },
      }
    : null;
  const smokeResults = await readJson(env.SMOKE_RESULTS_PATH, {
    status: 'blocked',
    blockedReason: 'SMOKE_RESULTS_PATH was not provided.',
  });
  const authenticatedSmokeResults = await readJson(env.AUTH_SMOKE_RESULTS_PATH, {
    status: 'blocked_auth_smoke',
    blockedReason: 'AUTH_SMOKE_RESULTS_PATH was not provided; token minting or authenticated smoke did not complete.',
  });
  const telemetryCheckResult = await readJson(env.TELEMETRY_RESULTS_PATH, {
    status: 'blocked_telemetry',
    blockedReason: 'TELEMETRY_RESULTS_PATH was not provided.',
  });
  const recoveryRequested = String(env.RECOVERY_ORIGINAL_RUN_ID || '') !== '';
  const configurationUncertain = String(env.RECOVERY_CONFIGURATION_UNCERTAIN || 'false') === 'true';
  const recovery = recoveryRequested
    ? {
        status:
          !configurationUncertain &&
          [smokeResults, authenticatedSmokeResults, telemetryCheckResult].every((result) => result.status === 'passed')
            ? 'verified'
            : 'incomplete',
        configurationUncertain,
        originalBundle: {
          sourceRef: String(env.RECOVERY_ORIGINAL_SOURCE_REF || '').toLowerCase(),
          runId: String(env.RECOVERY_ORIGINAL_RUN_ID || ''),
          correlation: String(env.RECOVERY_ORIGINAL_CORRELATION || ''),
        },
      }
    : null;
  const ledger = {
    environment: env.ENVIRONMENT_NAME,
    deployedCommit: String(env.EXPECTED_DEPLOYED_COMMIT_SHA || env.DEPLOYED_COMMIT_SHA || '').toLowerCase(),
    sourceRef: String(env.DEPLOYED_SOURCE_REF || env.EXPECTED_DEPLOYED_COMMIT_SHA || '').toLowerCase(),
    workflowRunId: String(env.GITHUB_RUN_ID || env.DEPLOYMENT_RUN_ID || 'unknown'),
    deliveryCorrelation: String(env.DELIVERY_CORRELATION || ''),
    functionAppName: env.EFFECTIVE_FUNCTIONAPP_NAME || env.AZURE_FUNCTIONAPP_NAME || 'unknown',
    frontendUrl: env.FRONTEND_BASE_URL || '',
    apiBaseUrl: env.API_BASE_URL || env.EFFECTIVE_BASE_URL || '',
    frontendMetadataUrl: env.FRONTEND_BASE_URL
      ? `${env.FRONTEND_BASE_URL.replace(/\/$/, '')}/assets/build-info.json`
      : '',
    artifacts: {
      functionappSha256: String(env.RELEASE_FUNCTION_SHA256 || '').toLowerCase(),
      frontendSha256: String(env.RELEASE_FRONTEND_SHA256 || '').toLowerCase(),
      sbomSha256: String(env.RELEASE_SBOM_SHA256 || '').toLowerCase(),
    },
    ...(installation ? { installation } : {}),
    ...(recovery ? { recovery } : {}),
    smokeRunId,
    smokeResults,
    authenticatedSmokeResults,
    telemetryCheckResult,
    verifiedAt: new Date().toISOString(),
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(ledger, null, 2)}\n`);
  return { ledger, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { out } = await writeReleaseLedger();
  console.log(`Wrote release ledger to ${out}`);
}
