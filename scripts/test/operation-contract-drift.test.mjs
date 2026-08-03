import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openApiRoutePermissions,
  permissionDrift,
  registeredMcpToolsFromSource,
  registryRoutePermissions,
  registryRoutes,
  routeDrift,
} from '../check-operation-contract-drift.mjs';

test('GPT route selection admits only explicit approvals', () => {
  assert.deepEqual(
    registryRoutes(
      [
        { rest: { method: 'GET', path: '/approved' }, gptActions: true },
        { rest: { method: 'GET', path: '/denied' }, gptActions: false },
        { rest: { method: 'GET', path: '/missing' } },
      ],
      true,
    ),
    new Set(['GET /approved']),
  );
});

test('operation contract drift reports both missing directions', () => {
  assert.deepEqual(routeDrift(new Set(['GET /one', 'POST /two']), new Set(['GET /one', 'GET /three'])), {
    missingFromContract: ['POST /two'],
    missingFromRegistry: ['GET /three'],
  });
});

test('MCP registration parser finds tools in a bundled server or registration helper', () => {
  assert.deepEqual(
    registeredMcpToolsFromSource(`
      server.registerTool('health_check', {}, handler);
      server.registerTool(
        "bring_add_items",
        {},
        handler,
      );
      (server['registerTool'])('wlh_search', {}, handler);
    `),
    new Set(['health_check', 'bring_add_items', 'wlh_search']),
  );
});

test('MCP registration parser rejects computed tool names', () => {
  assert.throws(
    () => registeredMcpToolsFromSource(`server.registerTool(toolName, {}, handler);`, 'dynamic.ts'),
    /registerTool names must be static string literals/,
  );
});

test('operation contract drift compares canonical and fully-qualified permissions per route', () => {
  const expected = registryRoutePermissions([
    {
      requiredPermission: 'bring.complete',
      rest: { method: 'POST', path: '/api/bring/{listUuid}/apply' },
    },
    {
      requiredPermission: 'bring.remove',
      rest: { method: 'POST', path: '/api/bring/{listUuid}/apply' },
    },
  ]);
  const actual = openApiRoutePermissions({
    paths: {
      '/api/bring/{listUuid}/apply': {
        post: {
          security: [{ entraOAuth2: ['api://example/bring.complete'] }, { entraOAuth2: ['api://example/bring.write'] }],
        },
      },
    },
  });
  assert.deepEqual(permissionDrift(expected, actual), [
    {
      route: 'POST /api/bring/{listUuid}/apply',
      missing: ['bring.remove'],
      unexpected: ['bring.write'],
    },
  ]);
});
