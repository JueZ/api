import assert from 'node:assert/strict';
import test from 'node:test';
import { RedditFetchError, RedditOAuthClient, RedditUpstreamError } from '../dist/shared/reddit/client.js';
import { normalizeRedditPostInput, parseRedditPostInput, unresolvedRedditShareUrlError } from '../dist/shared/reddit/input.js';
import { attachMoreChildren, normalizeInitialThread } from '../dist/shared/reddit/normalize.js';
import { RedditThreadService } from '../dist/shared/reddit/service.js';
import { redditThreadHandler, setRedditThreadServiceForTesting, setRepairableErrorAnalyzerForTesting } from '../dist/functions/redditThread.js';
import { buildFallbackRepairableProblem, validateRepairableProblem } from '../dist/shared/errors/repairableProblem.js';
import { buildRedditDiagnosticCapsule } from '../dist/shared/errors/diagnosticCapsule.js';

const config = {
  clientId: 'client-id',
  secret: 'client-secret',
  userAgent: 'script:test:v0.1.0 (by u/example)',
};

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

test('normalizeRedditPostInput accepts canonical comments URLs with subreddit metadata', async () => {
  const normalized = await normalizeRedditPostInput('https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/');

  assert.equal(normalized.post_id, '1tflddp');
  assert.equal(normalized.subreddit, 'science');
});

test('normalizeRedditPostInput accepts comment permalinks with comment IDs', async () => {
  const normalized = await normalizeRedditPostInput('https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/oma4ybn/');

  assert.equal(normalized.post_id, '1tflddp');
  assert.equal(normalized.comment_id, 'oma4ybn');
});

test('normalizeRedditPostInput accepts redd.it short links', async () => {
  const normalized = await normalizeRedditPostInput('https://redd.it/1tflddp');

  assert.equal(normalized.post_id, '1tflddp');
});

test('normalizeRedditPostInput resolves Reddit share URLs before extracting post IDs', async () => {
  const shareUrl = 'https://www.reddit.com/r/science/s/DQGxxt7XzY';
  const finalUrl = 'https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/?share_id=X';
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
    (error) => error.code === 'UNRESOLVED_REDDIT_SHARE_URL' && error.input === 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI',
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
  assert.deepEqual(tree.more, [{ parentId: 't1_c1', depth: 1, children: ['c3'] }]);
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



test('RedditThreadService resolves Reddit share URLs through OAuth api/info before fetching comments', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/api/info') && String(input).includes('url=')) {
        return jsonResponse(infoListing({ kind: 't3', data: { id: 'abc123' } }), 200, rateHeaders(1));
      }
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.input, shareUrl);
  assert.equal(response.post.id, 'abc123');
  assert.equal(response.stats.commentsReturned, 2);
  assert.ok(calls.some((call) => call.input.includes('/api/info') && call.input.includes('url=')));
  assert.ok(calls.some((call) => call.input.includes('/comments/abc123')));
  assert.equal(calls.some((call) => call.input === shareUrl), false);
});

test('RedditThreadService falls back to Reddit redirect resolution when api/info has no share URL match', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/OpenAI/s/iuZlOIPdCI';
  const canonicalUrl = 'https://www.reddit.com/r/OpenAI/comments/abc123/example/';
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
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
      if (String(input).includes('/comments/abc123')) {
        return jsonResponse(threadFixtureWithoutMore(), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.post.id, 'abc123');
  const redirectCall = calls.find((call) => call.input === shareUrl);
  assert.equal(redirectCall.init.method, 'GET');
  assert.equal(redirectCall.init.redirect, 'manual');
});



