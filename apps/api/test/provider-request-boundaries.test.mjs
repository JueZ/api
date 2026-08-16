import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { redditThreadHandler, setRedditThreadServiceForTesting } from '../dist/functions/redditThread.js';
import {
  redditThreadOverviewHandler,
  setRedditThreadOverviewServiceForTesting,
} from '../dist/functions/redditThreadOverview.js';
import {
  redditThreadCommentsHandler,
  setRedditThreadCommentsServiceForTesting,
} from '../dist/functions/redditThreadComments.js';
import {
  redditCommentTreeHandler,
  setRedditCommentTreeServiceForTesting,
} from '../dist/functions/redditCommentTree.js';
import {
  redditCommentsBatchHandler,
  setRedditCommentsBatchServiceForTesting,
} from '../dist/functions/redditCommentsBatch.js';
import { setWlhSearchServiceForTesting, wlhSearchHandler } from '../dist/functions/wlhSearch.js';
import { AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES } from '../dist/shared/http/boundedBody.js';

const routes = [
  {
    name: 'Reddit thread',
    handler: redditThreadHandler,
    install(callCount) {
      setRedditThreadServiceForTesting({
        fetchThread: async () => {
          callCount.value += 1;
          return { ok: true };
        },
      });
      return () => setRedditThreadServiceForTesting(null);
    },
  },
  {
    name: 'Reddit thread overview',
    handler: redditThreadOverviewHandler,
    install(callCount) {
      setRedditThreadOverviewServiceForTesting({
        fetchThreadOverview: async () => {
          callCount.value += 1;
          return { ok: true };
        },
      });
      return () => setRedditThreadOverviewServiceForTesting(null);
    },
  },
  {
    name: 'Reddit thread comments',
    handler: redditThreadCommentsHandler,
    install(callCount) {
      setRedditThreadCommentsServiceForTesting({
        fetchThreadComments: async () => {
          callCount.value += 1;
          return { ok: true };
        },
      });
      return () => setRedditThreadCommentsServiceForTesting(null);
    },
  },
  {
    name: 'Reddit comment tree',
    handler: redditCommentTreeHandler,
    install(callCount) {
      setRedditCommentTreeServiceForTesting({
        fetchCommentTree: async () => {
          callCount.value += 1;
          return { ok: true };
        },
      });
      return () => setRedditCommentTreeServiceForTesting(null);
    },
  },
  {
    name: 'Reddit comments batch',
    handler: redditCommentsBatchHandler,
    install(callCount) {
      setRedditCommentsBatchServiceForTesting({
        fetchCommentsBatch: async () => {
          callCount.value += 1;
          return { ok: true };
        },
      });
      return () => setRedditCommentsBatchServiceForTesting(null);
    },
  },
  {
    name: 'WLH search',
    handler: wlhSearchHandler,
    install(callCount) {
      setWlhSearchServiceForTesting({
        search: async () => {
          callCount.value += 1;
          return { ok: true };
        },
      });
      return () => setWlhSearchServiceForTesting(null);
    },
  },
];

for (const route of routes) {
  test(`${route.name} authenticates before reading the request body`, async () => {
    await withEnv({ DEPLOYED_ENVIRONMENT_NAME: 'local', AUTH_ENABLED: 'true' }, async () => {
      const callCount = { value: 0 };
      const reset = route.install(callCount);
      try {
        const request = baseRequest();
        Object.defineProperty(request, 'body', {
          get() {
            throw new Error('unauthenticated body must not be read');
          },
        });
        const response = await route.handler(request, contextStub());
        assert.equal(response.status, 401);
        assert.equal(callCount.value, 0);
      } finally {
        reset();
      }
    });
  });

  test(`${route.name} rejects declared and streamed body overages without a provider call`, async () => {
    await withEnv({ DEPLOYED_ENVIRONMENT_NAME: 'local', AUTH_ENABLED: 'false' }, async () => {
      const callCount = { value: 0 };
      const reset = route.install(callCount);
      try {
        const declared = baseRequest();
        declared.headers.set('content-length', String(AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES + 1));
        Object.defineProperty(declared, 'body', {
          get() {
            throw new Error('declared oversized body must not be read');
          },
        });
        const declaredResponse = await route.handler(declared, contextStub());
        assertBodyTooLarge(declaredResponse);
        assert.equal(callCount.value, 0);

        const streamed = baseRequest();
        streamed.body = bodyStream([
          new Uint8Array(Math.floor(AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES / 2)),
          new Uint8Array(Math.ceil(AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES / 2)),
          new Uint8Array(1),
        ]);
        const streamedResponse = await route.handler(streamed, contextStub());
        assertBodyTooLarge(streamedResponse);
        assert.equal(callCount.value, 0);
      } finally {
        reset();
      }
    });
  });

  test(`${route.name} rejects malformed bounded JSON without a provider call`, async () => {
    await withEnv({ DEPLOYED_ENVIRONMENT_NAME: 'local', AUTH_ENABLED: 'false' }, async () => {
      const callCount = { value: 0 };
      const reset = route.install(callCount);
      try {
        const request = baseRequest();
        const malformed = new TextEncoder().encode('{');
        request.headers.set('content-length', String(malformed.byteLength));
        request.body = bodyStream([malformed]);
        const response = await route.handler(request, contextStub());
        assert.equal(response.status, 400);
        assert.equal(response.headers['Content-Type'], 'application/problem+json');
        assert.equal(response.jsonBody.classification, 'caller_contract_violation');
        assert.equal(response.jsonBody.analysis_mode, 'deterministic');
        assert.equal(callCount.value, 0);
        if (route.name === 'Reddit comments batch') {
          assert.equal(response.jsonBody.invalid_fields, undefined);
        }
      } finally {
        reset();
      }
    });
  });
}

