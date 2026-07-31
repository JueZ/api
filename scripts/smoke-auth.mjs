#!/usr/bin/env node
import { getSmokeRunId, requireUrl, fetchJson, assertEqual, safeSummary } from './lib/smoke-utils.mjs';

const KNOWN_PERMISSIONS = new Set([
  'catalogue.read',
  'reddit.read',
  'wlh.read',
  'bring.read',
  'bring.write',
  'bring.complete',
  'bring.remove',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeAuthorizationProblem(statusCode, problem) {
  if (!problem || typeof problem !== 'object' || Array.isArray(problem)) {
    return { statusCode, evidenceFormat: 'unusable' };
  }

  const requiredPermissionMatch =
    typeof problem.detail === 'string'
      ? /Required permission is missing: ([A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*)\.?/.exec(problem.detail)
      : null;
  const requiredPermission =
    requiredPermissionMatch && KNOWN_PERMISSIONS.has(requiredPermissionMatch[1])
      ? requiredPermissionMatch[1]
      : undefined;
  const retryPolicy = problem.retry_policy;
  const retryPolicyValid =
    retryPolicy !== null &&
    typeof retryPolicy === 'object' &&
    !Array.isArray(retryPolicy) &&
    retryPolicy.can_retry === true &&
    retryPolicy.same_request === false;
  const permissionEvidenceValid =
    statusCode === 403 &&
    problem.status === 403 &&
    problem.classification === 'authorization_context_mismatch' &&
    problem.repairable === true &&
    retryPolicyValid &&
    requiredPermission !== undefined;

  return {
    statusCode,
    evidenceFormat: permissionEvidenceValid ? 'api_verified_permission_denial' : 'unusable',
    classification: permissionEvidenceValid ? 'authorization_context_mismatch' : undefined,
    requiredPermission: permissionEvidenceValid ? requiredPermission : undefined,
  };
}

export async function runAuthenticatedSmoke({ env = process.env } = {}) {
  const apiBaseUrl = requireUrl('API_BASE_URL', env.API_BASE_URL);
  const token = env.AUTH_ACCESS_TOKEN || '';
  const environmentName = env.ENVIRONMENT_NAME || '';
  const expectedSha = env.EXPECTED_DEPLOYED_COMMIT_SHA || '';
  const smokeRunId = getSmokeRunId(env.SMOKE_RUN_ID);
  const requireAuthSmoke = env.REQUIRE_AUTH_SMOKE === 'true' || environmentName === 'prod';
  const shareSmokeEnabled = env.REDDIT_SHARE_URL_SMOKE_ENABLED === 'true';
  const shareSmokeRequired = env.REDDIT_SHARE_URL_SMOKE_REQUIRED === 'true';
  const shareSmokeUrl = env.REDDIT_SHARE_URL_SMOKE_URL || env.REDDIT_SHARE_URL_SMOKE || '';
  const shareSmokeExpectedPostId = env.REDDIT_SHARE_URL_SMOKE_EXPECTED_POST_ID || '';
  const results = { status: 'passed', smokeRunId, apiBaseUrl, checks: [] };
  const headers = { 'X-Smoke-Run-Id': smokeRunId, Authorization: `Bearer ${token}` };
  const healthRetryAttempts = Number(env.AUTH_HEALTH_RETRY_ATTEMPTS || env.RUNTIME_HEALTH_RETRY_ATTEMPTS || 10);
  const healthRetryDelayMs = Number(env.AUTH_HEALTH_RETRY_DELAY_MS || env.RUNTIME_HEALTH_RETRY_DELAY_MS || 3000);
  const protectedRetryAttempts = Number(env.AUTH_PROTECTED_RETRY_ATTEMPTS || healthRetryAttempts);
  const protectedRetryDelayMs = Number(env.AUTH_PROTECTED_RETRY_DELAY_MS || healthRetryDelayMs);

  function record(name, status, details = {}) {
    results.checks.push({ name, status, ...details });
  }

  async function fetchJsonWithRetry(url, options, { attempts, delayMs, retryStatuses, label }) {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchJson(url, options);
        last = response;
        if (!retryStatuses.has(response.response.status) || attempt >= attempts) return response;
      } catch (error) {
        last = error;
        if (attempt >= attempts) throw error;
      }
      await sleep(delayMs);
    }
    if (last instanceof Error) throw last;
    throw new Error(`${label} did not return after ${attempts} attempts`);
  }

  if (!token) {
    results.status = requireAuthSmoke ? 'blocked_auth_smoke' : 'skipped_auth_smoke';
    results.blockedReason =
      'AUTH_ACCESS_TOKEN was not minted for authenticated smoke; configure service OAuth variables and GitHub OIDC federation.';
    return { result: results, exitCode: requireAuthSmoke ? 2 : 0, output: 'stdout' };
  }

  try {
    const health = await fetchJsonWithRetry(
      `${apiBaseUrl}/health`,
      { headers: { 'X-Smoke-Run-Id': smokeRunId } },
      {
        attempts: healthRetryAttempts,
        delayMs: healthRetryDelayMs,
        retryStatuses: new Set([404, 502, 503]),
        label: '/health',
      },
    );
    assertEqual('/health HTTP status', health.response.status, 200);
    if (environmentName) assertEqual('/health environmentName', health.json?.environmentName, environmentName);
    if (expectedSha)
      assertEqual('/health deployedCommitSha', health.json?.deployedCommitSha, expectedSha.toLowerCase());
    record('runtime-health', 'passed', { deployedCommitSha: health.json?.deployedCommitSha });

    const hello = await fetchJsonWithRetry(
      `${apiBaseUrl}/api/hello`,
      { headers },
      {
        attempts: protectedRetryAttempts,
        delayMs: protectedRetryDelayMs,
        retryStatuses: new Set([404, 502, 503]),
        label: 'authenticated /api/hello',
      },
    );
    if (hello.response.status === 401 || hello.response.status === 403) {
      record(
        'authenticated-hello-authorization',
        'failed',
        summarizeAuthorizationProblem(hello.response.status, hello.json),
      );
    }
    assertEqual('authenticated /api/hello status', hello.response.status, 200);
    assertEqual('authenticated /api/hello authenticated flag', hello.json?.authenticated, true);
    record('authenticated-hello', 'passed');

    const reddit = await fetchJsonWithRetry(
      `${apiBaseUrl}/api/reddit/thread`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post: 'https://www.reddit.com/r/reddit.com/comments/87/the_downing_street_memo/',
          sort: 'top',
          maxComments: 1,
          maxMoreChildrenRequests: 0,
        }),
      },
      {
        attempts: protectedRetryAttempts,
        delayMs: protectedRetryDelayMs,
        retryStatuses: new Set([404, 502, 503]),
        label: 'authenticated /api/reddit/thread',
      },
    );
    if (reddit.response.status >= 500 || reddit.response.status === 429) {
      results.status = 'dependency_blocked';
      results.blockedReason = `Reddit upstream or API dependency returned ${reddit.response.status}`;
      record('authenticated-reddit-thread', 'dependency_blocked', { statusCode: reddit.response.status });
      return { result: results, exitCode: environmentName === 'prod' ? 3 : 0, output: 'stdout' };
    }
    assertEqual('authenticated /api/reddit/thread status', reddit.response.status, 200);
    record('authenticated-reddit-thread', 'passed');

    if (shareSmokeEnabled) {
      if (!shareSmokeUrl) {
        record('reddit-share-url-resolution', 'skipped', { safeReason: 'REDDIT_SHARE_URL_SMOKE was not configured.' });
      } else {
        const shareReddit = await fetchJson(`${apiBaseUrl}/api/reddit/thread`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ post: shareSmokeUrl, sort: 'top', maxComments: 1, maxMoreChildrenRequests: 0 }),
        });
        const shareBody = JSON.stringify(shareReddit.json ?? {});
        const shareResolutionBlocked =
          /REDDIT_SHARE_RESOLUTION_BLOCKED|Reddit \/s\/ share URL|\/s\/ share URL|comments<\/id>|comments\/<id>|without exposing a canonical|challenge/i.test(
            shareBody,
          );
        const shareResolutionHttpStatus =
          shareReddit.json?.redditFetchError?.status ??
          shareReddit.json?.safe_error?.original_status ??
          shareReddit.json?.safe_error?.httpStatus ??
          shareReddit.json?.resolution?.httpStatus;
        if (
          (shareReddit.response.status === 400 && shareResolutionBlocked) ||
          ([403, 429].includes(Number(shareResolutionHttpStatus)) && shareResolutionBlocked)
        ) {
          results.status = 'dependency_blocked';
          results.blockedReason = 'reddit web share URL resolution blocked from server egress';
          record('reddit-share-url-resolution', 'dependency_blocked', {
            statusCode: shareReddit.response.status,
            upstreamStatusCode: Number(shareResolutionHttpStatus) || undefined,
            safeReason: 'reddit web returned a 403/challenge or rate limit without canonical metadata',
          });
          return { result: results, exitCode: shareSmokeRequired ? 3 : 0, output: 'stdout' };
        }
        if (shareReddit.response.status >= 500 || shareReddit.response.status === 429) {
          results.status = 'dependency_blocked';
          results.blockedReason = `Reddit share URL smoke dependency returned ${shareReddit.response.status}`;
          record('reddit-share-url-resolution', 'dependency_blocked', { statusCode: shareReddit.response.status });
          return { result: results, exitCode: shareSmokeRequired ? 3 : 0, output: 'stdout' };
        }
        assertEqual('authenticated Reddit share URL smoke status', shareReddit.response.status, 200);
        if (shareSmokeExpectedPostId)
          assertEqual(
            'authenticated Reddit share URL smoke post id',
            shareReddit.json?.post?.id,
            shareSmokeExpectedPostId,
          );
        record('reddit-share-url-resolution', 'passed', { postId: shareReddit.json?.post?.id });
      }
    }

    return { result: results, exitCode: 0, output: 'stdout' };
  } catch (error) {
    results.status = 'failed';
    results.error = error instanceof Error ? error.message : String(error);
    return { result: results, exitCode: 1, output: 'stderr' };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, exitCode, output } = await runAuthenticatedSmoke();
  const rendered = safeSummary(result);
  if (output === 'stderr') console.error(rendered);
  else console.log(rendered);
  process.exit(exitCode);
}
