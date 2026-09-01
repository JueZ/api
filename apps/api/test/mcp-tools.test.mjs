import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMcpHttpRequest } from '../dist/mcp/server.js';
import { BringUpstreamError } from '../dist/shared/bring/client.js';

const authEnv = {
  AUTH_ENABLED: 'false',
  DEPLOYED_ENVIRONMENT_NAME: 'local',
  OIDC_AUDIENCE: 'api://catalogue-test',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
  MCP_ALLOWED_ORIGINS: 'https://chatgpt.com',
};
const bringListUuid = '22222222-2222-4222-8222-222222222222';
const bringAddOperationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('MCP initialize and tools/list expose reads and controlled Bring additions', async () => {
  await withEnv(authEnv, async () => {
    const initialize = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.jsonBody.result.serverInfo.name, 'api-catalogue-private-mcp');

    const listed = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = listed.jsonBody.result.tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      names,
      [
        'bring_add_item',
        'bring_get_items',
        'bring_list_lists',
        'health_check',
        'hello_authenticated',
        'reddit_get_thread',
        'reddit_get_thread_overview',
        'reddit_get_thread_page',
        'wlh_categories_top',
        'wlh_category_children',
        'wlh_find_category',
        'wlh_get_offer',
        'wlh_search',
      ].sort(),
    );

    const exhaustive = tools.find((tool) => tool.name === 'reddit_get_thread_page');
    assert.match(exhaustive.description, /all or exhaustive Reddit comments/i);
    assert.match(exhaustive.description, /while nextCursor is non-null/i);
    assert.match(exhaustive.description, /exhausted_with_reported_gap/i);
    assert.ok(exhaustive.inputSchema.properties.cursor);
    assert.equal(exhaustive.inputSchema.properties.pageSize.maximum, 50);
    assert.equal(exhaustive.inputSchema.properties.maxComments, undefined);

    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, tool.name !== 'bring_add_item', `${tool.name} read-only hint`);
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} must be non-destructive`);
      assert.equal(tool.annotations.idempotentHint, true, `${tool.name} must be idempotent`);
      assert.ok(tool.outputSchema, `${tool.name} must expose an output schema`);
      assert.equal(typeof tool._meta['openai/toolInvocation/invoking'], 'string');
      assert.equal(typeof tool._meta['openai/toolInvocation/invoked'], 'string');
      assert.ok(tool._meta['openai/toolInvocation/invoking'].length <= 64);
      assert.ok(tool._meta['openai/toolInvocation/invoked'].length <= 64);
      assert.equal(tool._meta.ui, undefined, `${tool.name} must not advertise UI metadata`);
      assert.equal(
        tool._meta['openai/outputTemplate'],
        undefined,
        `${tool.name} must not advertise an output template`,
      );
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
        const expectedSecurity = [
          {
            type: 'oauth2',
            scopes: expectedScopes(tool.name).map((scope) => `api://catalogue-test/${scope}`),
          },
        ];
        assert.deepEqual(tool.securitySchemes, expectedSecurity);
        assert.deepEqual(tool._meta.securitySchemes, expectedSecurity);
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

test('MCP Bring exposes reads and idempotent add while destructive mutations remain unavailable', async () => {
  const services = stubServices();
  services.bring.listLists = async () => ({
    source: 'bring',
    lists: [{ uuid: bringListUuid, name: 'Home', isDefault: false, shared: false }],
  });
  await withEnv(authEnv, async () => {
    const lists = await mcpCall('bring_list_lists', {}, 'Bearer local-dev-token', services);
    assert.equal(lists.jsonBody.result.structuredContent.lists[0].shared, false);
    const selected = await mcpCall('bring_get_items', { listUuid: bringListUuid }, 'Bearer local-dev-token', services);
    assert.equal(selected.jsonBody.result.structuredContent.uuid, bringListUuid);
    const added = await mcpCall(
      'bring_add_item',
      {
        operationId: bringAddOperationId,
        listUuid: bringListUuid,
        item: { name: 'Baguette' },
      },
      'Bearer local-dev-token',
      services,
    );
    assert.deepEqual(added.jsonBody.result.structuredContent, {
      source: 'bring',
      listUuid: bringListUuid,
      operation: 'add',
      operationId: bringAddOperationId,
      itemCount: 1,
      state: 'succeeded',
      replayed: false,
    });
  });
});

