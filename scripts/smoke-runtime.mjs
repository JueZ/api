#!/usr/bin/env node
import { getSmokeRunId, requireUrl, fetchJson, assertEqual, safeSummary } from './lib/smoke-utils.mjs';

const apiBaseUrl = requireUrl('API_BASE_URL', process.env.API_BASE_URL);
const frontendBaseUrl = process.env.FRONTEND_BASE_URL ? requireUrl('FRONTEND_BASE_URL', process.env.FRONTEND_BASE_URL) : '';
const expectedSha = process.env.EXPECTED_DEPLOYED_COMMIT_SHA || '';
const environmentName = process.env.ENVIRONMENT_NAME || '';
const smokeRunId = getSmokeRunId();
const headers = { 'X-Smoke-Run-Id': smokeRunId };
const results = { status: 'passed', smokeRunId, apiBaseUrl, frontendBaseUrl: frontendBaseUrl || undefined, checks: [] };

function record(name, status, details = {}) { results.checks.push({ name, status, ...details }); }

try {
  const health = await fetchJson(`${apiBaseUrl}/health`, { headers });
  assertEqual('/health HTTP status', health.response.status, 200);
  assertEqual('/health status', health.json?.status, 'ok');
  if (environmentName) assertEqual('/health environmentName', health.json?.environmentName, environmentName);
  if (expectedSha) assertEqual('/health deployedCommitSha', health.json?.deployedCommitSha, expectedSha.toLowerCase());
  record('runtime-health', 'passed', { deployedCommitSha: health.json?.deployedCommitSha, environmentName: health.json?.environmentName });

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
