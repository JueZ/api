import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractRoutesFromSource,
  findDuplicateOperationIds,
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
    import { authorizeRequestForOperation } from '../shared/security/auth.js';
    import { OPERATION_IDS } from '../application/operations/registry.js';
    async function handler(request, context) {
      await authorizeRequestForOperation(request, context, OPERATION_IDS.hello);
    }
    app.http('sampleRoute', {
      methods: ['GET', 'OPTIONS', 'POST'],
      authLevel: 'anonymous',
      route: 'api/sample/{id}',
      handler,
    });
  `;

  assert.deepEqual(extractRoutesFromSource(source, 'sample.ts'), [
    {
      functionName: 'sampleRoute',
      filePath: 'sample.ts',
      method: 'get',
      path: '/api/sample/{id}',
      protected: true,
      referencedOperationIds: ['local.hello'],
    },
    {
      functionName: 'sampleRoute',
      filePath: 'sample.ts',
      method: 'post',
      path: '/api/sample/{id}',
      protected: true,
      referencedOperationIds: ['local.hello'],
    },
  ]);
});

test('registry-protected routes fail when their handler authorization is removed', () => {
  const routes = extractRoutesFromSource(
    `app.http('sampleRoute', {
      methods: ['POST'],
      route: 'api/sample',
      handler: async () => ({ status: 200 }),
    });`,
    'sample.ts',
  );
  const issues = findImplementationAuthorizationIssues(routes, [
    {
      id: 'sample.read',
      requiredPermission: 'catalogue.read',
      rest: { method: 'POST', path: '/api/sample' },
    },
  ]);
  assert.ok(issues.some((issue) => issue.includes('has no recognized operation authorization call')));
});

test('authorization evidence is scoped to each registered handler and its called helpers', () => {
  const routes = extractRoutesFromSource(
    `
      import { app } from '@azure/functions';
      import { authorizeRequestForOperation } from '../shared/security/auth.js';
      import { OPERATION_IDS } from '../application/operations/registry.js';

      async function authorizeProtected(request, context) {
        return authorizeRequestForOperation(request, context, OPERATION_IDS.hello);
      }
      async function protectedHandler(request, context) {
        return authorizeProtected(request, context);
      }
      async function unprotectedHandler() {
        return { status: 200 };
      }

      app.http('protectedRoute', {
        methods: ['GET'],
        route: 'api/protected',
        handler: protectedHandler,
      });
      app.http('unprotectedRoute', {
        methods: ['GET'],
        route: 'api/unprotected',
        handler: unprotectedHandler,
      });
    `,
    'mixed.ts',
  );

  assert.deepEqual(
    routes.map(({ path, protected: isProtected, referencedOperationIds }) => ({
      path,
      protected: isProtected,
      referencedOperationIds,
    })),
    [
      { path: '/api/protected', protected: true, referencedOperationIds: ['local.hello'] },
      { path: '/api/unprotected', protected: false, referencedOperationIds: [] },
    ],
  );

  const issues = findImplementationAuthorizationIssues(routes, [
    {
      id: 'local.hello',
      requiredPermission: 'hello.read',
      rest: { method: 'GET', path: '/api/unprotected' },
    },
  ]);
  assert.deepEqual(issues, [
    'mixed.ts: protected registry route GET /api/unprotected has no recognized operation authorization call.',
  ]);
});

test('unused authorization inside a handler factory cannot protect its returned handler', () => {
  const routes = extractRoutesFromSource(
    `
      import { app } from '@azure/functions';
      import { authorizeRequestForOperation } from '../shared/security/auth.js';
      import { OPERATION_IDS } from '../application/operations/registry.js';

      function createHandler() {
        async function protectedButUnused(request, context) {
          return authorizeRequestForOperation(request, context, OPERATION_IDS.hello);
        }
        return async function actualHandler() {
          return { status: 200 };
        };
      }

      const handler = createHandler();
      app.http('factoryRoute', {
        methods: ['GET'],
        route: 'api/factory',
        handler,
      });
    `,
    'factory.ts',
  );

  assert.deepEqual(routes, [
    {
      functionName: 'factoryRoute',
      filePath: 'factory.ts',
      method: 'get',
      path: '/api/factory',
      protected: false,
      referencedOperationIds: [],
    },
  ]);
});

test('GPT Actions route allowlist rejects registry-excluded write routes', () => {
  const issues = findUnexpectedGptRoutes([{ method: 'get', path: '/api/bring/lists', filePath: 'bring.ts' }], {
    paths: {
      '/api/bring/lists': { get: { operationId: 'bringListLists' } },
      '/api/bring/lists/{listUuid}/items': { post: { operationId: 'bringAddItems' } },
    },
  });
  assert.deepEqual(issues, ['GPT Actions OpenAPI exposes non-approved route POST /api/bring/lists/{listUuid}/items.']);
});

test('GPT Actions OAuth scope allowlist rejects mutation permissions', () => {
  const issues = findGptScopeIssues(
    {
      components: {
        securitySchemes: {
          entraOAuth2: {
            flows: {
              authorizationCode: {
                scopes: {
                  'api://example/bring.read': 'read',
                  'api://example/bring.write': 'write',
                },
              },
            },
          },
        },
      },
    },
    [
      {
        id: 'bring.get-items',
        requiredPermission: 'bring.read',
        rest: { method: 'GET', path: '/api/bring/lists/{listUuid}/items' },
      },
      {
        id: 'bring.add-items',
        requiredPermission: 'bring.write',
        rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/items' },
        gptActions: false,
      },
    ],
  );
  assert.deepEqual(issues, ["GPT Actions OAuth exposes non-approved scope 'bring.write'."]);
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
