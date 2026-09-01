import assert from 'node:assert/strict';
import test from 'node:test';
import { RedditFetchError, RedditOAuthClient, RedditUpstreamError } from '../dist/shared/reddit/client.js';
import {
  MAX_MORE_CHILDREN_REQUESTS_PER_CALL,
  normalizeMaxMoreChildrenRequests,
  normalizeRedditPostInput,
  parseRedditPostInput,
  unresolvedRedditShareUrlError,
} from '../dist/shared/reddit/input.js';
import { attachMoreChildren, normalizeInitialThread } from '../dist/shared/reddit/normalize.js';
import { RedditThreadService } from '../dist/shared/reddit/service.js';
import {
  InMemoryRedditThreadSnapshotStore,
  RedditCursorError,
  RedditSnapshotConflictError,
  RedditSnapshotExpiredError,
  RedditSnapshotNotFoundError,
} from '../dist/shared/reddit/snapshot.js';
import { RedditPrincipalConcurrencyError, withRedditPrincipalConcurrency } from '../dist/shared/reddit/concurrency.js';
import {
  redditThreadHandler,
  setRedditThreadServiceForTesting,
  setRepairableErrorAnalyzerForTesting,
} from '../dist/functions/redditThread.js';
import {
  redditCommentTreeHandler,
  setRedditCommentTreeServiceForTesting,
  setRepairableErrorAnalyzerForTesting as setCommentTreeRepairableErrorAnalyzerForTesting,
} from '../dist/functions/redditCommentTree.js';
import {
  redditThreadOverviewHandler,
  setRedditThreadOverviewServiceForTesting,
  setRepairableErrorAnalyzerForTesting as setThreadOverviewRepairableErrorAnalyzerForTesting,
} from '../dist/functions/redditThreadOverview.js';
import {
  redditThreadCommentsHandler,
  setRedditThreadCommentsServiceForTesting,
  setRepairableErrorAnalyzerForTesting as setThreadCommentsRepairableErrorAnalyzerForTesting,
} from '../dist/functions/redditThreadComments.js';
import {
  redditCommentsBatchHandler,
  setRedditCommentsBatchServiceForTesting,
  setRepairableErrorAnalyzerForTesting as setCommentsBatchRepairableErrorAnalyzerForTesting,
} from '../dist/functions/redditCommentsBatch.js';
import { buildFallbackRepairableProblem, validateRepairableProblem } from '../dist/shared/errors/repairableProblem.js';
import { buildDiagnosticCapsule, buildRedditDiagnosticCapsule } from '../dist/shared/errors/diagnosticCapsule.js';
import { extractRedditCanonicalUrlFromHtml } from '../dist/shared/reddit/htmlCanonical.js';
import {
  buildDeterministicRepairableProblem,
  resolveRepairableProblem,
} from '../dist/shared/errors/repairableErrorService.js';

const config = {
  clientId: 'client-id',
  secret: 'client-secret',
  userAgent: 'script:test:v0.1.0 (by u/example)',
  storageAccountName: '',
  snapshotContainer: 'reddit-snapshots',
  snapshotTtlMs: 86_400_000,
  snapshotMaxComments: 100_000,
  snapshotMaxBytes: 96 * 1024 * 1024,
};

function headerValue(init, name) {
  const headers = init?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lowerName = name.toLowerCase();
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => String(key).toLowerCase() === lowerName);
    return entry ? entry[1] : null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

function assertRedditAuthenticatedRequest(call) {
  assert.equal(headerValue(call.init, 'Authorization'), 'Bearer mock-token');
  assert.equal(headerValue(call.init, 'User-Agent'), config.userAgent);
}

test('parseRedditPostInput accepts supported ID and URL formats', () => {
  assert.deepEqual(parseRedditPostInput('abc123'), { articleId: 'abc123', fullname: 't3_abc123' });
  assert.deepEqual(parseRedditPostInput('t3_ABC123'), { articleId: 'abc123', fullname: 't3_abc123' });
  assert.deepEqual(parseRedditPostInput('https://redd.it/abc123'), { articleId: 'abc123', fullname: 't3_abc123' });
  assert.deepEqual(parseRedditPostInput('https://www.reddit.com/r/test/comments/abc123/title/'), {
    articleId: 'abc123',
    fullname: 't3_abc123',
  });
  assert.deepEqual(parseRedditPostInput('https://old.reddit.com/r/test/comments/abc123/title/'), {
    articleId: 'abc123',
    fullname: 't3_abc123',
  });
});

test('normalizeRedditPostInput accepts raw post IDs', async () => {
  const normalized = await normalizeRedditPostInput('1tflddp');

  assert.equal(normalized.post_id, '1tflddp');
});

test('normalizeRedditPostInput accepts t3 fullnames', async () => {
  const normalized = await normalizeRedditPostInput('t3_1tflddp');

  assert.equal(normalized.post_id, '1tflddp');
});

test('Reddit expansion requests use a small server-owned budget', () => {
  assert.equal(normalizeMaxMoreChildrenRequests(undefined), 0);
  assert.equal(normalizeMaxMoreChildrenRequests(4), 4);
  assert.equal(normalizeMaxMoreChildrenRequests(5000), MAX_MORE_CHILDREN_REQUESTS_PER_CALL);
  assert.equal(MAX_MORE_CHILDREN_REQUESTS_PER_CALL, 10);
});

test('Reddit expansion concurrency is limited per principal and released after completion', async () => {
  const principal = {
    subject: 'user-subject',
    objectId: 'user-object-id',
    tenantId: 'tenant-id',
    clientId: 'client-id',
    tokenType: 'user',
    scopes: ['reddit.read'],
    roles: [],
  };
  let release;
  const first = withRedditPrincipalConcurrency(
    principal,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();

  await assert.rejects(
    withRedditPrincipalConcurrency(principal, async () => undefined),
    RedditPrincipalConcurrencyError,
  );
  release();
  await first;
  await assert.doesNotReject(withRedditPrincipalConcurrency(principal, async () => undefined));
});

test('normalizeRedditPostInput accepts canonical comments URLs with subreddit metadata', async () => {
  const normalized = await normalizeRedditPostInput(
    'https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/',
  );

  assert.equal(normalized.post_id, '1tflddp');
  assert.equal(normalized.subreddit, 'science');
});

test('normalizeRedditPostInput accepts comment permalinks with comment IDs', async () => {
  const normalized = await normalizeRedditPostInput(
    'https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/oma4ybn/',
  );

  assert.equal(normalized.post_id, '1tflddp');
  assert.equal(normalized.comment_id, 'oma4ybn');
});

test('normalizeRedditPostInput accepts redd.it short links', async () => {
  const normalized = await normalizeRedditPostInput('https://redd.it/1tflddp');

  assert.equal(normalized.post_id, '1tflddp');
});

test('normalizeRedditPostInput resolves Reddit share URLs before extracting post IDs', async () => {
  const shareUrl = 'https://www.reddit.com/r/science/s/DQGxxt7XzY';
  const finalUrl =
    'https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/?share_id=X';
  const normalized = await normalizeRedditPostInput(shareUrl, async (url) => {
    assert.equal(url, shareUrl);
    return { finalUrl, redirectChain: [shareUrl, finalUrl] };
  });

  assert.equal(normalized.post_id, '1tflddp');
  assert.equal(normalized.subreddit, 'science');
  assert.deepEqual(normalized.redirectChain, [shareUrl, finalUrl]);
});

test('parseRedditPostInput rejects non-Reddit URLs and invalid IDs', () => {
  assert.throws(() => parseRedditPostInput('https://example.com/r/test/comments/abc123'), /supported Reddit URL/);
  assert.throws(() => parseRedditPostInput('!bad'), /valid Reddit article ID/);
});

test('parseRedditPostInput rejects unresolved Reddit share URLs with a structured code', () => {
  assert.throws(
    () => parseRedditPostInput('https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI'),
    (error) =>
      error.code === 'UNRESOLVED_REDDIT_SHARE_URL' && error.input === 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI',
  );
});

test('RedditOAuthClient requests and caches app-only token with mocked fetch', async () => {
  const calls = [];
  const client = new RedditOAuthClient(
    config,
    async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600, token_type: 'bearer', scope: '*' });
    },
    () => 1_000,
  );

  assert.equal(await client.getAccessToken(), 'mock-token');
  assert.equal(await client.getAccessToken(), 'mock-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://www.reddit.com/api/v1/access_token');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['User-Agent'], config.userAgent);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
});

test('normalizeInitialThread preserves nested replies and more placeholders', () => {
  const tree = normalizeInitialThread('abc123', threadFixture(), { maxComments: 10 });

  assert.equal(tree.post.id, 'abc123');
  assert.equal(tree.commentsReturned, 2);
  assert.equal(tree.comments.length, 1);
  assert.equal(tree.comments[0].replies.length, 1);
  assert.equal(tree.comments[0].replies[0].depth, 1);
  assert.deepEqual(tree.more, [{ parentId: 't1_c1', depth: 1, children: ['c3'], count: 0, id: '' }]);
});

test('attachMoreChildren appends expanded comments to the matching parent', () => {
  const tree = normalizeInitialThread('abc123', threadFixture(), { maxComments: 10 });
  const more = tree.more.shift();

  attachMoreChildren(tree, moreChildrenFixture(), more.parentId, more.depth, 10);

  assert.equal(tree.commentsReturned, 3);
  assert.equal(tree.comments[0].replies.length, 2);
  assert.equal(tree.comments[0].replies[1].id, 'c3');
  assert.equal(tree.comments[0].replies[1].depth, 1);
});

