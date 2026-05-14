import assert from 'node:assert/strict';
import test from 'node:test';
import { RedditOAuthClient } from '../dist/shared/reddit/client.js';
import { parseRedditPostInput } from '../dist/shared/reddit/input.js';
import { attachMoreChildren, normalizeInitialThread } from '../dist/shared/reddit/normalize.js';
import { RedditThreadService } from '../dist/shared/reddit/service.js';
import { redditThreadHandler } from '../dist/functions/redditThread.js';

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

test('parseRedditPostInput rejects non-Reddit URLs and invalid IDs', () => {
  assert.throws(() => parseRedditPostInput('https://example.com/r/test/comments/abc123'), /supported Reddit URL/);
  assert.throws(() => parseRedditPostInput('!bad'), /valid Reddit article ID/);
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

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
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
