#!/usr/bin/env node
import {
  getSmokeRunId,
  requireUrl,
  fetchJson,
  fetchWithTimeout,
  assertEqual,
  safeSummary,
} from './lib/smoke-utils.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRuntimeSmoke({ env = process.env, fetchImpl = fetchWithTimeout } = {}) {
  const apiBaseUrl = requireUrl('API_BASE_URL', env.API_BASE_URL);
  const frontendBaseUrl = env.FRONTEND_BASE_URL ? requireUrl('FRONTEND_BASE_URL', env.FRONTEND_BASE_URL) : '';
  const expectedSha = env.EXPECTED_DEPLOYED_COMMIT_SHA || '';
  const environmentName = env.ENVIRONMENT_NAME || '';
  const smokeRunId = getSmokeRunId(env.SMOKE_RUN_ID);
  const headers = { 'X-Smoke-Run-Id': smokeRunId };
  const results = {
    status: 'passed',
    smokeRunId,
    apiBaseUrl,
    frontendBaseUrl: frontendBaseUrl || undefined,
    checks: [],
  };
  const healthRetryAttempts = Number(env.RUNTIME_HEALTH_RETRY_ATTEMPTS || 10);
  const healthRetryDelayMs = Number(env.RUNTIME_HEALTH_RETRY_DELAY_MS || 3000);
  const helloRetryAttempts = Number(env.RUNTIME_HELLO_RETRY_ATTEMPTS || healthRetryAttempts);
  const helloRetryDelayMs = Number(env.RUNTIME_HELLO_RETRY_DELAY_MS || healthRetryDelayMs);

  function record(name, status, details = {}) {
    results.checks.push({ name, status, ...details });
  }

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
    let lastError;
    for (let attempt = 1; attempt <= helloRetryAttempts; attempt += 1) {
      try {
        const hello = await fetchImpl(`${apiBaseUrl}/api/hello`, { headers, redirect: 'manual' });
        lastStatus = hello.status;
        if (hello.status === expectedStatus) return hello;
        const isTransient = hello.status === 404 || hello.status === 502 || hello.status === 503;
        if (!isTransient || attempt >= helloRetryAttempts) break;
      } catch (error) {
        lastError = error;
        if (attempt >= helloRetryAttempts) break;
      }
      await sleep(helloRetryDelayMs);
    }
    if (lastError) throw lastError;
    throw new Error(`unauthenticated /api/hello status expected ${expectedStatus}, got ${lastStatus}`);
  }

  try {
    const health = await fetchHealthWithRetry();
    assertEqual('/health HTTP status', health.response.status, 200);
    assertEqual('/health status', health.json?.status, 'ok');
    if (environmentName) assertEqual('/health environmentName', health.json?.environmentName, environmentName);
    if (expectedSha)
      assertEqual('/health deployedCommitSha', health.json?.deployedCommitSha, expectedSha.toLowerCase());
    record('runtime-health', 'passed', {
      deployedCommitSha: health.json?.deployedCommitSha,
      environmentName: health.json?.environmentName,
    });

    const expectedHelloStatus = env.AUTH_ENABLED === 'false' ? 200 : 401;
    const hello = await fetchHelloWithRetry(expectedHelloStatus);
    record('unauthenticated-hello', 'passed', { statusCode: hello.status });

    if (frontendBaseUrl) {
      const metadata = await fetchJson(`${frontendBaseUrl}/assets/build-info.json`, { headers });
      assertEqual('frontend build-info HTTP status', metadata.response.status, 200);
      if (environmentName) assertEqual('frontend environmentName', metadata.json?.environmentName, environmentName);
      if (expectedSha)
        assertEqual('frontend deployedCommitSha', metadata.json?.deployedCommitSha, expectedSha.toLowerCase());
      record('frontend-build-info', 'passed', { deployedCommitSha: metadata.json?.deployedCommitSha });
    }

    return { result: results, exitCode: 0, output: 'stdout' };
  } catch (error) {
    results.status = 'failed';
    results.error = error instanceof Error ? error.message : String(error);
    return { result: results, exitCode: 1, output: 'stderr' };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, exitCode, output } = await runRuntimeSmoke();
  const rendered = safeSummary(result);
  if (output === 'stderr') console.error(rendered);
  else console.log(rendered);
  process.exit(exitCode);
}