test('MCP tools call shared Reddit and WLH services with stable structured content', async () => {
  const calls = [];
  const services = stubServices(calls);
  await withEnv(authEnv, async () => {
    const reddit = await mcpCall(
      'reddit_get_thread',
      { postId: 'abc', sort: 'top', maxComments: 2 },
      'Bearer local-dev-token',
      services,
    );
    assert.equal(reddit.jsonBody.result.structuredContent.post.id, 'abc');
    assert.equal(reddit.jsonBody.result.structuredContent.comments[0].body, 'hello');
    assert.equal(reddit.jsonBody.result.structuredContent.stats.modelCommentsReturned, 1);
    assert.equal(reddit.jsonBody.result.structuredContent.stats.modelCommentLimit, 50);
    assert.equal(reddit.jsonBody.result.structuredContent.stats.bodyCharLimit, 800);
    assert.equal(reddit.jsonBody.result.structuredContent.stats.modelTruncated, false);
    assert.equal(reddit.jsonBody.result.content[0].text, 'Fetched Reddit thread abc with 1 model-readable comments.');

    const redditUrl = await mcpCall(
      'reddit_get_thread',
      { url: 'https://www.reddit.com/r/test/comments/abc/example/' },
      'Bearer local-dev-token',
      services,
    );
    assert.equal(
      redditUrl.jsonBody.result.structuredContent.post.id,
      'https://www.reddit.com/r/test/comments/abc/example/',
    );

    const overview = await mcpCall('reddit_get_thread_overview', { postId: 'abc' }, 'Bearer local-dev-token', services);
    assert.equal(overview.jsonBody.result.structuredContent.stats.loadedSnapshotCommentCount, 5);

    const findCategory = await mcpCall('wlh_find_category', { query: 'bike' }, 'Bearer local-dev-token', services);
    assert.equal(findCategory.jsonBody.result.structuredContent.matches[0].id, '10');

    const search = await mcpCall('wlh_search', { keyword: 'bike' }, 'Bearer local-dev-token', services);
    assert.equal(search.jsonBody.result.structuredContent.filteredRowsReturned, 1);
    assert.equal(search.jsonBody.result.structuredContent.results[0].title, 'Bike');
    assert.equal(search.jsonBody.result.structuredContent.results[0].thumbnailUrl, 'thumb');
    assert.deepEqual(
      search.jsonBody.result.structuredContent.filterApplications.map((entry) => [entry.field, entry.appliedAs]),
      [
        ['keyword', 'sent_to_wlh'],
        ['categoryId', 'sent_to_wlh'],
      ],
    );

    const offer = await mcpCall(
      'wlh_get_offer',
      { url: 'https://www.willhaben.at/iad/kaufen-und-verkaufen/d/bike-123456789' },
      'Bearer local-dev-token',
      services,
    );
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

test('reddit_get_thread_page validates initial versus continuation input and preserves complete bodies', async () => {
  const calls = [];
  const services = stubServices(calls);
  services.reddit.fetchThreadComments = async (args) => {
    calls.push(['fetchThreadComments', args]);
    const continuation = Boolean(args.cursor);
    const body = continuation ? 'second complete body' : 'x'.repeat(1200);
    return {
      source: 'reddit',
      fetchedAt: '2026-08-31T12:00:00.000Z',
      input: 'abc',
      post: { id: 'abc', title: 'Large thread', numComments: 2500 },
      comments: [
        {
          id: continuation ? 'c2' : 'c1',
          fullname: continuation ? 't1_c2' : 't1_c1',
          parentId: 't3_abc',
          author: 'author',
          body,
          score: 1,
          depth: 0,
          createdUtc: 1,
          replyCount: 0,
          bodyLength: body.length,
          bodyPreview: '',
          isDeleted: false,
        },
      ],
      snapshot: {
        version: 1,
        id: '11111111-1111-4111-8111-111111111111',
        postId: 'abc',
        sort: 'confidence',
        startedAt: '2026-08-31T12:00:00.000Z',
        updatedAt: '2026-08-31T12:00:01.000Z',
        expiresAt: '2026-09-01T12:00:00.000Z',
        sourceExhausted: continuation,
      },
      page: {
        nextCursor: continuation ? null : 'opaque-next-cursor',
        hasMore: !continuation,
        returned: 1,
        truncatedBy: null,
      },
      coverage: {
        reportedTotal: 2500,
        retrievedUnique: continuation ? 2500 : 1200,
        uniqueReturned: continuation ? 2500 : 1200,
        deleted: 0,
        unavailable: 0,
        unavailableBranches: 0,
        knownRemaining: continuation ? 0 : 1300,
        reportedGap: continuation ? 0 : 1300,
        cursorsRemaining: !continuation,
        continuationsRemaining: continuation ? 0 : 4,
        frontierRemaining: continuation ? 0 : 4,
        sortsSampled: ['confidence'],
        traversalComplete: continuation,
        coverageComplete: continuation,
        coverageStatus: continuation ? 'complete' : 'in_progress',
        complete: continuation,
        snapshotComplete: continuation,
      },
      warnings: [],
      redditRateLimit: { used: '1', remaining: '999', resetSeconds: '60' },
    };
  };

  await withEnv(authEnv, async () => {
    await assertToolError(
      await mcpCall('reddit_get_thread_page', {}, 'Bearer local-dev-token', services),
      'invalid_arguments',
    );
    await assertToolError(
      await mcpCall(
        'reddit_get_thread_page',
        { postId: 'abc', cursor: 'opaque-next-cursor' },
        'Bearer local-dev-token',
        services,
      ),
      'invalid_arguments',
    );
    await assertToolError(
      await mcpCall(
        'reddit_get_thread_page',
        { cursor: 'opaque-next-cursor', sort: 'top' },
        'Bearer local-dev-token',
        services,
      ),
      'invalid_arguments',
    );

    const first = await mcpCall(
      'reddit_get_thread_page',
      { postId: 'abc', pageSize: 50, maxMoreChildrenRequests: 2 },
      'Bearer local-dev-token',
      services,
    );
    assert.equal(first.jsonBody.result.structuredContent.comments[0].body.length, 1200);
    assert.equal(first.jsonBody.result.structuredContent.page.nextCursor, 'opaque-next-cursor');
    assert.equal(first.jsonBody.result.structuredContent.coverage.complete, false);

    const second = await mcpCall(
      'reddit_get_thread_page',
      { cursor: 'opaque-next-cursor', pageSize: 50 },
      'Bearer local-dev-token',
      services,
    );
    assert.equal(second.jsonBody.result.structuredContent.comments[0].id, 'c2');
    assert.equal(second.jsonBody.result.structuredContent.page.nextCursor, null);
    assert.equal(second.jsonBody.result.structuredContent.coverage.complete, true);
  });

  assert.deepEqual(calls, [
    [
      'fetchThreadComments',
      {
        post: 'abc',
        limit: 50,
        includeBody: true,
        bodyPreviewChars: 0,
        includeDeleted: true,
        maxBytes: 131072,
        maxMoreChildrenRequests: 2,
      },
    ],
    [
      'fetchThreadComments',
      {
        cursor: 'opaque-next-cursor',
        limit: 50,
        includeBody: true,
        bodyPreviewChars: 0,
        includeDeleted: true,
        maxBytes: 131072,
        maxMoreChildrenRequests: 5,
      },
    ],
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
        {
          id: '1',
          title: 'Bike one',
          priceAmount: 100,
          location: 'Wien',
          postcode: '1010',
          state: 'Wien',
          publishedAt: '2026-06-02T10:00:00Z',
          imageCount: 1,
        },
        {
          id: '2',
          title: 'Bike two',
          priceAmount: 250,
          location: 'Wien',
          postcode: '1010',
          state: 'Wien',
          publishedAt: '2026-06-03T10:00:00Z',
          imageCount: 2,
        },
        {
          id: '3',
          title: 'Bike old',
          priceAmount: 300,
          location: 'Wien',
          postcode: '1010',
          state: 'Wien',
          publishedAt: '2026-05-01T10:00:00Z',
          imageCount: 3,
        },
        {
          id: '4',
          title: 'Bike Graz',
          priceAmount: 400,
          location: 'Graz',
          postcode: '8010',
          state: 'Steiermark',
          publishedAt: '2026-06-04T10:00:00Z',
          imageCount: 4,
        },
      ],
    };
  };

  await withEnv(authEnv, async () => {
    const response = await mcpCall(
      'wlh_search',
      {
        keyword: 'bike',
        categoryId: '10',
        requiredTerms: ['bike'],
        locationText: 'Wien',
        postcode: '101',
        postedSince: '2026-06-01',
        imageRequired: true,
        sort: 'price_desc',
      },
      'Bearer local-dev-token',
      services,
    );

    const content = response.jsonBody.result.structuredContent;
    assert.equal(response.status, 200);
    assert.equal(content.filteredRowsReturned, 2);
    assert.deepEqual(
      content.results.map((result) => result.id),
      ['2', '1'],
    );
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

test('MCP rejects concurrent Reddit expansion work for the same principal', async () => {
  const services = stubServices();
  const fetchThread = services.reddit.fetchThread;
  let signalEntered;
  let release;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  services.reddit.fetchThread = async (args) => {
    calls += 1;
    signalEntered();
    await blocked;
    return fetchThread(args);
  };

  await withEnv(authEnv, async () => {
    const first = mcpCall('reddit_get_thread', { postId: 'abc' }, 'Bearer local-dev-token', services);
    await entered;
    const second = await mcpCall('reddit_get_thread', { postId: 'def' }, 'Bearer local-dev-token', services);
    assertToolError(second, 'upstream_rate_limited', 'reddit');
    assert.equal(calls, 1);
    release();
    const completed = await first;
    assert.equal(completed.jsonBody.result.structuredContent.post.id, 'abc');
  });
});

test('MCP validation rejects invalid Reddit and WLH arguments with safe tool errors', async () => {
  await withEnv(authEnv, async () => {
    await assertToolError(await mcpCall('reddit_get_thread', {}, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(
      await mcpCall(
        'reddit_get_thread',
        { postId: 'abc', url: 'https://www.reddit.com/r/test/comments/abc/example/' },
        'Bearer local-dev-token',
      ),
      'invalid_arguments',
    );
    const validPost = await mcpCall('reddit_get_thread', { postId: 'abc123' }, 'Bearer local-dev-token');
    assert.equal(validPost.jsonBody.result.structuredContent.post.id, 'abc123');
    const validUrl = await mcpCall(
      'reddit_get_thread_overview',
      { url: 'https://redd.it/abc123' },
      'Bearer local-dev-token',
    );
    assert.equal(validUrl.jsonBody.result.structuredContent.post.id, 'https://redd.it/abc123');

    await assertToolError(await mcpCall('wlh_get_offer', {}, 'Bearer local-dev-token'), 'invalid_arguments');
    await assertToolError(
      await mcpCall(
        'wlh_get_offer',
        { adId: '123456', url: 'https://www.willhaben.at/iad/kaufen-und-verkaufen/d/test-123456' },
        'Bearer local-dev-token',
      ),
      'invalid_arguments',
    );
    await assertToolError(
      await mcpCall(
        'wlh_get_offer',
        { url: 'https://example.com/iad/kaufen-und-verkaufen/d/test-123456' },
        'Bearer local-dev-token',
      ),
      'unsupported_url',
    );

    await assertToolError(
      await mcpCall('wlh_search', { keyword: 'bike', priceFrom: -1 }, 'Bearer local-dev-token'),
      'invalid_arguments',
    );
    await assertToolError(
      await mcpCall('wlh_search', { keyword: 'bike', priceFrom: 100, priceTo: 10 }, 'Bearer local-dev-token'),
      'invalid_arguments',
    );
    await assertToolError(
      await mcpCall('wlh_search', { keyword: 'bike', postedSince: 'not-a-date' }, 'Bearer local-dev-token'),
      'invalid_arguments',
    );
    assertMcpValidationError(
      await mcpCall('wlh_search', { keyword: 'bike', radiusKm: 10 }, 'Bearer local-dev-token'),
      'radiusKm',
    );
    assertMcpValidationError(
      await mcpCall('wlh_search', { keyword: 'bike', sellerType: 'private' }, 'Bearer local-dev-token'),
      'sellerType',
    );
  });
});

test('external service exceptions become safe MCP tool errors without sensitive material', async () => {
  const secretNeedles =
    /Bearer|token|claims|headers|cookie|secret|password|Authorization|FAKE-CONNECTION-CANARY|FAKE-SAS-CANARY|AccountKey|[?&]sig=/i;
  const services = stubServices();
  services.reddit.fetchThread = async () => {
    throw new Error(
      'upstream exploded with Authorization: Bearer SHOULD_NOT_LEAK AccountKey=FAKE-CONNECTION-CANARY&sig=FAKE-SAS-CANARY',
    );
  };
  services.wlh.search = async () => {
    const error = new Error('rate-limited with cookie SHOULD_NOT_LEAK?sig=FAKE-SAS-CANARY');
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

test('MCP Bring read errors preserve safe classifications and upstream status without response content', async () => {
  const services = stubServices();
  services.bring.getList = async () => {
    throw new BringUpstreamError('Bring dependency request failed.', 502, 'upstream', {
      operation: 'get_items',
      method: 'GET',
      path: 'v2/bringlists/{uuid}',
      upstreamStatus: 400,
      responseExcerpt: 'password=SHOULD_NOT_LEAK token=SHOULD_NOT_LEAK',
    });
  };
  await withEnv(authEnv, async () => {
    const response = await mcpCall('bring_get_items', { listUuid: bringListUuid }, 'Bearer local-dev-token', services);
    assertToolError(response, 'bring_upstream_error', 'bring');
    assert.equal(response.jsonBody.result.structuredContent.upstreamStatus, 400);
    assert.doesNotMatch(JSON.stringify(response.jsonBody), /SHOULD_NOT_LEAK|responseExcerpt|password|token/i);
  });
});

async function mcpRequest(body, authorization = undefined, services = stubServices()) {
  const serializedBody = JSON.stringify(body);
  return handleMcpHttpRequest(
    {
      method: 'POST',
      url: 'http://localhost:7071/mcp',
      headers: new Headers({
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:7071',
        'content-length': String(Buffer.byteLength(serializedBody)),
        ...(authorization ? { authorization } : {}),
      }),
      params: {},
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(serializedBody));
          controller.close();
        },
      }),
      json: async () => {
        throw new Error('MCP gateway must use the bounded body reader');
      },
    },
    { invocationId: 'mcp-tools-test', warn: () => undefined },
    services,
  );
}

async function mcpCall(name, args = {}, authorization, services = stubServices()) {
  return mcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    authorization,
    services,
  );
}

function assertMcpValidationError(response, field) {
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.result.isError, true);
  const text = response.jsonBody.result.content[0].text;
  assert.match(text, /Input validation error/);
  assert.match(text, new RegExp(field));
  assert.doesNotMatch(
    JSON.stringify(response.jsonBody),
    /Bearer|local-dev-token|claims|headers|cookie|secret|password|Authorization/i,
  );
}

function assertToolError(response, error, source = undefined) {
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.result.isError, true);
  assert.equal(response.jsonBody.result.structuredContent.error, error);
  if (source) assert.equal(response.jsonBody.result.structuredContent.source, source);
  const problem = response.jsonBody.result.structuredContent.repairable_problem;
  assert.equal(problem.rec_version, '1.0');
  assert.match(problem.diagnostic_id, /^diag_/);
  assert.equal(problem.instance, `urn:diagnostic:${problem.diagnostic_id}`);
  assert.equal(typeof problem.caller_instruction, 'string');
  assert.equal(problem.caller_instruction.length > 0, true);
  const serialized = JSON.stringify(response.jsonBody);
  assert.doesNotMatch(serialized, /Bearer|local-dev-token|claims|headers|cookie|secret|password|Authorization\s*:/i);
}

function stubServices(calls = []) {
  return {
    reddit: {
      fetchThread: async (args) => {
        calls.push(['fetchThread', args]);
        const id = args.post ?? args.url;
        return {
          source: 'reddit',
          post: { id, title: 'Thread', subreddit: 'test', numComments: 1 },
          comments: [
            {
              id: 'c1',
              parentId: `t3_${id}`,
              author: 'a',
              body: 'hello',
              score: 1,
              depth: 0,
              createdUtc: 1,
              replies: [],
            },
          ],
          commentContinuations: [],
          stats: { commentsReturned: 1 },
          redditRateLimit: { used: null, remaining: null, resetSeconds: null },
        };
      },
      fetchThreadOverview: async (args) => {
        calls.push(['fetchThreadOverview', args]);
        const id = args.post ?? args.url;
        return {
          source: 'reddit',
          post: { id, title: 'Thread', subreddit: 'test', numComments: 5 },
          stats: { loadedSnapshotCommentCount: 5 },
          availableSorts: ['top'],
          coverage: {},
          redditRateLimit: { used: null, remaining: null, resetSeconds: null },
        };
      },
      fetchThreadComments: async () => {
        throw new Error('fetchThreadComments test stub must be configured by the calling test.');
      },
    },
    wlh: {
      search: async (args) => {
        calls.push(['search', args]);
        return {
          source: 'wlh',
          rowsFound: 1,
          rowsReturned: 1,
          filteredRowsReturned: 1,
          category: { id: args.categoryId, label: 'Bikes', path: '/bikes', depth: 1, hasChildren: false },
          results: [
            {
              id: '123',
              title: 'Bike',
              priceAmount: 99,
              priceDisplay: '€ 99',
              location: 'Vienna',
              url: 'https://example.test/123',
              thumbnailUrl: 'thumb',
              paylivery: true,
              imageCount: 1,
            },
          ],
        };
      },
      offer: async (adId) => {
        calls.push(['offer', adId]);
        return {
          source: 'wlh',
          id: adId,
          title: 'Offer',
          description: 'Nice bike',
          priceAmount: 99,
          location: 'Vienna',
          paylivery: true,
          images: [
            { id: 'i1', url: 'image1' },
            { id: 'i2', url: 'image1' },
          ],
        };
      },
      topCategories: async () => {
        calls.push(['topCategories']);
        return [{ id: '10', label: 'Bikes', path: '/bikes', depth: 0, hasChildren: true }];
      },
      children: async (categoryId) => {
        calls.push(['children', categoryId]);
        return [
          { id: '11', label: 'Bike parts', path: '/bikes/parts', depth: 1, parentId: categoryId, hasChildren: false },
        ];
      },
    },
    bring: {
      listLists: async () => ({
        source: 'bring',
        lists: [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'Home', isDefault: true, shared: false }],
      }),
      getList: async (listUuid) => ({
        uuid: listUuid ?? '11111111-1111-4111-8111-111111111111',
        version: '0'.repeat(64),
        items: [{ name: 'Milch', status: 'active' }],
      }),
      addItems: async (_principal, command) => ({
        source: 'bring',
        listUuid: command.listUuid,
        operation: 'add',
        operationId: command.operationId,
        itemCount: command.items.length,
        state: 'succeeded',
        replayed: false,
      }),
      prepareMutation: async (_principal, command) => ({
        source: 'bring',
        state: 'prepared',
        operationId: command.operationId,
        operation: command.operation,
        listPseudonym: 'a'.repeat(64),
        itemCount: command.items.length,
        expiresAt: '2026-07-26T12:05:00.000Z',
        confirmationToken: `${command.operation}.safe-token`,
        replayed: false,
      }),
      applyMutation: async (_principal, command) => ({
        source: 'bring',
        listUuid: bringListUuid,
        operation: command.confirmationToken.startsWith('complete') ? 'complete' : 'remove',
        operationId: command.operationId,
        itemCount: 1,
        state: 'succeeded',
        replayed: false,
      }),
      getMutationOperation: async () => 'remove',
    },
  };
}

function expectedScopes(toolName) {
  if (toolName === 'hello_authenticated') return ['catalogue.read'];
  if (toolName.startsWith('reddit_')) return ['reddit.read'];
  if (toolName.startsWith('wlh_')) return ['wlh.read'];
  if (toolName === 'bring_add_item') return ['bring.write'];
  if (toolName === 'bring_prepare_item_mutation' || toolName === 'bring_apply_item_mutation') {
    return ['bring.complete', 'bring.remove'];
  }
  if (toolName.startsWith('bring_')) return ['bring.read'];
  throw new Error(`Unhandled protected MCP tool: ${toolName}`);
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
