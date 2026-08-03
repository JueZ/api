import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractRoutesFromSource,
  findDuplicateOperationIds,
  findGptExposureDecisionIssues,
  findGptWlhThinSchemaIssues,
  findGptScopeIssues,
  findMissingCanonicalRoutes,
  findImplementationAuthorizationIssues,
  findUnexpectedGptRoutes,
  findStaleSplitContractReferences,
  findUnexpectedSplitContractFiles,
} from '../check-openapi-route-drift.mjs';

test('extracts app.http routes and documentable methods from Azure Functions source', () => {
  const source = `
    import { app } from '@azure/functions';
    import { authorizeRequestForOperation as enforceOperation } from '../shared/security/auth.js';
    import { OPERATION_IDS as CANONICAL_OPERATION_IDS } from '../application/operations/registry.js';
    async function handler(request, context) {
      await enforceOperation(request, context, CANONICAL_OPERATION_IDS.hello);
    }
    app.http('sampleRoute', { methods: ['GET', 'OPTIONS', 'POST'], route: 'api/sample/{id}', handler });
  `;

  const facts = extractRoutesFromSource(source, 'sample.ts').map(
    ({ method, path, protected: isProtected, referencedOperationIds }) => [
      method,
      path,
      isProtected,
      referencedOperationIds,
    ],
  );
  assert.deepEqual(facts, [
    ['get', '/api/sample/{id}', true, ['local.hello']],
    ['post', '/api/sample/{id}', true, ['local.hello']],
  ]);
});

test('authorization evidence is canonical, handler-scoped, helper-aware, and shadow-safe', () => {
  const routes = extractRoutesFromSource(
    `
      import { app } from '@azure/functions';
      import { authorizeRequestForOperation as enforce } from '../shared/security/auth.js';
      import { OPERATION_IDS as IDS } from '../application/operations/registry.js';
      const FAKE_IDS = { hello: 'local.hello' };
      const fake = { authorizeRequestForOperation: async () => ({ ok: true }) };
      async function authorizeRequestForOperation() { return { ok: true }; }
      async function protect(request, context) { return enforce(request, context, IDS.hello); }
      async function protectedHandler(request, context) { return protect(request, context); }
      async function plainHandler() { return { status: 200 }; }
      async function lookalikeHandler(request, context) {
        await authorizeRequestForOperation(request, context, FAKE_IDS.hello);
        return fake.authorizeRequestForOperation(request, context, FAKE_IDS.hello);
      }
      async function shadowedHandler(enforce, request, context) { return enforce(request, context, IDS.hello); }
      function createHandler() {
        async function unused(request, context) { return enforce(request, context, IDS.hello); }
        return plainHandler;
      }
      const factoryHandler = createHandler();
      app.http('protectedRoute', { methods: ['GET'], route: 'api/protected', handler: protectedHandler });
      app.http('plainRoute', { methods: ['GET'], route: 'api/plain', handler: plainHandler });
      app.http('lookalikeRoute', { methods: ['GET'], route: 'api/lookalike', handler: lookalikeHandler });
      app.http('shadowedRoute', { methods: ['GET'], route: 'api/shadowed', handler: shadowedHandler });
      app.http('factoryRoute', { methods: ['GET'], route: 'api/factory', handler: factoryHandler });
    `,
    'mixed.ts',
  );

  assert.deepEqual(
    routes.map(({ path, protected: isProtected, referencedOperationIds }) => [
      path,
      isProtected,
      referencedOperationIds,
    ]),
    [
      ['/api/protected', true, ['local.hello']],
      ['/api/plain', false, []],
      ['/api/lookalike', false, []],
      ['/api/shadowed', false, ['local.hello']],
      ['/api/factory', false, []],
    ],
  );

  const issues = findImplementationAuthorizationIssues(routes, [
    { id: 'local.hello', requiredPermission: 'hello.read', rest: { method: 'GET', path: '/api/plain' } },
  ]);
  assert.deepEqual(issues, [
    'mixed.ts: protected registry route GET /api/plain has no recognized operation authorization call.',
  ]);
});

test('uses the operation id actually passed to authorization helpers', () => {
  const routes = extractRoutesFromSource(
    `
      import { app } from '@azure/functions';
      import { authorizeRequestForOperation } from '../shared/security/auth.js';
      import { OPERATION_IDS as IDS } from '../application/operations/registry.js';

      async function dualRouteHandler(request, context) {
        await authorizeRequestForOperation(request, context, IDS.hello);
        if (IDS.health) {
          return { status: 200 };
        }
      }

      async function aliasedRouteHandler(request, context) {
        const requestedOperation = IDS.health;
        return authorizeRequestForOperation(request, context, requestedOperation);
      }

      app.http('dualRoute', {
        methods: ['GET'],
        route: 'api/dual-route',
        handler: dualRouteHandler,
      });
      app.http('aliasedRoute', {
        methods: ['GET'],
        route: 'api/aliased-route',
        handler: aliasedRouteHandler,
      });
    `,
    'bindings.ts',
  );

  const dualRoute = routes.find((route) => route.path === '/api/dual-route');
  const aliasedRoute = routes.find((route) => route.path === '/api/aliased-route');
  assert.ok(dualRoute);
  assert.ok(aliasedRoute);
  assert.deepEqual(dualRoute.authorizedOperationIds, ['local.hello']);
  assert.deepEqual([...dualRoute.referencedOperationIds].sort(), ['local.health', 'local.hello']);
  assert.deepEqual(aliasedRoute.authorizedOperationIds, ['local.health']);

  const issues = findImplementationAuthorizationIssues(routes, [
    { id: 'local.hello', requiredPermission: 'hello.read', rest: { method: 'GET', path: '/api/dual-route' } },
    { id: 'local.health', requiredPermission: 'health.read', rest: { method: 'GET', path: '/api/dual-route' } },
    { id: 'local.health', requiredPermission: 'health.read', rest: { method: 'GET', path: '/api/aliased-route' } },
  ]);

  assert.deepEqual(issues, [
    "bindings.ts: protected registry route GET /api/dual-route does not reference canonical operation 'local.health'.",
  ]);
});

