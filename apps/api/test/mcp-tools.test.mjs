import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMcpHttpRequest } from '../dist/mcp/server.js';

const authEnv = {
  AUTH_ENABLED: 'false',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
};

test('MCP initialize and tools/list expose the private read-only tool catalogue', async () => {
  await withEnv(authEnv, async () => {
    const initialize = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.jsonBody.result.serverInfo.name, 'api-catalogue-private-mcp');

    const listed = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = listed.jsonBody.result.tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'health_check',
      'hello_authenticated',
      'reddit_get_thread',
      'reddit_get_thread_overview',
      'wlh_categories_top',
      'wlh_category_children',
      'wlh_get_offer',
      'wlh_search',
    ].sort());

    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.ok(tool.outputSchema, `${tool.name} must expose an output schema`);
      if (tool.name === 'health_check') {
        assert.deepEqual(tool.securitySchemes, [{ type: 'noauth' }]);
        assert.deepEqual(tool._meta.securitySchemes, [{ type: 'noauth' }]);
      } else {
        assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['api.access'] }]);
        assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['api.access'] }]);
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
    const reddit = await mcpCall('reddit_get_thread', { post: 'abc', sort: 'top', maxComments: 2 }, 'Bearer local-dev-token', services);
    assert.equal(reddit.jsonBody.result.structuredContent.post.id, 'abc');
    assert.equal(reddit.jsonBody.result.content[0].text, 'Fetched Reddit thread abc with 2 comments.');

    const overview = await mcpCall('reddit_get_thread_overview', { post: 'abc' }, 'Bearer local-dev-token', services);
    assert.equal(overview.jsonBody.result.structuredContent.stats.loadedSnapshotCommentCount, 5);

    const search = await mcpCall('wlh_search', { categoryId: '10', keyword: 'bike' }, 'Bearer local-dev-token', services);
    assert.equal(search.jsonBody.result.structuredContent.filteredRowsReturned, 1);

    const offer = await mcpCall('wlh_get_offer', { adId: '123' }, 'Bearer local-dev-token', services);
    assert.equal(offer.jsonBody.result.structuredContent.id, '123');

    const top = await mcpCall('wlh_categories_top', {}, 'Bearer local-dev-token', services);
    assert.equal(top.jsonBody.result.structuredContent.categories[0].id, '10');

    const children = await mcpCall('wlh_category_children', { categoryId: '10' }, 'Bearer local-dev-token', services);
    assert.equal(children.jsonBody.result.structuredContent.categories[0].id, '11');
  });

  assert.deepEqual(calls, [
    ['fetchThread', { post: 'abc', sort: 'top', maxComments: 2 }],
    ['fetchThreadOverview', { post: 'abc' }],
    ['search', { categoryId: '10', keyword: 'bike' }],
    ['offer', '123'],
    ['topCategories'],
    ['children', '10'],
  ]);
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

function stubServices(calls = []) {
  return {
    reddit: {
      fetchThread: async (args) => {
        calls.push(['fetchThread', args]);
        return { source: 'reddit', post: { id: args.post }, comments: [], commentContinuations: [], stats: { commentsReturned: 2 }, redditRateLimit: { used: null, remaining: null, resetSeconds: null } };
      },
      fetchThreadOverview: async (args) => {
        calls.push(['fetchThreadOverview', args]);
        return { source: 'reddit', post: { id: args.post }, stats: { loadedSnapshotCommentCount: 5 }, availableSorts: ['top'], coverage: {}, redditRateLimit: { used: null, remaining: null, resetSeconds: null } };
      },
    },
    wlh: {
      search: async (args) => {
        calls.push(['search', args]);
        return { source: 'wlh', rowsReturned: 1, filteredRowsReturned: 1, results: [{ id: '123' }] };
      },
      offer: async (adId) => {
        calls.push(['offer', adId]);
        return { source: 'wlh', id: adId, title: 'Offer' };
      },
      topCategories: async () => {
        calls.push(['topCategories']);
        return [{ id: '10', label: 'Top', path: '/', depth: 0, hasChildren: true }];
      },
      children: async (categoryId) => {
        calls.push(['children', categoryId]);
        return [{ id: '11', label: 'Child', path: '/child', depth: 1, parentId: categoryId, hasChildren: false }];
      },
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