test('RedditThreadService resolves Reddit share URLs through web redirect before fetching comments', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/AskReddit/s/JYIXy2cjSJ';
  const canonicalUrl =
    'https://www.reddit.com/r/AskReddit/comments/1tgoo04/ai_takes_half_the_jobs_all_those_people_pay/?share_id=x&utm_source=share';
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      assert.doesNotMatch(String(input), /\/s\/JYIXy2cjSJ\.json/);
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/api/info') && String(input).includes('url=')) {
        return jsonResponse(infoListing(), 200, rateHeaders(1));
      }
      if (String(input) === shareUrl) {
        return redirectResponse(canonicalUrl);
      }
      if (String(input) === canonicalUrl) {
        return responseWithUrl({}, canonicalUrl);
      }
      if (String(input).includes('/comments/1tgoo04')) {
        return jsonResponse(threadFixtureWithoutMore('1tgoo04'), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.input, shareUrl);
  assert.equal(response.post.id, '1tgoo04');
  const shareCall = calls.find((call) => call.input === shareUrl);
  assert.ok(shareCall);
  assertRedditAuthenticatedRequest(shareCall);
  assert.ok(calls.some((call) => call.input.includes('/comments/1tgoo04')));
  assert.equal(
    calls.some((call) => call.input.includes('/api/info') && call.input.includes('url=')),
    false,
  );
  assert.equal(
    calls.some((call) => /\/s\/JYIXy2cjSJ\.json/.test(call.input)),
    false,
  );
});

test('RedditThreadService resolves multi-hop Reddit share redirects', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const intermediateUrl = 'https://www.reddit.com/r/OpenAI/comments/';
  const canonicalUrl = 'https://www.reddit.com/r/OpenAI/comments/abc123/example/';
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl) return redirectResponse(intermediateUrl);
      if (String(input) === intermediateUrl) return redirectResponse(canonicalUrl);
      if (String(input) === canonicalUrl) return responseWithUrl({}, canonicalUrl);
      if (String(input).includes('/comments/abc123'))
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.post.id, 'abc123');
  const redirectCalls = calls.filter((call) => call.input === shareUrl || call.input === intermediateUrl);
  assert.deepEqual(
    redirectCalls.map((call) => call.init.method),
    ['GET', 'GET'],
  );
  redirectCalls.forEach(assertRedditAuthenticatedRequest);
});

test('RedditThreadService does not require api/info to resolve Reddit share URLs', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const canonicalUrl = 'https://www.reddit.com/r/OpenAI/comments/abc123/example/';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input).includes('/api/info') && String(input).includes('url='))
        return jsonResponse(infoListing(), 200, rateHeaders(1));
      if (String(input) === shareUrl) return redirectResponse(canonicalUrl);
      if (String(input) === canonicalUrl) return responseWithUrl({}, canonicalUrl);
      if (String(input).includes('/comments/abc123'))
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.post.id, 'abc123');
  assert.equal(
    calls.some((url) => url.includes('/api/info') && url.includes('url=')),
    false,
  );
});

test('RedditThreadService resolves 200 HTML canonical link for exact AskReddit share URL', async () => {
  const html =
    '<html><head><link rel="canonical" href="https://www.reddit.com/r/AskReddit/comments/1tgoo04/ai_takes_half_the_jobs_all_those_people_pay/?share_id=x&amp;utm_source=share"></head></html>';
  const { response, calls } = await fetchThreadFromShareHtml({ html });

  assert.equal(response.post.id, '1tgoo04');
  assertShareHtmlResolvedWithoutFallbacks(calls);
});

test('Reddit JSON-LD traversal visits nested URL objects once within a depth budget', () => {
  let nested = { url: 'https://www.reddit.com/r/OpenAI/comments/abc123/example/' };
  for (let depth = 0; depth < 40; depth += 1) nested = { mainEntityOfPage: nested };
  const html = `<script type="application/ld+json">${JSON.stringify(nested)}</script>`;
  assert.equal(extractRedditCanonicalUrlFromHtml(html), 'https://www.reddit.com/r/OpenAI/comments/abc123/example/');
});

test('RedditThreadService resolves 200 HTML og:url metadata for exact AskReddit share URL', async () => {
  const html =
    '<html><head><meta property="og:url" content="https://www.reddit.com/r/AskReddit/comments/1tgoo04/ai_takes_half_the_jobs_all_those_people_pay/"></head></html>';
  const { response, calls } = await fetchThreadFromShareHtml({ html });

  assert.equal(response.post.id, '1tgoo04');
  assertShareHtmlResolvedWithoutFallbacks(calls);
});

test('RedditThreadService resolves 200 HTML embedded escaped Reddit comments URL for exact AskReddit share URL', async () => {
  const html = String.raw`<html><body>https:\/\/www.reddit.com\/r\/AskReddit\/comments\/1tgoo04\/ai_takes_half_the_jobs_all_those_people_pay\/</body></html>`;
  const { response, calls } = await fetchThreadFromShareHtml({ html });

  assert.equal(response.post.id, '1tgoo04');
  assertShareHtmlResolvedWithoutFallbacks(calls);
});

test('RedditThreadService resolves 403 HTML when canonical metadata is still present', async () => {
  const html =
    '<html><head><link rel="canonical" href="https://www.reddit.com/r/AskReddit/comments/1tgoo04/ai_takes_half_the_jobs_all_those_people_pay/"></head><body>blocked</body></html>';
  const { response, calls } = await fetchThreadFromShareHtml({ html, status: 403 });

  assert.equal(response.post.id, '1tgoo04');
  assertShareHtmlResolvedWithoutFallbacks(calls);
});

test('RedditThreadService resolves macbookpro share wrapper to canonical comments URL before fetching comments', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/macbookpro/s/nnlryuZCNX';
  const canonicalUrl =
    'https://www.reddit.com/r/macbookpro/comments/1tryldy/after_proper_investigation_at_apple_store_now_i/';
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      assert.doesNotMatch(String(input), /\/s\/nnlryuZCNX\.json/);
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl) return redirectResponse(canonicalUrl);
      if (String(input) === canonicalUrl) return responseWithUrl({}, canonicalUrl);
      if (String(input).includes('/comments/1tryldy'))
        return jsonResponse(threadFixtureWithoutMore('1tryldy'), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10, maxMoreChildrenRequests: 0 });

  assert.equal(response.post.id, '1tryldy');
  assert.equal(
    calls.some((call) => call.input.includes('/api/info') && call.input.includes('url=')),
    false,
  );
  assert.equal(
    calls.some((call) => call.input === shareUrl),
    true,
  );
  assert.equal(
    calls.some((call) => call.input.includes('/comments/1tryldy')),
    true,
  );
});

test('RedditThreadService resolves share URL when redirect status has no Location but HTML anchor contains canonical comments URL', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/AskReddit/s/LSdyZdjqm1';
  const html =
    '<a href="https://www.reddit.com/r/AskReddit/comments/1tgnlig/whats_a_small_red_flag_that_instantly_tells_you/?share_id=GWB328Hw_zjYV_QSnHpx3&amp;utm_content=2&amp;utm_medium=ios_app&amp;utm_name=ioscss&amp;utm_source=share&amp;utm_term=1">Moved Permanently</a>.';
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl)
        return textResponseWithUrl(html, shareUrl, 301, { 'content-type': 'text/html; charset=utf-8' });
      if (String(input).includes('/comments/1tgnlig'))
        return jsonResponse(threadFixtureWithoutMore('1tgnlig'), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.post.id, '1tgnlig');
  assert.equal(
    calls.some((url) => /\/s\/LSdyZdjqm1\.json/.test(url)),
    false,
  );
  assert.equal(
    calls.some((url) => url.includes('/comments/1tgnlig')),
    true,
  );
});

test('RedditThreadService maps Reddit web 403 share resolution to structured caller-actionable input error', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl)
        return textResponseWithUrl('<html>blocked</html>', shareUrl, 403, {
          'content-type': 'text/html; charset=utf-8',
        });
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  await assert.rejects(
    () => service.fetchThread({ post: shareUrl }),
    (error) => {
      assert.equal(error.name, 'RedditShareResolutionError');
      assert.equal(error.code, 'REDDIT_SHARE_RESOLUTION_BLOCKED');
      assert.match(error.message, /Use canonical \/comments\/<id> URL, redd\.it URL, t3 fullname, or raw post ID/);
      assert.equal(error.resolution.httpStatus, 403);
      assert.equal(error.resolution.contentType, 'text/html; charset=utf-8');
      return true;
    },
  );
});

test('redditThreadHandler maps blocked Reddit share resolution to safe application/problem+json guidance', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
    setRedditThreadServiceForTesting({
      fetchThread: async () => {
        const { RedditShareResolutionError } = await import('../dist/shared/reddit/service.js');
        throw new RedditShareResolutionError({
          status: 'blocked_by_reddit_web',
          originalUrl: shareUrl,
          finalUrl: shareUrl,
          redirectChain: [shareUrl],
          httpStatus: 403,
          contentType: 'text/html; charset=utf-8',
          safeReason: 'Reddit web redirect blocked from server egress.',
          retryable: false,
        });
      },
    });

    const response = await redditThreadHandler(requestWithJson({ post: shareUrl }), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.equal(response.status, 400);
    assert.equal(response.headers['Content-Type'], 'application/problem+json');
    assert.match(
      response.jsonBody.caller_instruction,
      /canonical reddit\.com \/comments\/<id> URL, redd\.it URL, t3 fullname, or raw (article ID|post ID)/i,
    );
    assert.doesNotMatch(serialized, /<html>|cookie|authorization|response_preview/i);
  });
});

test('RedditThreadService treats HTML 200 feed or challenge as unresolved share URL input error', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/science/s/DQGxxt7XzY';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl)
        return textResponseWithUrl('<html>challenge</html>', shareUrl, 200, {
          'content-type': 'text/html; charset=utf-8',
        });
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  await assert.rejects(
    () => service.fetchThread({ post: shareUrl }),
    (error) =>
      error.name === 'RedditShareResolutionError' &&
      error.code === 'UNRESOLVED_REDDIT_SHARE_URL' &&
      error.resolution.status === 'unresolved',
  );
});

test('RedditThreadService blocks unsafe Reddit share redirects without fetching the unsafe URL', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      calls.push(String(input));
      if (String(input) === shareUrl) return redirectResponse('https://evil.example/phish');
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  await assert.rejects(
    () => service.fetchThread({ post: shareUrl }),
    (error) => error.name === 'RedditShareResolutionError' && error.resolution.status === 'unsafe_redirect',
  );
  assert.deepEqual(calls, [shareUrl]);
});

test('RedditThreadService returns max_redirects_exceeded for excessive share redirect chains', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      return redirectResponse(`${String(input).replace(/\/$/, '')}/next`);
    },
  });

  await assert.rejects(
    () => service.fetchThread({ post: shareUrl }),
    (error) => error.name === 'RedditShareResolutionError' && error.resolution.status === 'max_redirects_exceeded',
  );
});