test('all provider POST routes reject the next-lower valid permission before reading the body', async () => {
  const jwks = await startJwksServer();
  try {
    const token = await new SignJWT({
      sub: 'allowed-subject',
      oid: 'allowed-object-id',
      tid: 'allowed-tenant-id',
      azp: 'allowed-client-id',
      idtyp: 'user',
      scp: 'catalogue.read',
    })
      .setProtectedHeader({ alg: 'RS256', kid: jwks.kid })
      .setIssuer(jwks.issuer)
      .setAudience('api://catalogue-test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(jwks.privateKey);

    await withEnv(
      {
        DEPLOYED_ENVIRONMENT_NAME: 'test',
        AUTH_ENABLED: 'true',
        OIDC_ISSUER: jwks.issuer,
        OIDC_JWKS_URI: jwks.jwksUri,
        OIDC_AUDIENCE: 'api://catalogue-test',
        OIDC_REQUIRED_SCOPES: 'catalogue.read,reddit.read,wlh.read',
        OIDC_ALLOWED_OBJECT_IDS: 'allowed-object-id',
        OIDC_ALLOWED_SUBJECTS: '',
        OIDC_ALLOWED_APP_OBJECT_IDS: '',
        OIDC_ALLOWED_CLIENT_IDS: '',
        OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'allowed-client-id',
        OIDC_ALLOWED_TENANTS: 'allowed-tenant-id',
      },
      async () => {
        for (const route of routes) {
          const callCount = { value: 0 };
          const reset = route.install(callCount);
          try {
            const request = baseRequest();
            request.headers.set('authorization', `Bearer ${token}`);
            Object.defineProperty(request, 'body', {
              get() {
                throw new Error(`${route.name} insufficient-scope body must not be read`);
              },
            });
            const response = await route.handler(request, contextStub());
            assert.equal(response.status, 403, route.name);
            assert.equal(callCount.value, 0, route.name);
          } finally {
            reset();
          }
        }
      },
    );
  } finally {
    await new Promise((resolve, reject) => jwks.server.close((error) => (error ? reject(error) : resolve())));
  }
});

function assertBodyTooLarge(response) {
  assert.equal(response.status, 413);
  assert.equal(response.headers['Content-Type'], 'application/problem+json');
  assert.equal(response.jsonBody.classification, 'caller_contract_violation');
  assert.equal(response.jsonBody.analysis_mode, 'deterministic');
  assert.match(response.jsonBody.detail, new RegExp(`${AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES}-byte limit`));
}

function baseRequest() {
  return {
    method: 'POST',
    url: 'https://api.example.test/api/provider',
    params: {},
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => {
      throw new Error('provider handlers must use the bounded body reader');
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

function contextStub() {
  return { invocationId: 'provider-boundary-test', functionName: 'providerBoundary', warn: () => undefined };
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

async function startJwksServer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const kid = 'provider-boundary-test-key';
  jwk.kid = kid;
  jwk.alg = 'RS256';
  const server = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    issuer: 'https://login.example.test/tenant/v2.0',
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    privateKey,
    kid,
  };
}
