import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMcpHttpRequest } from '../dist/mcp/server.js';

const authEnv = {
  AUTH_ENABLED: 'false',
  OIDC_AUDIENCE: 'api://catalogue-test',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
};

test('MCP initialize and tools/list expose protected Bring reads and controlled writes', async () => {
  await withEnv(authEnv, async () => {
    const initialize = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.jsonBody.result.serverInfo.name, 'api-catalogue-private-mcp');

    const listed = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = listed.jsonBody.result.tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'bring_add_items',
      'bring_complete_items',
      'bring_get_items',
      'bring_list_lists',
      'health_check',
      'hello_authenticated',
      'reddit_get_thread',
      'reddit_get_thread_overview',
      'wlh_categories_top',
      'wlh_category_children',
      'wlh_find_category',
      'wlh_get_offer',
      'wlh_search',
    ].sort());

    for (const tool of tools) {
      if (tool.name === 'bring_add_items') assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      else if (tool.name === 'bring_complete_items') assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
      else { assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`); assert.equal(tool.annotations.destructiveHint, false, `${tool.name} must be non-destructive`); assert.equal(tool.annotations.idempotentHint, true, `${tool.name} must be idempotent`); }
      assert.ok(tool.outputSchema, `${tool.name} must expose an output schema`);
      assert.equal(typeof tool._meta['openai/toolInvocation/invoking'], 'string');
      assert.equal(typeof tool._meta['openai/toolInvocation/invoked'], 'string');
      assert.ok(tool._meta['openai/toolInvocation/invoking'].length <= 64);
      assert.ok(tool._meta['openai/toolInvocation/invoked'].length <= 64);
      assert.equal(tool._meta.ui, undefined, `${tool.name} must not advertise UI metadata`);
      assert.equal(tool._meta['openai/outputTemplate'], undefined, `${tool.name} must not advertise an output template`);
      assert.equal(tool._meta['openai/widgetAccessible'], undefined, `${tool.name} must not advertise widget access`);
      if (tool.name === 'wlh_search') {
        const inputProperties = tool.inputSchema.properties;
        assert.equal(inputProperties.radiusKm, undefined);
        assert.equal(inputProperties.sellerType, undefined);
        assert.equal(tool.inputSchema.additionalProperties, false);
      }
      if (tool.name === 'health_check') {
        assert.deepEqual(tool.securitySchemes, [{ type: 'noauth' }]);
        assert.deepEqual(tool._meta.securitySchemes, [{ type: 'noauth' }]);
      } else {
        assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['api://catalogue-test/api.access'] }]);
        assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['api://catalogue-test/api.access'] }]);
      }
    }
  });
});

test('authenticated MCP hello returns safe user shape without full claims or token material', async () => {
  await withEnv(authEnv, async () => {
    const response = await mcpCall('hello_authenticated', {}, 'Bearer local-dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.result.structuredContent.authenticated, true);
    assert.deepEqual(response.jsonBody.result.structuredContent.user, { subject: 'local-dev-placeholder' });
    const serialized = JSON.stringify(response.jsonBody);
    assert.doesNotMatch(serialized, /local-dev-token|Bearer|claims|scp|roles|preferred_username/i);
  });
});

test('MCP tools call shared Reddit and WLH services with stable structured content', async () => {
  const calls = [];
  const services = stubServices(calls);
  await withEnv(authEnv, async () => {
    const reddit = await mcpCall('reddit_get_thread', { postId: 'abc', sort: 'top', maxComments: 2 }, 'Bearer local-dev-token', services);
    assert.equal(reddit.jsonBody.result.structuredContent.post.id, 'abc');
    assert.equal(reddit.jsonBody.result.structuredContent.comments[0].body, 'hello');
    assert.equal(reddit.jsonBody.result.structuredContent.stats.modelCommentsReturned, 1);
    assert.equal(reddit.jsonBody.result.structuredContent.stats.modelCommentLimit, 50);
    assert.equal(reddit.jsonBody.result.structuredContent.stats.bodyCharLimit, 800);
    assert.equal(reddit.jsonBody.result.structuredContent.stats.modelTruncated, false);
    assert.equal(reddit.jsonBody.result.content[0].text, 'Fetched Reddit thread abc with 1 model-readable comments.');

    const redditUrl = await mcpCall('reddit_get_thread', { url: 'https://www.reddit.com/r/test/comments/abc/example/' }, 'Bearer local-dev-token', services);
    assert.equal(redditUrl.jsonBody.result.structuredContent.post.id, 'https://www.reddit.com/r/test/comments/abc/example/');

    const overview = await mcpCall('reddit_get_thread_overview', { postId: 'abc' }, 'Bearer local-dev-token', services);
    assert.equal(overview.jsonBody.result.structuredContent.stats.loadedSnapshotCommentCount, 5);

    const findCategory = await mcpCall('wlh_find_category', { query: 'bike' }, 'Bearer local-dev-token', services);
    assert.equal(findCategory.jsonBody.result.structuredContent.matches[0].id, '10');

    const search = await mcpCall('wlh_search', { keyword: 'bike' }, 'Bearer local-dev-token', services);
    assert.equal(search.jsonBody.result.structuredContent.filteredRowsReturned, 1);
    assert.equal(search.jsonBody.result.structuredContent.results[0].title, 'Bike');
    assert.equal(search.jsonBody.result.structuredContent.results[0].thumbnailUrl, 'thumb');
    assert.deepEqual(search.jsonBody.result.structuredContent.filterApplications.map((entry) => [entry.field, entry.appliedAs]), [
      ['keyword', 'sent_to_wlh'],
      ['categoryId', 'sent_to_wlh'],
    ]);

    const offer = await mcpCall('wlh_get_offer', { url: 'https://www.willhaben.at/iad/kaufen-und-verkaufen/d/bike-123456789' }, 'Bearer local-dev-token', services);
    assert.equal(offer.jsonBody.result.structuredContent.id, '123456789');
    assert.equal(offer.jsonBody.result.structuredContent.title, 'Offer');
    assert.equal(offer.jsonBody.result.structuredContent.images[0].full, 'image1');

    const top = await mcpCall('wlh_categories_top', {}, 'Bearer local-dev-token', services);
    assert.equal(top.jsonBody.result.structuredContent.categories[0].id, '10');

    const children = await mcpCall('wlh_category_children', { categoryId: '10' }, 'Bearer local-dev-token', services);
    assert.equal(children.jsonBody.result.structuredContent.categories[0].id, '11');
  });

  assert.deepEqual(calls, [
    ['fetchThread', { post: 'abc', sort: 'top', maxComments: 2 }],
    ['fetchThread', { url: 'https://www.reddit.com/r/test/comments/abc/example/' }],
    ['fetchThreadOverview', { post: 'abc' }],
    ['topCategories'],
    ['children', '10'],
    ['topCategories'],
    ['children', '10'],
    ['search', { keyword: 'bike', categoryId: '10' }],
    ['offer', '123456789'],
    ['topCategories'],
    ['children', '10'],
  ]);
});



test('MCP wlh_search exposes only effective filters and reports how each one is applied', async () => {
  const calls = [];
  const services = stubServices(calls);
  services.wlh.search = async (args) => {
    calls.push(['search', args]);
    return {
      source: 'wlh',
      rowsFound: 4,
      rowsReturned: 4,
      filteredRowsReturned: 4,
      category: { id: args.categoryId, label: 'Bikes', path: '/bikes', depth: 1, hasChildren: false },
      results: [
        { id: '1', title: 'Bike one', priceAmount: 100, location: 'Wien', postcode: '1010', state: 'Wien', publishedAt: '2026-06-02T10:00:00Z', imageCount: 1 },
        { id: '2', title: 'Bike two', priceAmount: 250, location: 'Wien', postcode: '1010', state: 'Wien', publishedAt: '2026-06-03T10:00:00Z', imageCount: 2 },
        { id: '3', title: 'Bike old', priceAmount: 300, location: 'Wien', postcode: '1010', state: 'Wien', publishedAt: '2026-05-01T10:00:00Z', imageCount: 3 },
        { id: '4', title: 'Bike Graz', priceAmount: 400, location: 'Graz', postcode: '8010', state: 'Steiermark', publishedAt: '2026-06-04T10:00:00Z', imageCount: 4 },
      ],
    };
  };

  await withEnv(authEnv, async () => {
    const response = await mcpCall('wlh_search', {
      keyword: 'bike',
      categoryId: '10',
      requiredTerms: ['bike'],
      locationText: 'Wien',
      postcode: '101',
      postedSince: '2026-06-01',
      imageRequired: true,
      sort: 'price_desc',
    }, 'Bearer local-dev-token', services);

    const content = response.jsonBody.result.structuredContent;
    assert.equal(response.status, 200);
    assert.equal(content.filteredRowsReturned, 2);
    assert.deepEqual(content.results.map((result) => result.id), ['2', '1']);
    assert.deepEqual(calls.at(-1), ['search', { keyword: 'bike', categoryId: '10', requiredTerms: ['bike'] }]);
    assert.deepEqual(Object.fromEntries(content.filterApplications.map((entry) => [entry.field, entry.appliedAs])), {
      keyword: 'sent_to_wlh',
      categoryId: 'sent_to_wlh',
      requiredTerms: 'service_post_filter',
      locationText: 'mcp_post_filter',
      postcode: 'mcp_post_filter',
      postedSince: 'mcp_post_filter',
      imageRequired: 'mcp_post_filter',
      sort: 'mcp_post_sort',
    });
  });
});

test('MCP validation rejects invalid Reddit and WLH arguments with safe tool errors', async () => {
  await withEnv(authEnv, async () => {
    await assertToolError(await mcpCall('reddit_get_thread', {}, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(await mcpCall('reddit_get_thread', { postId: 'abc', url: 'https://www.reddit.com/r/test/comments/abc/example/' }, 'Bearer local-dev-token'), 'invalid_arguments');
    const validPost = await mcpCall('reddit_get_thread', { postId: 'abc123' }, 'Bearer local-dev-token');
    assert.equal(validPost.jsonBody.result.structuredContent.post.id, 'abc123');
    const validUrl = await mcpCall('reddit_get_thread_overview', { url: 'https://redd.it/abc123' }, 'Bearer local-dev-token');
    assert.equal(validUrl.jsonBody.result.structuredContent.post.id, 'https://redd.it/abc123');

    await assertToolError(await mcpCall('wlh_get_offer', {}, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(await mcpCall('wlh_get_offer', { adId: '123456', url: 'https://www.willhaben.at/iad/kaufen-und-verkaufen/d/test-123456' }, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(await mcpCall('wlh_get_offer', { url: 'https://example.com/iad/kaufen-und-verkaufen/d/test-123456' }, 'Bearer local-dev-token'), 'unsupported_url');

    await assertToolError(await mcpCall('wlh_search', { keyword: 'bike', priceFrom: -1 }, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(await mcpCall('wlh_search', { keyword: 'bike', priceFrom: 100, priceTo: 10 }, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(await mcpCall('wlh_search', { keyword: 'bike', postedSince: 'not-a-date' }, 'Bearer local-dev-token'), 'invalid_arguments');
    assertMcpValidationError(await mcpCall('wlh_search', { keyword: 'bike', radiusKm: 10 }, 'Bearer local-dev-token'), 'radiusKm');
    assertMcpValidationError(await mcpCall('wlh_search', { keyword: 'bike', sellerType: 'private' }, 'Bearer local-dev-token'), 'sellerType');
  });
});

test('external service exceptions become safe MCP tool errors without sensitive material', async () => {
  const secretNeedles = /Bearer|token|claims|headers|cookie|secret|password|Authorization/i;
  const services = stubServices();
  services.reddit.fetchThread = async () => {
    throw new Error('upstream exploded with Authorization: Bearer SHOULD_NOT_LEAK and stack trace');
  };
  services.wlh.search = async () => {
    const error = new Error('rate-limited with cookie SHOULD_NOT_LEAK');
    error.status = 429;
    throw error;
  };
  await withEnv(authEnv, async () => {
    const reddit = await mcpCall('reddit_get_thread', { postId: 'abc' }, 'Bearer local-dev-token', services);
    assertToolError(reddit, 'upstream_unavailable', 'reddit');
    assert.doesNotMatch(JSON.stringify(reddit.jsonBody), secretNeedles);

    const wlh = await mcpCall('wlh_search', { keyword: 'bike' }, 'Bearer local-dev-token', services);
    assertToolError(wlh, 'upstream_rate_limited', 'wlh');
    assert.doesNotMatch(JSON.stringify(wlh.jsonBody), secretNeedles);
  });
});

async function mcpRequest(body, authorization = undefined, services = stubServices()) {
  return handleMcpHttpRequest(
    {
      method: 'POST',
      url: 'https://mcp.example.test/mcp',
      headers: new Headers({ accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }),
      params: {},
      json: async () => body,
    },
    { invocationId: 'mcp-tools-test', warn: () => undefined },
    services,
  );
}

async function mcpCall(name, args = {}, authorization, services = stubServices()) {
  return mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, authorization, services);
}


function assertMcpValidationError(response, field) {
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.result.isError, true);
  const text = response.jsonBody.result.content[0].text;
  assert.match(text, /Input validation error/);
  assert.match(text, new RegExp(field));
  assert.doesNotMatch(JSON.stringify(response.jsonBody), /Bearer|local-dev-token|claims|headers|cookie|secret|password|Authorization/i);
}

function assertToolError(response, error, source = undefined) {
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.result.isError, true);
  assert.equal(response.jsonBody.result.structuredContent.error, error);
  if (source) assert.equal(response.jsonBody.result.structuredContent.source, source);
  const serialized = JSON.stringify(response.jsonBody);
  assert.doesNotMatch(serialized, /Bearer|local-dev-token|claims|headers|cookie|secret|password|Authorization/i);
}

function stubServices(calls = []) {
  return {
    reddit: {
      fetchThread: async (args) => {
        calls.push(['fetchThread', args]);
        const id = args.post ?? args.url;
        return { source: 'reddit', post: { id, title: 'Thread', subreddit: 'test', numComments: 1 }, comments: [{ id: 'c1', parentId: `t3_${id}`, author: 'a', body: 'hello', score: 1, depth: 0, createdUtc: 1, replies: [] }], commentContinuations: [], stats: { commentsReturned: 1 }, redditRateLimit: { used: null, remaining: null, resetSeconds: null } };
      },
      fetchThreadOverview: async (args) => {
        calls.push(['fetchThreadOverview', args]);
        const id = args.post ?? args.url;
        return { source: 'reddit', post: { id, title: 'Thread', subreddit: 'test', numComments: 5 }, stats: { loadedSnapshotCommentCount: 5 }, availableSorts: ['top'], coverage: {}, redditRateLimit: { used: null, remaining: null, resetSeconds: null } };
      },
    },
    wlh: {
      search: async (args) => {
        calls.push(['search', args]);
        return { source: 'wlh', rowsFound: 1, rowsReturned: 1, filteredRowsReturned: 1, category: { id: args.categoryId, label: 'Bikes', path: '/bikes', depth: 1, hasChildren: false }, results: [{ id: '123', title: 'Bike', priceAmount: 99, priceDisplay: '€ 99', location: 'Vienna', url: 'https://example.test/123', thumbnailUrl: 'thumb', paylivery: true, imageCount: 1 }] };
      },
      offer: async (adId) => {
        calls.push(['offer', adId]);
        return { source: 'wlh', id: adId, title: 'Offer', description: 'Nice bike', priceAmount: 99, location: 'Vienna', paylivery: true, images: [{ id: 'i1', url: 'image1' }, { id: 'i2', url: 'image1' }] };
      },
      topCategories: async () => {
        calls.push(['topCategories']);
        return [{ id: '10', label: 'Bikes', path: '/bikes', depth: 0, hasChildren: true }];
      },
      children: async (categoryId) => {
        calls.push(['children', categoryId]);
        return [{ id: '11', label: 'Bike parts', path: '/bikes/parts', depth: 1, parentId: categoryId, hasChildren: false }];
      },
    },
    bring: {
      listLists: async () => ({ source: 'bring', lists: [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'Home', isDefault: true }] }),
      getList: async (listUuid) => ({ uuid: listUuid ?? '11111111-1111-4111-8111-111111111111', items: [{ name: 'Milch', status: 'active' }] }),
      addItems: async (listUuid, items) => ({ source: 'bring', listUuid: listUuid ?? '11111111-1111-4111-8111-111111111111', operation: 'add', itemCount: items.length, items }),
      completeItems: async (listUuid, items) => ({ source: 'bring', listUuid: listUuid ?? '11111111-1111-4111-8111-111111111111', operation: 'complete', itemCount: items.length, items }),
    },
  };
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
