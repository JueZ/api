import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRoutesFromSource,
  findDuplicateOperationIds,
  findGptWlhThinSchemaIssues,
  findMissingCanonicalRoutes,
  findStaleSplitContractReferences,
  findUnexpectedSplitContractFiles,
} from '../check-openapi-route-drift.mjs';

test('OpenAPI drift CLI executes its check on native filesystem paths', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../check-openapi-route-drift.mjs', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OpenAPI route drift check passed for \d+ implementation route\(s\)\./);
});

test('extracts app.http routes and documentable methods from Azure Functions source', () => {
  const source = `
    import { app } from '@azure/functions';
    import { authorizeRequest } from '../shared/security/auth.js';
    async function handler(request, context) { await authorizeRequest(request, context); }
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
    },
    {
      functionName: 'sampleRoute',
      filePath: 'sample.ts',
      method: 'post',
      path: '/api/sample/{id}',
      protected: true,
    },
  ]);
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