test('RedditThreadService never appends .json to Reddit share URLs before redirect resolution', async () => {
  process.env.REDDIT_CLIENT_ID = config.clientId;
  process.env.REDDIT_CLIENT_SECRET = config.secret;
  process.env.REDDIT_USER_AGENT = config.userAgent;
  const calls = [];
  const shareUrl = 'https://www.reddit.com/r/science/s/DQGxxt7XzY';
  const canonicalUrl = 'https://www.reddit.com/r/science/comments/1tflddp/feeling_empty_after_finishing_a_video_game/?share_id=X';
  const service = new RedditThreadService({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      assert.notEqual(String(input), `${shareUrl}.json?limit=1&sort=confidence`);
      assert.doesNotMatch(String(input), /\/s\/DQGxxt7XzY\.json/);
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
      if (String(input).includes('/comments/1tflddp')) {
        return jsonResponse(threadFixtureWithoutMore('1tflddp'), 200, rateHeaders(2));
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const response = await service.fetchThread({ post: shareUrl, maxComments: 10 });

  assert.equal(response.post.id, '1tflddp');
  assert.ok(calls.some((call) => call.input === shareUrl));
  assert.ok(calls.some((call) => call.input.includes('/comments/1tflddp')));
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
    () => client.getJson('/comments/1tflddp', { limit: 1, sort: 'confidence' }, { input: '1tflddp', normalizedPostId: '1tflddp' }),
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
        return jsonResponse(infoListing({ kind: 't1', data: { id: '1tav2fa', link_id: 't3_abc123' } }), 200, rateHeaders(2));
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
      if (String(input).includes('/api/v1/access_token')) {
        return jsonResponse({ ['access_' + 'token']: 'mock-token', expires_in: 3600 });
      }
      if (String(input).includes('/api/info') && String(input).includes('url=')) {
        return jsonResponse(infoListing(), 200, rateHeaders(1));
      }
      return responseWithUrl({}, shareUrl);
    },
  });

  await assert.rejects(
    () => service.fetchThread({ post: shareUrl }),
    (error) =>
      error.code === 'UNRESOLVED_REDDIT_SHARE_URL' &&
      error.message === 'Could not resolve Reddit /s/ share URL to canonical /comments/<id>/ URL.' &&
      error.input === shareUrl,
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

  const response = await service.fetchThread({ post: 'abc123', maxComments: 10 });

  assert.equal(response.stats.commentsReturned, 3);
  assert.equal(response.stats.truncated, false);
  assert.equal(response.stats.moreChildrenRequests, 1);
  assert.equal(response.comments[0].replies[1].id, 'c3');
  assert.equal(calls.filter((url) => url.includes('/api/morechildren')).length, 1);
});


test('RedditThreadService default MoreChildren budget fetches beyond the old 50 request cutoff', async () => {
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

  const response = await service.fetchThread({ post: 'abc123' });

  assert.equal(moreCalls, 75);
  assert.equal(response.stats.moreChildrenRequests, 75);
  assert.equal(response.stats.truncated, false);
  assert.equal(response.stats.commentsReturned, 77);
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



test('redditThreadHandler returns a valid LLM-assisted repairable problem from analyzer route', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: 'test-key' }, async () => {
    setRepairableErrorAnalyzerForTesting(async ({ expected }) => ({
      type: 'https://api.juez.local/problems/reddit-thread/caller-contract-violation',
      title: 'Invalid JSON',
      status: 400,
      detail: 'The request body was not valid JSON.',
      instance: `urn:diagnostic:${expected.diagnostic_id}`,
      rec_version: '1.0',
      operation_id: expected.operation_id,
      diagnostic_id: expected.diagnostic_id,
      classification: 'caller_contract_violation',
      repairable: true,
      confidence: 0.95,
      retry_policy: { can_retry: true, same_request: false },
      invalid_fields: [{ path: '/post', problem: 'Missing because JSON parsing failed.', expected: 'string' }],
      repair_plan: [{ action: 'provide_missing_value', path: '/post', reason: 'A post identifier is required.' }],
      correct_request_example: { post: 'abc123' },
      caller_instruction: 'Send valid JSON with a post value.',
      safe_debug_summary: 'Sanitized LLM-assisted invalid JSON diagnosis.',
      analysis_mode: 'llm_assisted',
    }));

    const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());

    assert.equal(response.status, 400);
    assert.equal(response.headers['Content-Type'], 'application/problem+json');
    assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(response.jsonBody.analysis_mode, 'llm_assisted');
    assert.equal(response.jsonBody.operation_id, 'postRedditThread');
  });
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

test('redditThreadHandler falls back when OpenAI API key is missing', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: undefined }, async () => {
    setRepairableErrorAnalyzerForTesting(null);
    const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.analysis_mode, 'fallback');
    assert.equal(response.jsonBody.classification, 'caller_contract_violation');
  });
});

test('redditThreadHandler falls back when analyzer returns invalid or unsafe output', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: 'test-key' }, async () => {
    setRepairableErrorAnalyzerForTesting(async ({ expected }) => ({
      ...buildFallbackRepairableProblem({ operation_id: expected.operation_id, diagnostic_id: expected.diagnostic_id, status: expected.status, endpoint: '/api/reddit/thread' }),
      caller_instruction: 'Leak Authorization Bearer fake-token',
      analysis_mode: 'llm_assisted',
    }));
    const response = await redditThreadHandler(requestThatThrowsJson(), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.analysis_mode, 'fallback');
    assert.doesNotMatch(serialized, /Bearer|fake-token/);
  });
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
    setRedditThreadServiceForTesting({ fetchThread: async () => {
      throw unresolvedRedditShareUrlError(shareUrl);
    } });

    const response = await redditThreadHandler(requestWithJson({ post: shareUrl }), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.equal(response.status, 400);
    assert.match(response.jsonBody.caller_instruction, /Do not retry the same \/s\/ share URL/i);
    assert.match(serialized, /comments<\/id>|comments\/<id>|redd\.it|t3 fullname|article ID/i);
  });
});