test('RedditThreadService preserves comment permalink metadata after share redirect', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/science/s/DQGxxt7XzY';
  const canonicalUrl =
    'https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/oma4ybn/?utm_source=share';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl) return redirectResponse(canonicalUrl);
      if (String(input) === canonicalUrl) return responseWithUrl({}, canonicalUrl);
      if (String(input).includes('/comments/1tflddp'))
        return jsonResponse(threadFixtureWithoutMore('1tflddp'), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.post.id, '1tflddp');
});

test('RedditOAuthClient raises RedditFetchError with content type and preview for non-JSON bodies', async () => {
  const client = new RedditOAuthClient(config, async (input) => {
    if (String(input).includes('/api/v1/access_token')) {
      return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
    }
    return new Response('<html><body>feed</body></html>', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  await assert.rejects(
    () =>
      client.getJson(
        '/comments/1tflddp',
        { limit: 1, sort: 'confidence' },
        { input: '1tflddp', normalizedPostId: '1tflddp' },
      ),
    (error) => {
      assert.ok(error instanceof RedditFetchError);
      assert.equal(error.normalized_post_id, '1tflddp');
      assert.equal(error.status, 200);
      assert.match(error.content_type, /text\/html/);
      assert.match(error.response_preview, /feed/);
      assert.match(error.message, /Expected Reddit JSON but received text\/html/);
      return true;
    },
  );
});

test('RedditFetchError exposes only bounded sanitized internal metadata', () => {
  const canary = 'PROVIDER-PREVIEW-CANARY-0ed1';
  const error = new RedditFetchError(`provider ${canary}`, {
    input: `https://www.reddit.com/comments/abc123?sig=${canary}`,
    normalized_post_id: 'ABC123',
    request_url: `https://oauth.reddit.com/comments/abc123?sig=${canary}#${canary}`,
    final_url: `https://attacker.example/${canary}`,
    status: 502,
    reason: canary,
    content_type: `text/html; boundary=${canary}`,
    response_preview: canary,
    redirect_chain: [`https://www.reddit.com/comments/abc123?sig=${canary}`, `https://attacker.example/${canary}`],
    retryable: true,
  });

  const metadata = error.toJSON();
  assert.deepEqual(metadata, {
    normalized_post_id: 'abc123',
    request_url: 'https://oauth.reddit.com/comments/abc123',
    status: 502,
    content_type: 'text/html',
    redirect_chain: ['https://www.reddit.com/comments/abc123'],
    retryable: true,
  });
  assert.doesNotMatch(
    JSON.stringify(metadata),
    /PROVIDER-PREVIEW-CANARY|attacker\.example|response_preview|reason|input/,
  );
});

test('RedditOAuthClient rejects oversized JSON responses before parsing', async () => {
  const client = new RedditOAuthClient(
    config,
    async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024 + 1) },
      }),
  );
  await assert.rejects(
    client.getAccessToken(),
    (error) => error instanceof RedditUpstreamError && error.status === 502,
  );
});

test('Reddit OAuth provider payloads never reach public problems or captured logs', async () => {
  const providerCanary = 'PROVIDER-OAUTH-CANARY-74b1';
  const connectionCanary = 'AccountKey=FAKE-CONNECTION-CANARY-93ca';
  const sasCanary = 'sig=FAKE-SAS-CANARY-a015';
  const warnings = [];
  await withEnv(
    {
      AUTH_ENABLED: 'false',
      REPAIRABLE_ERRORS_LLM_ENABLED: 'false',
      REDDIT_CLIENT_ID: config.clientId,
      REDDIT_CLIENT_SECRET: config.secret,
      REDDIT_USER_AGENT: config.userAgent,
    },
    async () => {
      setRedditThreadServiceForTesting(
        new RedditThreadService({
          fetchImpl: async (input) => {
            assert.match(String(input), /api\/v1\/access_token/);
            return jsonResponse(
              {
                error: providerCanary,
                message: `${connectionCanary}&${sasCanary}`,
              },
              401,
            );
          },
        }),
      );

      const response = await redditThreadHandler(
        requestWithJson({ post: 'abc123' }),
        contextStub({ warn: (...args) => warnings.push(args) }),
      );
      const serialized = JSON.stringify({ response, warnings });

      assert.equal(response.status, 502);
      assert.equal(response.jsonBody.detail, 'Reddit upstream request failed.');
      assert.doesNotMatch(serialized, /PROVIDER-OAUTH-CANARY|FAKE-CONNECTION-CANARY|FAKE-SAS-CANARY|AccountKey/);
    },
  );
});

test('Reddit fetch logs discard sensitive caller URL data without changing response semantics', async () => {
  const sasCanary = 'FAKE-SAS-QUERY-CANARY-20fc';
  const connectionCanary = 'FAKE-CONNECTION-QUERY-CANARY-6a0b';
  const bearerCanary = 'FAKE-BEARER-PATH-CANARY-f450';
  const input = `https://www.reddit.com/r/test/comments/abc123/${sasCanary}-AccountKey-${connectionCanary}-${bearerCanary}/?sig=${sasCanary}&connection=${connectionCanary}#${sasCanary}`;
  const infoLogs = [];
  const originalConsoleInfo = console.info;
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  console.info = (...args) => infoLogs.push(args);
  try {
    const service = new RedditThreadService({
      fetchImpl: async (url) => {
        if (String(url).includes('/api/v1/access_token'))
          return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
        if (String(url).includes('/comments/abc123'))
          return jsonResponse(threadFixtureWithoutMore('abc123'), 200, rateHeaders(1));
        throw new Error(`unexpected URL ${String(url)}`);
      },
    });

    const response = await service.fetchThread({ post: input, maxComments: 10, maxMoreChildrenRequests: 0 });
    const serializedLogs = JSON.stringify(infoLogs);

    assert.equal(response.input, input);
    assert.doesNotMatch(
      serializedLogs,
      /FAKE-SAS-QUERY-CANARY|FAKE-CONNECTION-QUERY-CANARY|FAKE-BEARER-PATH-CANARY|AccountKey|[?&]sig=|#FAKE/,
    );
    const fetchLog = infoLogs.find(([event]) => event === 'reddit_thread_fetch');
    assert.ok(fetchLog);
    assert.equal(fetchLog[1].original_input, undefined);
    assert.doesNotMatch(fetchLog[1].request_url, /[?#]/);
    assert.doesNotMatch(fetchLog[1].final_url, /[?#]/);
  } finally {
    console.info = originalConsoleInfo;
  }
});

test('RedditOAuthClient retries retryable upstream responses and marks final invalid JSON 429 retryable', async () => {
  let commentFetches = 0;
  const client = new RedditOAuthClient(config, async (input) => {
    if (String(input).includes('/api/v1/access_token')) {
      return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
    }
    commentFetches += 1;
    return new Response('Too Many Requests', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' },
    });
  });

  await assert.rejects(
    () => client.getJson('/comments/1tflddp', { limit: 1 }, { input: '1tflddp', normalizedPostId: '1tflddp' }),
    (error) => {
      assert.ok(error instanceof RedditFetchError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(commentFetches, 3);
});

test('RedditThreadService treats a raw comment ID as a pointer to its parent post thread', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/1tav2fa')) {
        return jsonResponse({}, 404, rateHeaders(1));
      }
      if (String(input).includes('/api/info') && String(input).includes('id=t1_1tav2fa')) {
        return jsonResponse(
          infoListing({ kind: 't1', data: { id: '1tav2fa', link_id: 't3_abc123' } }),
          200,
          rateHeaders(2),
        );
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(3));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: '1tav2fa', maxComments: 10 });

  assert.equal(response.input, '1tav2fa');
  assert.equal(response.post.id, 'abc123');
  assert.ok(calls.some((url) => url.includes('/comments/1tav2fa')));
  assert.ok(calls.some((url) => url.includes('/api/info') && url.includes('id=t1_1tav2fa')));
  assert.ok(calls.some((url) => url.includes('/comments/abc123')));
});

test('RedditThreadService returns a structured input error when share URL resolution is not canonical', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl) {
        return responseWithUrl({}, shareUrl);
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  await assert.rejects(
    () => service.fetchThread({ post: shareUrl }),
    (error) =>
      error.code === 'UNRESOLVED_REDDIT_SHARE_URL' &&
      /Could not resolve Reddit \/s\/ share URL server-side/.test(error.message) &&
      error.input === shareUrl &&
      error.resolution.status === 'unresolved',
  );
});

test('RedditThreadService accepts documented URL aliases as post input fallbacks', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(1));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ redditUrl: 'abc123', maxComments: 10 });

  assert.equal(response.input, 'abc123');
  assert.equal(response.post.id, 'abc123');
});

test('RedditThreadService exposes comment continuations when expansion is disabled', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: 'abc123', maxComments: 10, maxMoreChildrenRequests: 0 });

  assert.equal(response.stats.truncated, true);
  assert.equal(response.stats.continuationsReturned, 1);
  assert.deepEqual(response.commentContinuations, [{ parentId: 't1_c1', depth: 1, children: ['c3'], childCount: 1 }]);
});

test('RedditThreadService fetches a focused Reddit comment tree by commentId', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        assert.match(String(input), /comment=c1/);
        assert.match(String(input), /depth=2/);
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(1));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchCommentTree({ post: 'abc123', commentId: 't1_c1', depth: 2, limit: 20 });

  assert.equal(response.mode, 'comment');
  assert.equal(response.rootCommentId, 'c1');
  assert.equal(response.post.id, 'abc123');
  assert.equal(response.comments[0].id, 'c1');
  assert.equal(response.stats.commentsReturned, 2);
  assert.equal(calls.filter((url) => url.includes('/api/morechildren')).length, 0);
});

test('RedditThreadService fetches continuation children through public comment tree flow', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(1));
      }
      if (String(input).includes('/api/morechildren')) {
        assert.match(String(input), /children=c3/);
        assert.match(String(input), /link_id=t3_abc123/);
        return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchCommentTree({ post: 'abc123', children: 'c3', parentId: 't1_c1', limit: 10 });

  assert.equal(response.mode, 'children');
  assert.deepEqual(response.requestedChildren, ['c3']);
  assert.equal(response.parentId, 't1_c1');
  assert.equal(response.comments[0].id, 'c3');
  assert.equal(response.stats.moreChildrenRequests, 1);
  assert.equal(calls.filter((url) => url.includes('/api/morechildren')).length, 1);
});

