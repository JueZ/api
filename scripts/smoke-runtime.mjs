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
const helloRetryAttempts = Number(process.env.RUNTIME_HELLO_RETRY_ATTEMPTS || healthRetryAttempts);
const helloRetryDelayMs = Number(process.env.RUNTIME_HELLO_RETRY_DELAY_MS || healthRetryDelayMs);

function record(name, status, details = {}) { results.checks.push({ name, status, ...details }); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchHealthWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= healthRetryAttempts; attempt += 1) {
    try {
      const health = await fetchJson(`${apiBaseUrl}/health`, { headers });
      if (health.response.status === 404 || health.response.status === 502 || health.response.status === 503) {
        throw new Error(`/health transient status ${health.response.status}`);
      }
      return health;
    } catch (error) {
      lastError = error;
      if (attempt >= healthRetryAttempts) break;
      await sleep(healthRetryDelayMs);
    }
  }
  throw lastError;
}

async function fetchHelloWithRetry(expectedStatus) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= helloRetryAttempts; attempt += 1) {
    const hello = await fetch(`${apiBaseUrl}/api/hello`, { headers, redirect: 'manual' });
    lastStatus = hello.status;
    if (hello.status === expectedStatus) return hello;
    const isTransient = hello.status === 404 || hello.status === 502 || hello.status === 503;
    if (!isTransient || attempt >= helloRetryAttempts) break;
    await sleep(helloRetryDelayMs);
  }
  throw new Error(`unauthenticated /api/hello status expected ${expectedStatus}, got ${lastStatus}`);
}

try {
  const health = await fetchHealthWithRetry();
  assertEqual('/health HTTP status', health.response.status, 200);
  assertEqual('/health status', health.json?.status, 'ok');
  if (environmentName) assertEqual('/health environmentName', health.json?.environmentName, environmentName);
  if (expectedSha) assertEqual('/health deployedCommitSha', health.json?.deployedCommitSha, expectedSha.toLowerCase());
  record('runtime-health', 'passed', { deployedCommitSha: health.json?.deployedCommitSha, environmentName: health.json?.environmentName });

  const expectedHelloStatus = process.env.AUTH_ENABLED === 'false' ? 200 : 401;
  const hello = await fetchHelloWithRetry(expectedHelloStatus);
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