test('GPT Actions exposure requires explicit routes and scopes', () => {
  assert.deepEqual(
    findGptExposureDecisionIssues([
      { id: 'missing.decision', rest: { method: 'GET', path: '/api/missing' } },
      { id: 'approved.route', rest: { method: 'GET', path: '/api/approved' }, gptActions: true },
      { id: 'invalid.non-rest', gptActions: true },
    ]),
    [
      'missing.decision: operation registry is missing an explicit GPT Actions exposure decision.',
      'invalid.non-rest: operation registry enables GPT Actions without a REST route.',
    ],
  );
  assert.deepEqual(
    findUnexpectedGptRoutes([{ method: 'get', path: '/api/bring/lists' }], {
      paths: {
        '/api/bring/lists': { get: {} },
        '/api/bring/lists/{listUuid}/items': { post: {} },
      },
    }),
    ['GPT Actions OpenAPI exposes non-approved route POST /api/bring/lists/{listUuid}/items.'],
  );
  assert.deepEqual(
    findGptScopeIssues(
      {
        components: {
          securitySchemes: {
            entraOAuth2: {
              flows: { authorizationCode: { scopes: { 'x/bring.read': '', 'x/bring.write': '' } } },
            },
          },
        },
      },
      [
        {
          id: 'bring.get-items',
          requiredPermission: 'bring.read',
          rest: { method: 'GET', path: '/api/bring/lists/{listUuid}/items' },
          gptActions: true,
        },
        {
          id: 'bring.add-items',
          requiredPermission: 'bring.write',
          rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/items' },
          gptActions: false,
        },
      ],
    ),
    ["GPT Actions OAuth exposes non-approved scope 'bring.write'."],
  );
});

test('excludes intentional non-OpenAPI protocol and metadata routes', () => {
  const source = `
    import { app } from '@azure/functions';
    app.http('mcp', {
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      authLevel: 'anonymous',
      route: 'mcp',
      handler,
    });
    app.http('oauthProtectedResource', {
      methods: ['GET', 'OPTIONS'],
      authLevel: 'anonymous',
      route: '.well-known/oauth-protected-resource',
      handler,
    });
  `;

  assert.deepEqual(extractRoutesFromSource(source, 'mcp.ts'), []);
});

test('detects duplicate operationIds within a contract', () => {
  const issues = findDuplicateOperationIds(
    {
      paths: {
        '/one': { get: { operationId: 'duplicateId' } },
        '/two': { post: { operationId: 'duplicateId' } },
      },
    },
    'test contract',
  );

  assert.equal(issues.length, 1);
  assert.match(issues[0], /duplicate operationId 'duplicateId'/);
});

test('detects implementation routes missing from canonical OpenAPI', () => {
  const issues = findMissingCanonicalRoutes([{ method: 'get', path: '/api/missing', filePath: 'missing.ts' }], {
    paths: {
      '/health': { get: { operationId: 'getHealth' } },
    },
  });

  assert.deepEqual(issues, ['canonical OpenAPI is missing implementation route GET /api/missing from missing.ts.']);
});

test('detects GPT WLH request and response schemas that are thinner than canonical schemas', () => {
  const canonical = {
    paths: {
      '/api/wlh/search': {
        post: {
          operationId: 'postWlhSearch',
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WlhSearchRequest' } } },
          },
          responses: {
            200: {
              description: 'Search results',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WlhSearchResponse' } } },
            },
          },
        },
      },
    },
  };
  const gpt = {
    paths: {
      '/api/wlh/search': {
        post: {
          operationId: 'postWlhSearch',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  };

  const issues = findGptWlhThinSchemaIssues(canonical, gpt);

  assert.equal(issues.length, 2);
  assert.match(issues[0], /uses only \{ type: object \} request schema/);
  assert.match(issues[1], /uses a thin 200 response/);
});

test('detects stale split-contract references in the GPT Actions contract', () => {
  const issues = findStaleSplitContractReferences(
    {
      paths: {
        '/api/reddit/thread': { post: { operationId: 'redditThread' } },
      },
    },
    'See contracts/openapi.gpt.reddit.yaml for the old split contract.',
  );

  assert.equal(issues.length, 2);
  assert.match(issues[0], /openapi\.gpt\.reddit\.yaml/);
  assert.match(issues[1], /stale split-contract operationId 'redditThread'/);
});

test('detects removed split GPT contract files if they are reintroduced', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'split-gpt-contract-'));
  try {
    const contractDir = path.join(tmp, 'contracts');
    fs.mkdirSync(contractDir);
    fs.writeFileSync(path.join(contractDir, 'openapi.gpt.reddit.yaml'), 'openapi: 3.1.0\n');

    const issues = findUnexpectedSplitContractFiles(tmp);

    assert.deepEqual(issues, [
      'contracts/openapi.gpt.reddit.yaml was removed; use contracts/openapi.gpt.yaml as the only GPT Actions contract.',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