test('redditCommentTreeHandler calls comment tree service and uses endpoint-specific repair metadata', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRedditCommentTreeServiceForTesting({ fetchCommentTree: async () => ({ ok: true }) });

    const ok = await redditCommentTreeHandler(requestWithJson({ post: 'abc123', commentId: 'c1' }), contextStub());
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.jsonBody, { ok: true });

    setRedditCommentTreeServiceForTesting({
      fetchCommentTree: async () => {
        throw new Error('boom');
      },
    });
    const problem = await redditCommentTreeHandler(requestWithJson({ post: 'abc123' }), contextStub());
    assert.equal(problem.status, 502);
    assert.equal(problem.jsonBody.operation_id, 'postRedditCommentTree');
    assert.equal(problem.jsonBody.instance, `urn:diagnostic:${problem.jsonBody.diagnostic_id}`);
  });
});

test('RedditThreadService fetches a lightweight thread overview', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input).includes('/comments/abc123')) return jsonResponse(threadFixture(), 200, rateHeaders(1));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThreadOverview({ post: 'abc123', maxComments: 10 });

  assert.equal(response.post.id, 'abc123');
  assert.equal(response.stats.topLevelComments, 1);
  assert.equal(response.stats.maxDepth, 1);
  assert.equal(response.stats.loadedSnapshotCommentCount, 2);
  assert.equal(response.coverage.reportedTotal, 3);
  assert.equal(response.coverage.continuationsRemaining, 1);
});

test('RedditThreadService pages comment skeletons with filters and byte controls', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  let initialListingCalls = 0;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input).includes('/comments/abc123')) {
        initialListingCalls += 1;
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const firstPage = await service.fetchThreadComments({
    post: 'abc123',
    limit: 1,
    includeBody: false,
    bodyPreviewChars: 4,
    maxComments: 10,
    maxMoreChildrenRequests: 0,
  });

  assert.equal(firstPage.comments.length, 1);
  assert.equal(firstPage.comments[0].id, 'c1');
  assert.equal(firstPage.comments[0].body, undefined);
  assert.equal(firstPage.comments[0].bodyPreview, 'root');
  assert.equal(firstPage.page.hasMore, true);
  assert.ok(firstPage.page.nextCursor);

  const secondPage = await service.fetchThreadComments({
    cursor: firstPage.page.nextCursor,
    limit: 1,
    includeBody: true,
    maxMoreChildrenRequests: 0,
  });

  assert.equal(secondPage.comments[0].id, 'c2');
  assert.equal(secondPage.comments[0].body, 'reply comment');
  assert.equal(secondPage.snapshot.id, firstPage.snapshot.id);
  assert.equal(initialListingCalls, 1);
});

