#!/usr/bin/env node
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getSmokeRunId } from './lib/smoke-utils.mjs';

const out = process.env.RELEASE_LEDGER_PATH || process.argv[2] || 'release-ledger.json';
const readJson = async (path, fallback) => {
  if (!path) return fallback;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { return { status: 'blocked', blockedReason: `Could not read ${path}: ${error.message}` }; }
};

const smokeRunId = getSmokeRunId();
const ledger = {
  environment: process.env.ENVIRONMENT_NAME,
  deployedCommit: String(process.env.EXPECTED_DEPLOYED_COMMIT_SHA || process.env.DEPLOYED_COMMIT_SHA || '').toLowerCase(),
  sourceRef: String(process.env.DEPLOYED_SOURCE_REF || process.env.EXPECTED_DEPLOYED_COMMIT_SHA || '').toLowerCase(),
  workflowRunId: String(process.env.GITHUB_RUN_ID || process.env.DEPLOYMENT_RUN_ID || 'unknown'),
  functionAppName: process.env.EFFECTIVE_FUNCTIONAPP_NAME || process.env.AZURE_FUNCTIONAPP_NAME || 'unknown',
  frontendUrl: process.env.FRONTEND_BASE_URL || '',
  apiBaseUrl: process.env.API_BASE_URL || process.env.EFFECTIVE_BASE_URL || '',
  frontendMetadataUrl: process.env.FRONTEND_BASE_URL ? `${process.env.FRONTEND_BASE_URL.replace(/\/$/, '')}/assets/build-info.json` : '',
  smokeRunId,
  smokeResults: await readJson(process.env.SMOKE_RESULTS_PATH, { status: 'blocked', blockedReason: 'SMOKE_RESULTS_PATH was not provided.' }),
  authenticatedSmokeResults: await readJson(process.env.AUTH_SMOKE_RESULTS_PATH, { status: 'blocked_auth_smoke', blockedReason: 'AUTH_SMOKE_RESULTS_PATH was not provided; token minting or authenticated smoke did not complete.' }),
  telemetryCheckResult: await readJson(process.env.TELEMETRY_RESULTS_PATH, { status: 'blocked_telemetry', blockedReason: 'TELEMETRY_RESULTS_PATH was not provided.' }),
  verifiedAt: new Date().toISOString(),
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`Wrote release ledger to ${out}`);