test('redditThreadHandler falls back when analyzer returns public Reddit fetch diagnostics', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'true', ['OPENAI_' + 'API_KEY']: 'test-key', REPAIRABLE_ERRORS_PUBLIC_DEBUG: undefined }, async () => {
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
    assert.equal(response.jsonBody.analysis_mode, 'fallback');
    assert.equal(response.jsonBody.reddit_fetch_error, undefined);
    assert.doesNotMatch(serialized, /response_preview|<html>feed<\/html>/);
  });
});

test('redditThreadHandler omits deep Reddit fetch diagnostics from public REC responses by default', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false', REPAIRABLE_ERRORS_PUBLIC_DEBUG: undefined }, async () => {
    setRedditThreadServiceForTesting({
      fetchThread: async () => {
        throw new RedditFetchError('Expected Reddit JSON but received text/html. This often means `.json` was appended before resolving a Reddit share URL or Reddit redirected to a subreddit/feed page.', {
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
        });
      },
    });

    const response = await redditThreadHandler(requestWithJson({ post: 'https://www.reddit.com/r/science/s/DQGxxt7XzY' }), contextStub());
    const serialized = JSON.stringify(response.jsonBody);

    assert.equal(response.status, 502);
    assert.equal(response.jsonBody.instance, `urn:diagnostic:${response.jsonBody.diagnostic_id}`);
    assert.equal(response.jsonBody.reddit_fetch_error, undefined);
    assert.doesNotMatch(serialized, /response_preview|<html>feed<\/html>|redirect_chain|request_url|final_url/);
  });
});

test('redditThreadHandler maps Reddit 429 to retry-later repairable problem', async () => {
  await withEnv({ AUTH_ENABLED: 'false', REPAIRABLE_ERRORS_LLM_ENABLED: 'false' }, async () => {
    setRedditThreadServiceForTesting({ fetchThread: async () => {
      throw new RedditUpstreamError('Reddit rate-limited the request.', 429, 429);
    } });

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
    setRedditThreadServiceForTesting({ fetchThread: async () => { throw new Error('Unexpected failure\n    at secret.file:1:1'); } });
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
    setRedditThreadServiceForTesting({ fetchThread: async () => { throw new Error('Unexpected failure\n    at internal.ts:10:1'); } });
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
  process.env.AUTH_ENABLED = 'true';
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
  }
});


test('validateRepairableProblem accepts JSONPath diagnostic paths but keeps repair_patch JSON Pointer-only', () => {
  const expected = repairableProblemExpected();

  assert.ok(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    invalid_fields: [{ path: '$.post', problem: 'Missing post.' }],
  }, expected));
  assert.ok(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    repair_plan: [{ action: 'provide_missing_value', path: '$.post', reason: 'A post identifier is required.' }],
  }, expected));
  assert.equal(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    repair_patch: [{ op: 'replace', path: '$.post', value: 'abc123' }],
  }, expected), null);
  assert.ok(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    repair_patch: [{ op: 'replace', path: '/post', value: 'abc123' }],
  }, expected));
});

test('validateRepairableProblem rejects unknown, nested sensitive, and weird diagnostic paths', () => {
  const expected = repairableProblemExpected();

  assert.equal(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    invalid_fields: [{ path: '$.unknown', problem: 'Unknown field.' }],
  }, expected), null);
  assert.equal(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    repair_plan: [{ action: 'provide_missing_value', path: '$.access_token', reason: 'Sensitive path.' }],
  }, expected), null);
  assert.equal(validateRepairableProblem({
    ...baseRepairableProblem(expected),
    invalid_fields: [{ path: '../post', problem: 'Weird path.' }],
  }, expected), null);
});


function repairableProblemExpected() {
  return {
    operation_id: 'postRedditThread',
    diagnostic_id: 'diag_test',
    status: 400,
    allowedRequestFields: ['post', 'sort', 'maxComments', 'maxMoreChildrenRequests', 'url', 'redditUrl', 'reddit_url', 'threadUrl', 'thread_url'],
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
  for (const [key, value] of Object.entries(values)) {
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
    setRepairableErrorAnalyzerForTesting(null);
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
  return {
    method: 'POST',
    headers: { get: (name) => name.toLowerCase() === 'authorization' ? authorization : null },
    json: async () => { throw new Error('invalid json'); },
  };
}

function requestWithJson(body, authorization = null) {
  return {
    method: 'POST',
    headers: { get: (name) => name.toLowerCase() === 'authorization' ? authorization : null },
    json: async () => body,
  };
}

function contextStub() {
  return { invocationId: 'invocation-test', warn: () => undefined };
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
  fixture[1].data.children[0].data.replies.data.children = fixture[1].data.children[0].data.replies.data.children.filter(
    (child) => child.kind !== 'more',
  );
  return fixture;
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