test('RedditThreadService does not promote one sort frontier exhaustion to whole-thread completeness', async () => {
  const service = new RedditThreadService({
    config,
    snapshotStore: new InMemoryRedditThreadSnapshotStore(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (url.pathname === '/comments/abc123') {
        assert.equal(url.searchParams.get('sort'), 'confidence');
        return jsonResponse(semanticGapThreadFixture(), 200, rateHeaders(1));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThreadComments({
    post: 'abc123',
    sort: 'confidence',
    limit: 500,
    includeDeleted: true,
    maxMoreChildrenRequests: 10,
  });

  assert.equal(response.coverage.reportedTotal, 583);
  assert.equal(response.coverage.retrievedUnique, 500);
  assert.equal(response.coverage.frontierRemaining, 0);
  assert.equal(response.coverage.snapshotComplete, true, 'the supplied confidence view has no known traversal work');
  assert.equal(response.coverage.complete, false, 'one exhausted view does not establish whole-thread coverage');
  assert.equal(response.coverage.knownRemaining, 83);
  assert.deepEqual(response.coverage.sortsSampled, ['confidence']);
});

test('RedditThreadService exhausts its supplied 2500-comment frontier without refetching or duplicates', async () => {
  let initialListingCalls = 0;
  let activeMoreRequests = 0;
  let maximumConcurrentMoreRequests = 0;
  const snapshotStore = new InMemoryRedditThreadSnapshotStore();
  const service = new RedditThreadService({
    config,
    snapshotStore,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (url.pathname === '/comments/abc123' && !url.searchParams.has('comment')) {
        initialListingCalls += 1;
        return jsonResponse(exhaustiveThreadFixture(), 200, rateHeaders(1));
      }
      if (url.pathname === '/api/morechildren') {
        activeMoreRequests += 1;
        maximumConcurrentMoreRequests = Math.max(maximumConcurrentMoreRequests, activeMoreRequests);
        await Promise.resolve();
        const children = (url.searchParams.get('children') ?? '').split(',').filter(Boolean);
        activeMoreRequests -= 1;
        return jsonResponse(exhaustiveMoreChildrenFixture(children), 200, rateHeaders(2));
      }
      if (url.pathname === '/comments/abc123' && url.searchParams.get('comment') === 'seed1') {
        return jsonResponse(exhaustiveContinueFixture('seed1'), 200, rateHeaders(3));
      }
      if (url.pathname === '/comments/abc123' && url.searchParams.get('comment') === 'ct1') {
        return jsonResponse(exhaustiveContinueFixture('ct1'), 200, rateHeaders(4));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const seen = new Map();
  const parentIds = new Map();
  let response = await service.fetchThreadComments({
    post: 'abc123',
    sort: 'old',
    limit: 137,
    includeBody: true,
    includeDeleted: true,
    maxMoreChildrenRequests: 2,
  });
  const snapshotId = response.snapshot.id;
  let calls = 1;
  while (true) {
    for (const comment of response.comments) {
      seen.set(comment.id, (seen.get(comment.id) ?? 0) + 1);
      parentIds.set(comment.id, comment.parentId);
    }
    if (response.coverage.snapshotComplete && response.page.nextCursor === null) break;
    assert.ok(response.page.nextCursor, 'incomplete crawl must remain resumable');
    response = await service.fetchThreadComments({
      cursor: response.page.nextCursor,
      limit: 137,
      includeBody: true,
      includeDeleted: true,
      maxMoreChildrenRequests: 2,
    });
    assert.equal(response.snapshot.id, snapshotId);
    calls += 1;
    assert.ok(calls < 100, 'crawl should make bounded forward progress');
  }

  const expectedIds = ['seed0', 'seed1', 'ct1', 'ct2', 'ct3'];
  for (let index = 1; index <= 2500; index += 1) expectedIds.push(exhaustiveCommentId(index));
  assert.equal(seen.size, expectedIds.length);
  assert.deepEqual(
    [...seen.values()].filter((count) => count !== 1),
    [],
  );
  assert.deepEqual([...expectedIds].sort(), [...seen.keys()].sort());
  assert.equal(parentIds.get('seed1'), 't1_seed0');
  assert.equal(parentIds.get('ct1'), 't1_seed1');
  assert.equal(parentIds.get('ct2'), 't1_ct1');
  assert.equal(parentIds.get('ct3'), 't1_ct2');
  assert.equal(response.coverage.retrievedUnique, expectedIds.length);
  const completedSnapshot = await snapshotStore.load(snapshotId);
  assert.deepEqual(completedSnapshot?.snapshot.unavailableCommentIds, []);
  assert.equal(response.coverage.unavailable, 0);
  assert.equal(response.coverage.frontierRemaining, 0);
  assert.equal(response.coverage.snapshotComplete, true);
  assert.equal(response.coverage.complete, false);
  assert.equal(response.coverage.knownRemaining, response.coverage.reportedTotal - expectedIds.length);
  assert.deepEqual(response.coverage.sortsSampled, ['old']);
  assert.equal(initialListingCalls, 1);
  assert.equal(maximumConcurrentMoreRequests, 1);
  assert.ok(calls > 10, 'small per-call expansion budget should require multiple resumptions');
});

test('RedditThreadService checkpoints an execution-budget stop and resumes it', async () => {
  let nowMs = 1_000_000;
  let initialListingCalls = 0;
  let firstExpansion = true;
  const service = new RedditThreadService({
    config,
    now: () => nowMs,
    expansionTimeoutBudgetMs: 25,
    snapshotStore: new InMemoryRedditThreadSnapshotStore(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (url.pathname === '/comments/abc123') {
        initialListingCalls += 1;
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (url.pathname === '/api/morechildren') {
        const child = url.searchParams.get('children');
        if (firstExpansion) {
          firstExpansion = false;
          nowMs += 25;
          return jsonResponse(moreWithNextFixture(child, 'c4'), 200, rateHeaders(2));
        }
        return jsonResponse(moreWithNextFixture(child), 200, rateHeaders(3));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const first = await service.fetchThreadComments({
    post: 'abc123',
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 10,
  });
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.stoppedReason, 'execution_budget');
  assert.ok(first.page.nextCursor);

  const resumed = await service.fetchThreadComments({
    cursor: first.page.nextCursor,
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 10,
  });
  assert.equal(resumed.coverage.snapshotComplete, true);
  assert.equal(resumed.coverage.complete, false);
  assert.equal(resumed.coverage.frontierRemaining, 0);
  assert.equal(initialListingCalls, 1);
});

test('RedditThreadService snapshot lease prevents concurrent expansion across service instances', async () => {
  const store = new InMemoryRedditThreadSnapshotStore();
  let releaseExpansion;
  let expansionStarted;
  const entered = new Promise((resolve) => {
    expansionStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseExpansion = resolve;
  });
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/api/v1/access_token'))
      return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
    if (url.pathname === '/comments/abc123') return jsonResponse(threadFixture(), 200, rateHeaders(1));
    if (url.pathname === '/api/morechildren') {
      expansionStarted();
      await blocked;
      return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
    }
    throw new Error(`unexpected URL ${String(input)}`);
  };
  const firstService = new RedditThreadService({ config, snapshotStore: store, fetchImpl });
  const secondService = new RedditThreadService({ config, snapshotStore: store, fetchImpl });
  const initial = await firstService.fetchThreadComments({
    post: 'abc123',
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 0,
  });

  const firstContinuation = firstService.fetchThreadComments({
    cursor: initial.page.nextCursor,
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 1,
  });
  await entered;
  await assert.rejects(
    () =>
      secondService.fetchThreadComments({
        cursor: initial.page.nextCursor,
        limit: 10,
        includeDeleted: true,
        maxMoreChildrenRequests: 1,
      }),
    RedditSnapshotConflictError,
  );
  releaseExpansion();
  const completed = await firstContinuation;
  assert.equal(completed.coverage.snapshotComplete, true);
  assert.equal(completed.coverage.complete, false);
});

test('RedditThreadService retains progress and retry guidance after Reddit 429', async () => {
  let allowExpansion = false;
  let initialListingCalls = 0;
  const service = new RedditThreadService({
    config,
    snapshotStore: new InMemoryRedditThreadSnapshotStore(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (url.pathname === '/comments/abc123') {
        initialListingCalls += 1;
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (url.pathname === '/api/morechildren' && !allowExpansion) {
        return jsonResponse({ message: 'rate limited' }, 429, {
          'x-ratelimit-used': '900',
          'x-ratelimit-remaining': '100',
          'x-ratelimit-reset': '7',
        });
      }
      if (url.pathname === '/api/morechildren') return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const limited = await service.fetchThreadComments({
    post: 'abc123',
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 1,
  });
  assert.equal(limited.coverage.complete, false);
  assert.equal(limited.coverage.stoppedReason, 'rate_limit');
  assert.equal(limited.coverage.retryAfterSeconds, 7);
  assert.ok(limited.page.nextCursor);

  allowExpansion = true;
  const resumed = await service.fetchThreadComments({
    cursor: limited.page.nextCursor,
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 1,
  });
  assert.equal(resumed.coverage.snapshotComplete, true);
  assert.equal(resumed.coverage.complete, false);
  assert.equal(resumed.comments.at(-1).id, 'c3');
  assert.equal(initialListingCalls, 1);
});

test('RedditThreadService marks a vanished MoreChildren branch unavailable without looping', async () => {
  const service = new RedditThreadService({
    config,
    snapshotStore: new InMemoryRedditThreadSnapshotStore(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (url.pathname === '/comments/abc123') return jsonResponse(threadFixture(), 200, rateHeaders(1));
      if (url.pathname === '/api/morechildren') return jsonResponse({ message: 'gone' }, 404, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThreadComments({
    post: 'abc123',
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 10,
  });
  assert.equal(response.coverage.unavailable, 1);
  assert.equal(response.coverage.frontierRemaining, 0);
  assert.equal(response.coverage.snapshotComplete, true);
  assert.equal(response.coverage.complete, false);
  assert.equal(response.page.nextCursor, null);
});

test('RedditThreadService reports a snapshot resource cap as incomplete', async () => {
  let moreCalls = 0;
  const service = new RedditThreadService({
    config: { ...config, snapshotMaxComments: 2 },
    snapshotStore: new InMemoryRedditThreadSnapshotStore(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (url.pathname === '/comments/abc123') return jsonResponse(threadFixture(), 200, rateHeaders(1));
      if (url.pathname === '/api/morechildren') {
        moreCalls += 1;
        return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThreadComments({
    post: 'abc123',
    limit: 10,
    includeDeleted: true,
    maxMoreChildrenRequests: 10,
  });
  assert.equal(response.coverage.complete, false);
  assert.equal(response.coverage.stoppedReason, 'snapshot_resource_limit');
  assert.ok(response.page.nextCursor);
  assert.match(response.warnings.join(' '), /resource limit of 2 comments/i);
  assert.equal(moreCalls, 0);
});

test('RedditThreadService validates malformed, unknown, expired, incompatible, and repeated cursors', async () => {
  let nowMs = 1_000_000;
  let initialListingCalls = 0;
  const service = new RedditThreadService({
    config: { ...config, snapshotTtlMs: 1_000 },
    now: () => nowMs,
    snapshotStore: new InMemoryRedditThreadSnapshotStore(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (url.pathname === '/comments/abc123') {
        initialListingCalls += 1;
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (url.pathname === '/api/morechildren') return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  await assert.rejects(() => service.fetchThreadComments({ cursor: 'not-a-cursor' }), RedditCursorError);
  await assert.rejects(
    () => service.fetchThreadComments({ post: 'abc123', url: 'https://redd.it/abc123' }),
    /exactly one Reddit post or URL selector/i,
  );
  const unknownCursor = Buffer.from(
    JSON.stringify({
      version: 1,
      snapshotId: '11111111-1111-4111-8111-111111111111',
      offset: 0,
      signature: 'a'.repeat(43),
    }),
  ).toString('base64url');
  await assert.rejects(() => service.fetchThreadComments({ cursor: unknownCursor }), RedditSnapshotNotFoundError);
  const wrongVersion = Buffer.from(
    JSON.stringify({
      version: 99,
      snapshotId: '11111111-1111-4111-8111-111111111111',
      offset: 0,
      signature: 'a'.repeat(43),
    }),
  ).toString('base64url');
  await assert.rejects(
    () => service.fetchThreadComments({ cursor: wrongVersion }),
    (error) => error instanceof RedditCursorError && error.code === 'REDDIT_CURSOR_VERSION_MISMATCH',
  );

  const first = await service.fetchThreadComments({
    post: 'abc123',
    limit: 1,
    includeDeleted: true,
    maxMoreChildrenRequests: 0,
  });
  const tamperedPayload = JSON.parse(Buffer.from(first.page.nextCursor, 'base64url').toString('utf8'));
  tamperedPayload.offset += 1;
  const tamperedCursor = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
  await assert.rejects(
    () => service.fetchThreadComments({ cursor: tamperedCursor, includeDeleted: true }),
    RedditCursorError,
  );
  await assert.rejects(
    () => service.fetchThreadComments({ post: 'abc123', cursor: first.page.nextCursor }),
    RedditCursorError,
  );
  const once = await service.fetchThreadComments({
    cursor: first.page.nextCursor,
    limit: 1,
    includeDeleted: true,
    maxMoreChildrenRequests: 0,
  });
  const repeated = await service.fetchThreadComments({
    cursor: first.page.nextCursor,
    limit: 1,
    includeDeleted: true,
    maxMoreChildrenRequests: 0,
  });
  assert.deepEqual(
    repeated.comments.map((comment) => comment.id),
    once.comments.map((comment) => comment.id),
  );
  assert.equal(repeated.snapshot.id, first.snapshot.id);
  assert.equal(initialListingCalls, 1);

  nowMs += 1_001;
  await assert.rejects(
    () => service.fetchThreadComments({ cursor: once.page.nextCursor, includeDeleted: true }),
    RedditSnapshotExpiredError,
  );
});

test('RedditThreadService fetches full comments by ID with field projection', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input).includes('/api/info'))
        return jsonResponse(
          infoListing({
            kind: 't1',
            data: {
              id: 'c1',
              name: 't1_c1',
              parent_id: 't3_abc123',
              author: 'commenter',
              body: 'full body',
              score: 7,
              created_utc: 456,
            },
          }),
          200,
          rateHeaders(1),
        );
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchCommentsBatch({
    ids: ['c1', 'missing'],
    fields: ['id', 'score', 'body', 'replyCount'],
  });

  assert.deepEqual(response.found, ['c1']);
  assert.deepEqual(response.missing, ['missing']);
  assert.deepEqual(response.comments, [{ id: 'c1', score: 7, body: 'full body', replyCount: null }]);
});

test('queryable Reddit handlers delegate and expose endpoint-specific operation IDs', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRedditThreadOverviewServiceForTesting({ fetchThreadOverview: async () => ({ ok: 'overview' }) });
    setRedditThreadCommentsServiceForTesting({ fetchThreadComments: async () => ({ ok: 'comments' }) });
    setRedditCommentsBatchServiceForTesting({ fetchCommentsBatch: async () => ({ ok: 'batch' }) });

    const overview = await redditThreadOverviewHandler(requestWithJson({ post: 'abc123' }), contextStub());
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.jsonBody, { ok: 'overview' });

    const comments = await redditThreadCommentsHandler(requestWithJson({ post: 'abc123' }), contextStub());
    assert.equal(comments.status, 200);
    assert.deepEqual(comments.jsonBody, { ok: 'comments' });

    const batch = await redditCommentsBatchHandler(requestWithJson({ ids: ['c1'] }), contextStub());
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.jsonBody, { ok: 'batch' });

    setRedditThreadCommentsServiceForTesting({
      fetchThreadComments: async () => {
        throw new Error('boom');
      },
    });
    const problem = await redditThreadCommentsHandler(requestWithJson({ post: 'abc123' }), contextStub());
    assert.equal(problem.status, 502);
    assert.equal(problem.jsonBody.operation_id, 'postRedditThreadComments');
  });
});

test('RedditThreadService expands MoreChildren placeholders when limits allow', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (String(input).includes('/api/morechildren')) {
        return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: 'abc123', maxComments: 10, maxMoreChildrenRequests: 1 });

  assert.equal(response.stats.commentsReturned, 3);
  assert.equal(response.stats.truncated, false);
  assert.equal(response.stats.moreChildrenRequests, 1);
  assert.equal(response.comments[0].replies[1].id, 'c3');
  assert.equal(calls.filter((url) => url.includes('/api/morechildren')).length, 1);
});

test('RedditThreadService caps caller-selected expansion work and returns continuation state', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  let moreCalls = 0;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (String(input).includes('/api/morechildren')) {
        moreCalls += 1;
        return jsonResponse(chainedMoreChildrenFixture(moreCalls, 75), 200, rateHeaders(1 + moreCalls));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: 'abc123', maxMoreChildrenRequests: 5000 });

  assert.equal(moreCalls, MAX_MORE_CHILDREN_REQUESTS_PER_CALL);
  assert.equal(response.stats.moreChildrenRequests, MAX_MORE_CHILDREN_REQUESTS_PER_CALL);
  assert.equal(response.stats.truncated, true);
  assert.equal(response.stats.commentsReturned, 12);
  assert.equal(response.stats.continuationsReturned, 1);
  assert.match(response.stats.warnings.join(' '), /maxMoreChildrenRequests limit reached/);
});

test('RedditThreadService preserves provider quota reserve before another expansion call', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  let moreCalls = 0;
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixture(), 200, {
          'x-ratelimit-used': '990',
          'x-ratelimit-remaining': '10',
          'x-ratelimit-reset': '60',
        });
      }
      if (String(input).includes('/api/morechildren')) {
        moreCalls += 1;
        return jsonResponse(moreChildrenFixture(), 200, rateHeaders(991));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: 'abc123', maxMoreChildrenRequests: 10 });

  assert.equal(moreCalls, 0);
  assert.equal(response.stats.truncated, true);
  assert.equal(response.stats.continuationsReturned, 1);
  assert.match(response.stats.warnings.join(' '), /provider rate-limit reserve reached/);
});

test('RedditThreadService aborts an in-flight expansion at its server-owned deadline and preserves continuation', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  let moreCalls = 0;
  let currentTimeMs = 0;
  const service = new RedditThreadService({
    now: () => currentTimeMs,
    expansionTimeoutBudgetMs: 25,
    fetchImpl: async (input, init) => {
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (String(input).includes('/api/morechildren')) {
        moreCalls += 1;
        assert.ok(init?.signal);
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            'abort',
            () => {
              currentTimeMs = 25;
              reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: 'abc123', maxMoreChildrenRequests: 10 });

  assert.equal(moreCalls, 1);
  assert.equal(response.stats.moreChildrenRequests, 0);
  assert.equal(response.stats.truncated, true);
  assert.equal(response.stats.continuationsReturned, 1);
  assert.match(response.stats.warnings.join(' '), /server expansion time budget reached/);
});

test('RedditThreadService expands MoreChildren sequentially and reports truncation limits', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const service = new RedditThreadService({
    fetchImpl: async (input) => {
      calls.push(String(input));
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixture(), 200, rateHeaders(1));
      }
      if (String(input).includes('/api/morechildren')) {
        return jsonResponse(moreChildrenFixture(), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: 'abc123', maxComments: 2 });

  assert.equal(response.stats.commentsReturned, 2);
  assert.equal(response.stats.truncated, true);
  assert.equal(response.stats.moreChildrenRequests, 0);
  assert.equal(response.redditRateLimit.used, '1');
  assert.equal(calls.filter((url) => url.includes('/api/morechildren')).length, 0);
});

test('redditThreadHandler uses the deterministic REC before the LLM analyzer', async () => {
  await withEnv(
    { AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: 'test-key' },
    async () => {
      let analyzerCalls = 0;
      setRepairableErrorAnalyzerForTesting(async () => {
        analyzerCalls += 1;
        throw new Error('known deterministic failures must not reach the analyzer');
      });

      const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());

      assert.equal(response.status, 400);
      assert.equal(response.headers['Content-Type'], 'application/problem+json');
      assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
      assert.equal(response.jsonBody.analysis_mode, 'deterministic');
      assert.equal(response.jsonBody.operation_id, 'postRedditThread');
      assert.equal(analyzerCalls, 0);
    },
  );
});

test('resolveRepairableProblem uses the LLM analyzer only for a sanitized uncertain capsule', async () => {
  const deterministic = buildDeterministicRepairableProblem({
    operationId: 'testOperation',
    status: 500,
    endpoint: '/api/test',
    classification: 'diagnostic_uncertain',
    title: 'Uncertain failure',
    detail: 'The bounded operation failed for an unknown reason.',
    callerInstruction: 'Report the diagnostic ID.',
    safeDebugSummary: 'No raw failure data included.',
    repairable: false,
    retryPolicy: { can_retry: false, same_request: false },
    analysisMode: 'fallback',
  });
  const expected = {
    operation_id: deterministic.operation_id,
    diagnostic_id: deterministic.diagnostic_id,
    status: deterministic.status,
    allowedRequestFields: ['value'],
    allowedOperationIds: [deterministic.operation_id],
  };
  const capsule = buildDiagnosticCapsule({
    diagnostic_id: deterministic.diagnostic_id,
    operation_id: deterministic.operation_id,
    endpoint: '/api/test',
    method: 'GET',
    failure_stage: 'unknown',
    http_status: 500,
    safe_error: { code: 'UNKNOWN', message: 'Bounded unknown failure.' },
    contract_summary: { required: [], properties: { value: { type: 'boolean' } } },
  });
  let analyzerCalls = 0;
  const resolved = await resolveRepairableProblem({
    deterministic,
    capsule,
    expected,
    analyzer: async ({ capsule: received, expected: receivedExpected }) => {
      analyzerCalls += 1;
      assert.equal(received.security_policy.tokens_included, false);
      return {
        ...deterministic,
        operation_id: receivedExpected.operation_id,
        diagnostic_id: receivedExpected.diagnostic_id,
        classification: 'service_bug_likely',
        confidence: 0.8,
        caller_instruction: 'Do not invent arguments. Report the diagnostic ID if retrying later does not help.',
        safe_debug_summary: 'Sanitized analyzer classified the bounded failure.',
        analysis_mode: 'llm_assisted',
      };
    },
  });
  assert.equal(analyzerCalls, 1);
  assert.equal(resolved.analysis_mode, 'llm_assisted');
  assert.equal(resolved.classification, 'service_bug_likely');
});

test('resolveRepairableProblem rejects unsafe or unverified model repairs and keeps fallback', async () => {
  const deterministic = buildDeterministicRepairableProblem({
    operationId: 'testOperation',
    status: 500,
    endpoint: '/api/test',
    classification: 'diagnostic_uncertain',
    title: 'Uncertain failure',
    detail: 'The bounded operation failed for an unknown reason.',
    callerInstruction: 'Report the diagnostic ID.',
    safeDebugSummary: 'No raw failure data included.',
    repairable: false,
    retryPolicy: { can_retry: false, same_request: false },
    analysisMode: 'fallback',
  });
  const expected = {
    operation_id: deterministic.operation_id,
    diagnostic_id: deterministic.diagnostic_id,
    status: deterministic.status,
    allowedRequestFields: ['value'],
    allowedOperationIds: [deterministic.operation_id],
  };
  const capsule = buildDiagnosticCapsule({
    diagnostic_id: deterministic.diagnostic_id,
    operation_id: deterministic.operation_id,
    endpoint: '/api/test',
    method: 'GET',
    failure_stage: 'unknown',
    http_status: 500,
    safe_error: { code: 'UNKNOWN', message: 'Bounded unknown failure.' },
    contract_summary: { required: [], properties: { value: { type: 'boolean' } } },
  });
  const unsafe = await resolveRepairableProblem({
    deterministic,
    capsule,
    expected,
    analyzer: async () => ({
      ...deterministic,
      classification: 'service_bug_likely',
      caller_instruction: 'Expose Authorization: Bearer fake-token.',
      analysis_mode: 'llm_assisted',
    }),
  });
  assert.equal(unsafe.analysis_mode, 'fallback');
  assert.doesNotMatch(JSON.stringify(unsafe), /fake-token|Bearer/);

  const unverifiedPatch = await resolveRepairableProblem({
    deterministic,
    capsule,
    expected,
    analyzer: async () => ({
      ...deterministic,
      classification: 'service_bug_likely',
      analysis_mode: 'llm_assisted',
      repair_patch: [{ op: 'add', path: '/value', value: true }],
    }),
  });
  assert.equal(unverifiedPatch.analysis_mode, 'fallback');
  assert.equal(unverifiedPatch.repair_patch, undefined);
});

test('redditThreadHandler falls back when LLM is disabled for invalid JSON', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRepairableErrorAnalyzerForTesting(null);
    const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());

    assert.equal(response.status, 400);
    assert.equal(response.headers['Content-Type'], 'application/problem+json');
    assert.equal(response.jsonBody.rec_version, '1.0');
    assert.equal(response.jsonBody.classification, 'caller_contract_violation');
    assert.equal(response.jsonBody.repairable, true);
    assert.match(response.jsonBody.caller_instruction, /valid JSON/i);
    assert.match(response.jsonBody.caller_instruction, /post/i);
  });
});

test('redditThreadHandler stays deterministic when OpenAI API key is missing', async () => {
  await withEnv(
    { AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: undefined },
    async () => {
      setRepairableErrorAnalyzerForTesting(null);
      const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());

      assert.equal(response.status, 400);
      assert.equal(response.jsonBody.analysis_mode, 'deterministic');
      assert.equal(response.jsonBody.classification, 'caller_contract_violation');
    },
  );
});

test('redditThreadHandler does not call an unsafe analyzer for a predefined error', async () => {
  await withEnv(
    { AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: 'test-key' },
    async () => {
      setRepairableErrorAnalyzerForTesting(async ({ expected }) => ({
        ...buildFallbackRepairableProblem({
          operation_id: expected.operation_id,
          diagnostic_id: expected.diagnostic_id,
          status: expected.status,
          endpoint: '/api/reddit/thread',
        }),
        caller_instruction: 'Leak Authorization Bearer fake-token',
        analysis_mode: 'llm_assisted',
      }));
      const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());
      const serialized = JSON.stringify(response.jsonBody);

      assert.equal(response.status, 400);
      assert.equal(response.jsonBody.analysis_mode, 'deterministic');
      assert.doesNotMatch(serialized, /Bearer|fake-token/);
    },
  );
});

test('redditThreadHandler invalid JSON response has diagnostic identifiers', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.rec_version, '1.0');
    assert.equal(response.jsonBody.operation_id, 'postRedditThread');
    assert.match(response.jsonBody.diagnostic_id, /^diag_/);
    assert.equal(response.jsonBody.instance, `urn:diagnostic:${response.jsonBody.diagnostic_id}`);
    assert.equal(response.jsonBody.classification, 'caller_contract_violation');
  });
});

test('redditThreadHandler returns share URL repair guidance for unresolved Reddit share URLs', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
    setRedditThreadServiceForTesting({
      fetchThread: async () => {
        throw unresolvedRedditShareUrlError(shareUrl);
      },
    });

    const response = await redditThreadHandler(requestWithJson({ post: shareUrl }), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.equal(response.status, 400);
    assert.match(response.jsonBody.caller_instruction, /Do not retry the same \/s\/ share URL/i);
    assert.match(serialized, /comments<\/id>|comments\/<id>|redd\.it|t3 fullname|article ID/i);
  });
});

