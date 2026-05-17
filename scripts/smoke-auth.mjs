#!/usr/bin/env node
import { getSmokeRunId, requireUrl, fetchJson, assertEqual, safeSummary } from './lib/smoke-utils.mjs';

const apiBaseUrl = requireUrl('API_BASE_URL', process.env.API_BASE_URL);
const token = process.env.AUTH_ACCESS_TOKEN || '';
const environmentName = process.env.ENVIRONMENT_NAME || '';
const expectedSha = process.env.EXPECTED_DEPLOYED_COMMIT_SHA || '';
const smokeRunId = getSmokeRunId();
const requireAuthSmoke = process.env.REQUIRE_AUTH_SMOKE === 'true' || environmentName === 'prod';
const results = { status: 'passed', smokeRunId, apiBaseUrl, checks: [] };
const headers = { 'X-Smoke-Run-Id': smokeRunId, Authorization: `Bearer ${token}` };

function record(name, status, details = {}) { results.checks.push({ name, status, ...details }); }

if (!token) {
  results.status = requireAuthSmoke ? 'blocked_auth_smoke' : 'skipped_auth_smoke';
  results.blockedReason = 'AUTH_ACCESS_TOKEN is not configured; configure a short-lived smoke token secret for protected API verification.';
  console.log(safeSummary(results));
  process.exit(requireAuthSmoke ? 2 : 0);
}

try {
  const health = await fetchJson(`${apiBaseUrl}/health`, { headers: { 'X-Smoke-Run-Id': smokeRunId } });
  assertEqual('/health HTTP status', health.response.status, 200);
  if (environmentName) assertEqual('/health environmentName', health.json?.environmentName, environmentName);
  if (expectedSha) assertEqual('/health deployedCommitSha', health.json?.deployedCommitSha, expectedSha.toLowerCase());
  record('runtime-health', 'passed', { deployedCommitSha: health.json?.deployedCommitSha });

  const hello = await fetchJson(`${apiBaseUrl}/api/hello`, { headers });
  assertEqual('authenticated /api/hello status', hello.response.status, 200);
  assertEqual('authenticated /api/hello authenticated flag', hello.json?.authenticated, true);
  record('authenticated-hello', 'passed');

  const reddit = await fetchJson(`${apiBaseUrl}/api/reddit/thread`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ post: 'https://www.reddit.com/r/reddit.com/comments/87/the_downing_street_memo/', sort: 'top', maxComments: 1, maxMoreChildrenRequests: 0 }),
  });
  if (reddit.response.status >= 500 || reddit.response.status === 429) {
    results.status = 'dependency_blocked';
    results.blockedReason = `Reddit upstream or API dependency returned ${reddit.response.status}`;
    record('authenticated-reddit-thread', 'dependency_blocked', { statusCode: reddit.response.status });
    console.log(safeSummary(results));
    process.exit(environmentName === 'prod' ? 3 : 0);
  }
  assertEqual('authenticated /api/reddit/thread status', reddit.response.status, 200);
  record('authenticated-reddit-thread', 'passed');
  console.log(safeSummary(results));
} catch (error) {
  results.status = 'failed';
  results.error = error instanceof Error ? error.message : String(error);
  console.error(safeSummary(results));
  process.exit(1);
}
