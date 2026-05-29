#!/usr/bin/env node
import { getSmokeRunId, requireUrl, fetchJson, assertEqual, safeSummary } from './lib/smoke-utils.mjs';

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

  function record(name, status, details = {}) { results.checks.push({ name, status, ...details }); }

  if (!token) {
    results.status = requireAuthSmoke ? 'blocked_auth_smoke' : 'skipped_auth_smoke';
    results.blockedReason = 'AUTH_ACCESS_TOKEN was not minted for authenticated smoke; configure service OAuth variables and GitHub OIDC federation.';
    return { result: results, exitCode: requireAuthSmoke ? 2 : 0, output: 'stdout' };
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
        if (shareReddit.response.status === 400 && /REDDIT_SHARE_RESOLUTION_BLOCKED|Reddit \/s\/ share URL|\/s\/ share URL|comments<\/id>|comments\/<id>/i.test(shareBody)) {
          results.status = 'dependency_blocked';
          results.blockedReason = 'reddit web share URL resolution blocked from server egress';
          record('reddit-share-url-resolution', 'dependency_blocked', {
            statusCode: shareReddit.response.status,
            safeReason: 'reddit web share URL resolution blocked from server egress',
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
        if (shareSmokeExpectedPostId) assertEqual('authenticated Reddit share URL smoke post id', shareReddit.json?.post?.id, shareSmokeExpectedPostId);
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
  if (output === 'stderr') console.error(rendered); else console.log(rendered);
  process.exit(exitCode);
}