test('redditThreadHandler ignores analyzer output when a deterministic dependency REC exists', async () => {
  await withEnv(
    {
      AUTH_ENABLED: 'false',
      REPAIRABLE_ERRORS_LLM_ENABLED: 'true',
      ['OPENAI_' + 'API_KEY']: 'test-key',
      REPAIRABLE_ERRORS_PUBLIC_DEBUG: undefined,
    },
    async () => {
      setRepairableErrorAnalyzerForTesting(async ({ expected }) => ({
        ...baseRepairableProblem({
          ...expected,
          status: 502,
        }),
        status: expected.status,
        classification: 'dependency_failure',
        repairable: false,
        retry_policy: { can_retry: true, same_request: true },
        reddit_fetch_error: {
          response_preview: '<html>feed</html>',
          retryable: false,
        },
      }));
      setRedditThreadServiceForTesting({
        fetchThread: async () => {
          throw new RedditFetchError('Expected Reddit JSON but received text/html.', {
            status: 200,
            content_type: 'text/html',
            response_preview: '<html>feed</html>',
            retryable: false,
          });
        },
      });

      const response = await redditThreadHandler(requestWithJson({ post: 'abc123' }), contextStub());
      const serialized = JSON.stringify(response.jsonBody);

      assert.equal(response.status, 502);
      assert.equal(response.jsonBody.analysis_mode, 'deterministic');
      assert.equal(response.jsonBody.reddit_fetch_error, undefined);
      assert.doesNotMatch(serialized, /response_preview|<html>feed<\/html>/);
    },
  );
});

