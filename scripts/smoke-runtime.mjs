#!/usr/bin/env node
import { getSmokeRunId, requireUrl, fetchJson, assertEqual, safeSummary } from './lib/smoke-utils.mjs';

const apiBaseUrl = requireUrl('API_BASE_URL', process.env.API_BASE_URL);
const frontendBaseUrl = process.env.FRONTEND_BASE_URL ? requireUrl('FRONTEND_BASE_URL', process.env.FRONTEND_BASE_URL) : '';
const expectedSha = process.env.EXPECTED_DEPLOYED_COMMIT_SHA || '';
const environmentName = process.env.ENVIRONMENT_NAME || '';
const smokeRunId = getSmokeRunId();
const headers = { 'X-Smoke-Run-Id': smokeRunId };
const results = { status: 'passed', smokeRunId, apiBaseUrl, frontendBaseUrl: frontendBaseUrl || undefined, checks: [] };
const healthRetryAttempts = Number(process.env.RUNTIME_HEALTH_RETRY_ATTEMPTS || 10);
const healthRetryDelayMs = Number(process.env.RUNTIME_HEALTH_RETRY_DELAY_MS || 3000);

function record(name, status, details = {}) { results.checks.push({ name, status, ...details }); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchHealthWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= healthRetryAttempts; attempt += 1) {
    for (const healthPath of ['/health', '/api/health']) {
      try {
        const health = await fetchJson(`${apiBaseUrl}${healthPath}`, { headers });
        if (health.response.status === 502 || health.response.status === 503) {
          throw new Error(`${healthPath} transient status ${health.response.status}`);
        }
        if (health.response.status === 404) continue;
        return { ...health, healthPath };
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < healthRetryAttempts) await sleep(healthRetryDelayMs);
  }
  throw lastError ?? new Error('health endpoint not reachable on /health or /api/health');
}

try {
  const health = await fetchHealthWithRetry();
  assertEqual('/health HTTP status', health.response.status, 200);
  assertEqual('/health status', health.json?.status, 'ok');
  if (environmentName) assertEqual('/health environmentName', health.json?.environmentName, environmentName);
  if (expectedSha) assertEqual('/health deployedCommitSha', health.json?.deployedCommitSha, expectedSha.toLowerCase());
  record('runtime-health', 'passed', { healthPath: health.healthPath, deployedCommitSha: health.json?.deployedCommitSha, environmentName: health.json?.environmentName });

  const hello = await fetch(`${apiBaseUrl}/api/hello`, { headers, redirect: 'manual' });
  if (process.env.AUTH_ENABLED === 'false') assertEqual('unauthenticated /api/hello status', hello.status, 200);
  else assertEqual('unauthenticated /api/hello status', hello.status, 401);
  record('unauthenticated-hello', 'passed', { statusCode: hello.status });

  if (frontendBaseUrl) {
    const metadata = await fetchJson(`${frontendBaseUrl}/assets/build-info.json`, { headers });
    assertEqual('frontend build-info HTTP status', metadata.response.status, 200);
    if (environmentName) assertEqual('frontend environmentName', metadata.json?.environmentName, environmentName);
    if (expectedSha) assertEqual('frontend deployedCommitSha', metadata.json?.deployedCommitSha, expectedSha.toLowerCase());
    record('frontend-build-info', 'passed', { deployedCommitSha: metadata.json?.deployedCommitSha });
  }

  console.log(safeSummary(results));
} catch (error) {
  results.status = 'failed';
  results.error = error instanceof Error ? error.message : String(error);
  console.error(safeSummary(results));
  process.exit(1);
}
