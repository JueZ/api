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
    smokeRunId,
    smokeResults: await readJson(env.SMOKE_RESULTS_PATH, {
      status: 'blocked',
      blockedReason: 'SMOKE_RESULTS_PATH was not provided.',
    }),
    authenticatedSmokeResults: await readJson(env.AUTH_SMOKE_RESULTS_PATH, {
      status: 'blocked_auth_smoke',
      blockedReason: 'AUTH_SMOKE_RESULTS_PATH was not provided; token minting or authenticated smoke did not complete.',
    }),
    telemetryCheckResult: await readJson(env.TELEMETRY_RESULTS_PATH, {
      status: 'blocked_telemetry',
      blockedReason: 'TELEMETRY_RESULTS_PATH was not provided.',
    }),
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