test('redditThreadHandler omits deep Reddit fetch diagnostics from public REC responses by default', async () => {
  await withEnv(
    { AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false', REPAIRABLE_ERRORS_PUBLIC_DEBUG: undefined },
    async () => {
      setRedditThreadServiceForTesting({
        fetchThread: async () => {
          throw new RedditFetchError(
            'Expected Reddit JSON but received text/html. This often means `.json` was appended before resolving a Reddit share URL or Reddit redirected to a subreddit/feed page.',
            {
              input: 'https://www.reddit.com/r/science/s/DQGxxt7XzY',
              normalized_post_id: '1tflddp',
              request_url: 'https://www.reddit.com/comments/1tflddp.json?limit=1&sort=confidence',
              final_url: 'https://www.reddit.com/r/science/',
              status: 200,
              reason: 'OK',
              content_type: 'text/html; charset=utf-8',
              response_preview: '<html>feed</html>',
              redirect_chain: ['https://www.reddit.com/r/science/s/DQGxxt7XzY', 'https://www.reddit.com/r/science/'],
              retryable: false,
            },
          );
        },
      });

      const response = await redditThreadHandler(
        requestWithJson({ post: 'https://www.reddit.com/r/science/s/DQGxxt7XzY' }),
        contextStub(),
      );
      const serialized = JSON.stringify(response.jsonBody);

      assert.equal(response.status, 502);
      assert.equal(response.jsonBody.instance, `urn:diagnostic:${response.jsonBody.diagnostic_id}`);
      assert.equal(response.jsonBody.reddit_fetch_error, undefined);
      assert.doesNotMatch(serialized, /response_preview|<html>feed<\/html>|redirect_chain|request_url|final_url/);
    },
  );
});

test('redditThreadHandler maps Reddit 429 to retry-later repairable problem', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRedditThreadServiceForTesting({
      fetchThread: async () => {
        throw new RedditUpstreamError('Reddit rate-limited the request.', 429, 429);
      },
    });

    const response = await redditThreadHandler(requestWithJson({ post: 'abc123' }), contextStub());

    assert.equal(response.status, 429);
    assert.equal(response.jsonBody.classification, 'capacity_or_timeout');
    assert.equal(response.jsonBody.retry_policy.can_retry, true);
    assert.equal(response.jsonBody.retry_policy.same_request, true);
    assert.match(response.jsonBody.caller_instruction, /Do not change request parameters/i);
  });
});

test('redditThreadHandler maps unknown internal exceptions to service bug likely without stack trace', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRedditThreadServiceForTesting({
      fetchThread: async () => {
        throw new Error('Unexpected failure\n    at secret.file:1:1');
      },
    });
    const response = await redditThreadHandler(requestWithJson({ post: 'abc123' }), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.equal(response.status, 502);
    assert.equal(response.jsonBody.instance, `urn:diagnostic:${response.jsonBody.diagnostic_id}`);
    assert.equal(response.jsonBody.classification, 'service_bug_likely');
    assert.equal(response.jsonBody.repairable, false);
    assert.equal(response.jsonBody.retry_policy.same_request, true);
    assert.match(response.jsonBody.caller_instruction, /diagnostic_id|Do not invent request parameters/i);
    assert.doesNotMatch(serialized, /\bat\s+secret\.file|Unexpected failure/);
  });
});

test('redditThreadHandler does not leak authorization header values in repairable errors', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    const response = await redditThreadHandler(requestThatThrowsJson('Bearer fake-token'), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.doesNotMatch(serialized, /Authorization|Bearer|fake-token/);
  });
});

test('redditThreadHandler does not leak stack trace patterns in repairable errors', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRedditThreadServiceForTesting({
      fetchThread: async () => {
        throw new Error('Unexpected failure\n    at internal.ts:10:1');
      },
    });
    const response = await redditThreadHandler(requestWithJson({ post: 'abc123' }), contextStub());
    assert.doesNotMatch(JSON.stringify(response.jsonBody), /\bat\s+internal\.ts/);
  });
});

test('buildRedditDiagnosticCapsule records request shape without raw token-like values', () => {
  const capsule = buildRedditDiagnosticCapsule({
    diagnostic_id: 'diag_test',
    failure_stage: 'input_validation',
    http_status: 400,
    safe_error: { message: 'Invalid request.' },
    body: { post: 'abc123', ['access_' + 'token']: 'secret', ['client_' + 'secret']: 'hidden' },
  });
  const serialized = JSON.stringify(capsule);

  assert.equal(capsule.request_shape.post.type, 'string');
  assert.equal(capsule.request_shape.post.value_exposed, false);
  assert.equal(capsule.request_shape['[redacted_sensitive_field_1]'].type, 'string');
  assert.equal(capsule.request_shape['[redacted_sensitive_field_2]'].type, 'string');
  assert.doesNotMatch(serialized, /access_token|client_secret|secret|hidden/);
  assert.equal(capsule.security_policy.authorization_headers_included, false);
});

test('redditThreadHandler returns 401 before reading body when unauthenticated', async () => {
  const originalAuthEnabled = process.env.AUTH_ENABLED;
  const originalEnvironment = process.env.DEPLOYED_ENVIRONMENT_NAME;
  process.env.AUTH_ENABLED = 'true';
  process.env.DEPLOYED_ENVIRONMENT_NAME = 'local';
  try {
    const response = await redditThreadHandler(
      {
        method: 'POST',
        headers: { get: () => null },
        json: async () => {
          throw new Error('body should not be read when unauthenticated');
        },
      },
      { warn: () => undefined },
    );

    assert.equal(response.status, 401);
  } finally {
    if (originalAuthEnabled === undefined) {
      delete process.env.AUTH_ENABLED;
    } else {
      process.env.AUTH_ENABLED = originalAuthEnabled;
    }
    if (originalEnvironment === undefined) {
      delete process.env.DEPLOYED_ENVIRONMENT_NAME;
    } else {
      process.env.DEPLOYED_ENVIRONMENT_NAME = originalEnvironment;
    }
  }
});

test('validateRepairableProblem accepts JSONPath diagnostic paths but keeps repair_patch JSON Pointer-only', () => {
  const expected = repairableProblemExpected();

  assert.ok(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        invalid_fields: [{ path: '$.post', problem: 'Missing post.' }],
      },
      expected,
    ),
  );
  assert.ok(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        repair_plan: [{ action: 'provide_missing_value', path: '$.post', reason: 'A post identifier is required.' }],
      },
      expected,
    ),
  );
  assert.equal(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        repair_patch: [{ op: 'replace', path: '$.post', value: 'abc123' }],
      },
      expected,
    ),
    null,
  );
  assert.ok(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        repair_patch: [{ op: 'replace', path: '/post', value: 'abc123' }],
      },
      expected,
    ),
  );
});

test('validateRepairableProblem rejects unknown, nested sensitive, and weird diagnostic paths', () => {
  const expected = repairableProblemExpected();

  assert.equal(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        invalid_fields: [{ path: '$.unknown', problem: 'Unknown field.' }],
      },
      expected,
    ),
    null,
  );
  assert.equal(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        repair_plan: [{ action: 'provide_missing_value', path: '$.access_token', reason: 'Sensitive path.' }],
      },
      expected,
    ),
    null,
  );
  assert.equal(
    validateRepairableProblem(
      {
        ...baseRepairableProblem(expected),
        invalid_fields: [{ path: '../post', problem: 'Weird path.' }],
      },
      expected,
    ),
    null,
  );
});

function repairableProblemExpected() {
  return {
    operation_id: 'postRedditThread',
    diagnostic_id: 'diag_test',
    status: 400,
    allowedRequestFields: [
      'post',
      'sort',
      'maxComments',
      'maxMoreChildrenRequests',
      'url',
      'redditUrl',
      'reddit_url',
      'threadUrl',
      'thread_url',
    ],
    allowedOperationIds: ['postRedditThread'],
  };
}

function baseRepairableProblem(expected) {
  return {
    type: 'https://api.juez.local/problems/reddit-thread/caller-contract-violation',
    title: 'Request contract violation',
    status: expected.status,
    detail: 'The request was invalid.',
    instance: `urn:diagnostic:${expected.diagnostic_id}`,
    rec_version: '1.0',
    operation_id: expected.operation_id,
    diagnostic_id: expected.diagnostic_id,
    classification: 'caller_contract_violation',
    repairable: true,
    confidence: 0.9,
    retry_policy: { can_retry: true, same_request: false },
    caller_instruction: 'Send a valid post value.',
    safe_debug_summary: 'Sanitized diagnostic summary.',
    analysis_mode: 'llm_assisted',
  };
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries({ DEPLOYED_ENVIRONMENT_NAME: 'local', ...values })) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    setRedditThreadServiceForTesting(null);
    setRedditCommentTreeServiceForTesting(null);
    setRedditThreadOverviewServiceForTesting(null);
    setRedditThreadCommentsServiceForTesting(null);
    setRedditCommentsBatchServiceForTesting(null);
    setRepairableErrorAnalyzerForTesting(null);
    setCommentTreeRepairableErrorAnalyzerForTesting(null);
    setThreadOverviewRepairableErrorAnalyzerForTesting(null);
    setThreadCommentsRepairableErrorAnalyzerForTesting(null);
    setCommentsBatchRepairableErrorAnalyzerForTesting(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function requestThatThrowsJson(authorization = null) {
  return requestWithText('{', authorization);
}

function requestWithJson(body, authorization = null) {
  return requestWithText(JSON.stringify(body), authorization);
}

function requestWithText(text, authorization = null) {
  const headers = new Headers({
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  });
  if (authorization) headers.set('authorization', authorization);
  return {
    method: 'POST',
    url: 'https://api.test/api/reddit/thread',
    headers,
    body: bodyStream([new TextEncoder().encode(text)]),
    json: async () => {
      throw new Error('Reddit handlers must use the bounded body reader.');
    },
  };
}

function bodyStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function contextStub(overrides = {}) {
  return { invocationId: 'invocation-test', warn: () => undefined, ...overrides };
}

async function fetchThreadFromShareHtml({ html, status = 200 }) {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/AskReddit/s/JYIXy2cjSJ';
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      assert.doesNotMatch(String(input), /\/s\/JYIXy2cjSJ\.json/);
      if (String(input).includes('/api/v1/access_token'))
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      if (String(input) === shareUrl)
        return textResponseWithUrl(html, shareUrl, status, { 'content-type': 'text/html; charset=utf-8' });
      if (String(input).includes('/comments/1tgoo04'))
        return jsonResponse(threadFixtureWithoutMore('1tgoo04'), 200, rateHeaders(2));
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  return {
    response: await service.fetchThread({ post: shareUrl, maxComments: 10, maxMoreChildrenRequests: 0 }),
    calls,
  };
}

function assertShareHtmlResolvedWithoutFallbacks(calls) {
  const shareCall = calls.find((call) => call.input === 'https://www.reddit.com/r/AskReddit/s/JYIXy2cjSJ');
  assert.ok(shareCall);
  assertRedditAuthenticatedRequest(shareCall);
  assert.ok(calls.some((call) => call.input.includes('/comments/1tgoo04')));
  assert.equal(
    calls.some((call) => call.input.includes('/api/info') && call.input.includes('url=')),
    false,
  );
  assert.equal(
    calls.some((call) => /\/s\/JYIXy2cjSJ\.json/.test(call.input)),
    false,
  );
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function infoListing(...children) {
  return {
    kind: 'Listing',
    data: { children },
  };
}

function redirectResponse(location, status = 302) {
  return new Response('', {
    status,
    headers: { location },
  });
}

function responseWithUrl(body, url, status = 200, headers = {}) {
  const response = jsonResponse(body, status, headers);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function textResponseWithUrl(body, url, status = 200, headers = {}) {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function rateHeaders(used) {
  return {
    'x-ratelimit-used': String(used),
    'x-ratelimit-remaining': String(1000 - used),
    'x-ratelimit-reset': '60',
  };
}

function threadFixture() {
  return [
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'abc123',
              name: 't3_abc123',
              subreddit: 'test',
              title: 'Example post',
              author: 'poster',
              selftext: 'Example selftext',
              url: 'https://example.test/post',
              permalink: '/r/test/comments/abc123/example/',
              score: 5,
              num_comments: 3,
              created_utc: 123,
              over_18: false,
              locked: false,
              archived: false,
            },
          },
        ],
      },
    },
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't1',
            data: {
              id: 'c1',
              name: 't1_c1',
              parent_id: 't3_abc123',
              author: 'commenter',
              body: 'root comment',
              score: 4,
              created_utc: 124,
              replies: {
                kind: 'Listing',
                data: {
                  children: [
                    {
                      kind: 't1',
                      data: {
                        id: 'c2',
                        name: 't1_c2',
                        parent_id: 't1_c1',
                        author: 'reply-user',
                        body: 'reply comment',
                        score: 3,
                        created_utc: 125,
                        replies: '',
                      },
                    },
                    {
                      kind: 'more',
                      data: {
                        parent_id: 't1_c1',
                        children: ['c3'],
                        depth: 1,
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ];
}

function threadFixtureWithoutMore(postId = 'abc123') {
  const fixture = threadFixture();
  fixture[0].data.children[0].data.id = postId;
  fixture[0].data.children[0].data.name = `t3_${postId}`;
  fixture[0].data.children[0].data.permalink = `/r/test/comments/${postId}/example/`;
  fixture[1].data.children[0].data.parent_id = `t3_${postId}`;
  fixture[1].data.children[0].data.replies.data.children =
    fixture[1].data.children[0].data.replies.data.children.filter((child) => child.kind !== 'more');
  return fixture;
}

function exhaustiveThreadFixture() {
  const fixture = threadFixtureWithoutMore();
  fixture[0].data.children[0].data.num_comments = 2600;
  fixture[1].data.children = [
    exhaustiveCommentThing('seed0', 't3_abc123', 0, {
      children: [
        exhaustiveCommentThing('seed1', 't1_seed0', 1, {
          children: [exhaustiveMoreThing('t1_seed1', [], 2, 3)],
        }),
        exhaustiveMoreThing(
          't1_seed0',
          Array.from({ length: 100 }, (_, index) => exhaustiveCommentId(index + 1)),
          1,
          100,
        ),
      ],
    }),
    exhaustiveMoreThing(
      't3_abc123',
      Array.from({ length: 100 }, (_, index) => exhaustiveCommentId(index + 101)),
      0,
      100,
    ),
  ];
  return fixture;
}

function semanticGapThreadFixture() {
  const fixture = threadFixtureWithoutMore();
  fixture[0].data.children[0].data.num_comments = 583;
  fixture[1].data.children = Array.from({ length: 500 }, (_, index) =>
    exhaustiveCommentThing(`confidence${index + 1}`, 't3_abc123', 0),
  );
  return fixture;
}

function exhaustiveMoreChildrenFixture(children) {
  const deferredChild = children[0] === exhaustiveCommentId(101) ? children.at(-1) : undefined;
  const things = children.filter((id) => id !== deferredChild).map((id) => exhaustiveCommentThing(id, 't1_seed0', 1));
  if (children[0]) {
    things.push(exhaustiveCommentThing(children[0], 't1_seed0', 1));
    things.push(exhaustiveCommentThing('seed0', 't3_abc123', 0));
  }
  const firstNumber = Number(children[0]?.slice(1));
  const nextStart = firstNumber + 200;
  if (Number.isSafeInteger(nextStart) && nextStart <= 2500) {
    const nextChildren = Array.from({ length: Math.min(100, 2501 - nextStart) }, (_, index) =>
      exhaustiveCommentId(nextStart + index),
    );
    things.push(exhaustiveMoreThing('t1_seed0', nextChildren, 1, nextChildren.length));
  }
  if (deferredChild) {
    things.push(exhaustiveMoreThing('t1_seed0', [deferredChild], 1, 1));
  }
  return { json: { data: { things } } };
}

function exhaustiveContinueFixture(target) {
  const fixture = threadFixtureWithoutMore();
  fixture[0].data.children[0].data.num_comments = 2600;
  fixture[1].data.children =
    target === 'seed1'
      ? [
          exhaustiveCommentThing('seed1', 't1_seed0', 1, {
            children: [exhaustiveCommentThing('ct1', 't1_seed1', 2), exhaustiveMoreThing('t1_ct1', [], 3, 2)],
          }),
        ]
      : [
          exhaustiveCommentThing('ct1', 't1_seed1', 2, {
            children: [
              exhaustiveCommentThing('ct2', 't1_ct1', 3, {
                children: [exhaustiveCommentThing('ct3', 't1_ct2', 4)],
              }),
            ],
          }),
        ];
  return fixture;
}

function exhaustiveCommentThing(id, parentId, depth, replies) {
  return {
    kind: 't1',
    data: {
      id,
      name: `t1_${id}`,
      parent_id: parentId,
      author: `user_${id}`,
      body: `complete body for ${id}`,
      score: depth + 1,
      created_utc: 1000 + depth,
      depth,
      replies: replies ? { kind: 'Listing', data: replies } : '',
    },
  };
}

function exhaustiveMoreThing(parentId, children, depth, count = children.length) {
  return {
    kind: 'more',
    data: {
      id: `more_${parentId.replace(/^t[13]_/, '')}_${depth}`,
      parent_id: parentId,
      children,
      depth,
      count,
    },
  };
}

function exhaustiveCommentId(index) {
  return `x${String(index).padStart(4, '0')}`;
}

function moreWithNextFixture(child, nextChild) {
  const things = [exhaustiveCommentThing(child, 't1_c1', 1)];
  if (nextChild) things.push(exhaustiveMoreThing('t1_c1', [nextChild], 1, 1));
  return { json: { data: { things } } };
}

function chainedMoreChildrenFixture(index, total) {
  const things = [
    {
      kind: 't1',
      data: {
        id: `cx${index}`,
        name: `t1_cx${index}`,
        parent_id: 't1_c1',
        author: 'expanded-user',
        body: `expanded comment ${index}`,
        score: 1,
        created_utc: 200 + index,
        replies: '',
      },
    },
  ];
  if (index < total) {
    things.push({
      kind: 'more',
      data: {
        parent_id: 't1_c1',
        children: [`cx${index + 1}`],
        depth: 1,
      },
    });
  }
  return { json: { data: { things } } };
}

function moreChildrenFixture() {
  return {
    json: {
      data: {
        things: [
          {
            kind: 't1',
            data: {
              id: 'c3',
              name: 't1_c3',
              parent_id: 't1_c1',
              author: 'expanded-user',
              body: 'expanded comment',
              score: 2,
              created_utc: 126,
              replies: '',
            },
          },
        ],
      },
    },
  };
}
