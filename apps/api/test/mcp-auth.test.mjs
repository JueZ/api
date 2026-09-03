import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authorizeBearerToken } from '../dist/shared/security/auth.js';
import { oauthProtectedResourceHandler } from '../dist/functions/oauthProtectedResource.js';
import { handleMcpHttpRequest, MCP_REQUEST_BODY_MAX_BYTES } from '../dist/mcp/server.js';
import { getMcpResourceOrigin, validateMcpRequestOrigin } from '../dist/mcp/auth.js';

const baseEnv = {
  AUTH_ENABLED: 'true',
  DEPLOYED_ENVIRONMENT_NAME: 'test',
  OIDC_AUDIENCE: 'api://catalogue-test',
  OIDC_REQUIRED_SCOPES:
    'catalogue.read,reddit.read,wlh.read,weather.read,bring.read,bring.write,bring.complete,bring.remove',
  OIDC_ALLOWED_OBJECT_IDS: 'allowed-oid',
  OIDC_ALLOWED_SUBJECTS: '',
  OIDC_ALLOWED_APP_OBJECT_IDS: '',
  OIDC_ALLOWED_CLIENT_IDS: '',
  OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'allowed-client-id',
  OIDC_ALLOWED_TENANTS: 'allowed-tenant-id',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
  MCP_ALLOWED_ORIGINS: 'https://chatgpt.com',
};

test('authorizeBearerToken reuses existing JWT validation without an Azure HttpRequest', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await signToken(privateKey, kid, issuer, {
      sub: 'allowed-subject',
      oid: 'allowed-oid',
      scp: 'catalogue.read',
    });
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const result = await authorizeBearerToken(`Bearer ${token}`, contextStub());
      assert.equal(result.ok, true);
      assert.equal(result.user.subject, 'allowed-subject');
      assert.equal(result.user.objectId, 'allowed-oid');
    });
  } finally {
    await closeServer(server);
  }
});

test('protected resource metadata is generated from safe environment values', async () => {
  await withEnv(
    {
      ...baseEnv,
      OIDC_ISSUER: 'https://login.example.test/tenant/v2.0',
      MCP_RESOURCE_DOCUMENTATION_URL: 'https://docs.example.test/mcp',
    },
    async () => {
      const response = await oauthProtectedResourceHandler(
        request('GET', 'https://mcp.example.test/.well-known/oauth-protected-resource'),
        contextStub(),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.jsonBody, {
        resource: 'api://catalogue-test',
        authorization_servers: ['https://login.example.test/tenant/v2.0'],
        scopes_supported: [
          'api://catalogue-test/catalogue.read',
          'api://catalogue-test/reddit.read',
          'api://catalogue-test/youtube.read',
          'api://catalogue-test/wlh.read',
          'api://catalogue-test/weather.read',
          'api://catalogue-test/bring.read',
          'api://catalogue-test/bring.write',
          'api://catalogue-test/bring.complete',
          'api://catalogue-test/bring.remove',
        ],
        resource_documentation: 'https://docs.example.test/mcp',
      });
    },
  );
});

test('deployed MCP rejects spoofed hosts, forwarded schemes, and browser origins', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const spoofedHost = request('POST', 'https://mcp.example.test/mcp', {});
    spoofedHost.headers.set('x-forwarded-host', 'attacker.example');
    const hostResponse = await handleMcpHttpRequest(spoofedHost, contextStub(), stubServices());
    assert.equal(hostResponse.status, 403);
    assert.equal(hostResponse.headers['Content-Type'], 'application/problem+json');
    assert.equal(hostResponse.jsonBody.detail, 'MCP forwarded host is not allowed.');
    assert.equal(hostResponse.jsonBody.classification, 'security_suspicious');

    const conflictingHost = request('POST', 'https://mcp.example.test/mcp', {});
    conflictingHost.headers.set('host', 'attacker.example');
    conflictingHost.headers.set('x-forwarded-host', 'mcp.example.test');
    const conflictingHostResponse = await handleMcpHttpRequest(conflictingHost, contextStub(), stubServices());
    assert.equal(conflictingHostResponse.status, 403);
    assert.equal(conflictingHostResponse.jsonBody.detail, 'MCP host is not allowed.');

    const downgradedScheme = request('POST', 'https://mcp.example.test/mcp', {});
    downgradedScheme.headers.set('x-forwarded-proto', 'http');
    const schemeResponse = await handleMcpHttpRequest(downgradedScheme, contextStub(), stubServices());
    assert.equal(schemeResponse.status, 403);
    assert.equal(schemeResponse.jsonBody.detail, 'MCP forwarded scheme is not allowed.');

    const blockedOrigin = request('POST', 'https://mcp.example.test/mcp', {});
    blockedOrigin.headers.set('origin', 'https://attacker.example');
    const originResponse = await handleMcpHttpRequest(blockedOrigin, contextStub(), stubServices());
    assert.equal(originResponse.status, 403);
    assert.equal(originResponse.jsonBody.detail, 'MCP browser origin is not allowed.');
  });
});

test('deployed MCP authority matrix rejects ambiguous proxy headers and binds the URL authority', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const canonical = request('POST', 'https://mcp.example.test/mcp', {});
    canonical.headers.set('x-forwarded-host', 'mcp.example.test');
    canonical.headers.set('x-forwarded-proto', 'https');
    canonical.headers.set('origin', 'https://chatgpt.com');
    assert.deepEqual(validateMcpRequestOrigin(canonical), { ok: true });

    const acceptedSingleForwardedHost = request('POST', 'https://mcp.example.test/mcp', {});
    acceptedSingleForwardedHost.headers.set('x-forwarded-host', 'mcp.example.test');
    assert.deepEqual(validateMcpRequestOrigin(acceptedSingleForwardedHost), { ok: true });

    const acceptedSingleForwardedProto = request('POST', 'https://mcp.example.test/mcp', {});
    acceptedSingleForwardedProto.headers.set('x-forwarded-proto', 'https');
    assert.deepEqual(validateMcpRequestOrigin(acceptedSingleForwardedProto), { ok: true });

    for (const [name, value, message] of [
      ['host', 'mcp.example.test, attacker.example', 'MCP Host header is malformed.'],
      ['x-forwarded-host', 'mcp.example.test, attacker.example', 'MCP forwarded host header is malformed.'],
      ['x-forwarded-proto', 'https, http', 'MCP forwarded scheme header is malformed.'],
      ['origin', 'https://chatgpt.com, https://attacker.example', 'MCP Origin header is malformed.'],
    ]) {
      const ambiguous = request('POST', 'https://mcp.example.test/mcp', {});
      ambiguous.headers.set(name, value);
      assert.deepEqual(validateMcpRequestOrigin(ambiguous), { ok: false, status: 400, message });
    }

    const mismatchedAuthority = request('POST', 'https://attacker.example/mcp', {});
    mismatchedAuthority.headers.set('host', 'mcp.example.test');
    mismatchedAuthority.headers.set('x-forwarded-host', 'mcp.example.test');
    mismatchedAuthority.headers.set('x-forwarded-proto', 'https');
    assert.deepEqual(validateMcpRequestOrigin(mismatchedAuthority), {
      ok: false,
      status: 403,
      message: 'MCP request authority is not allowed.',
    });
  });
});

test('local MCP keeps only the explicit loopback exception and does not trust forwarded authority', async () => {
  await withEnv(
    { DEPLOYED_ENVIRONMENT_NAME: 'local', AUTH_ENABLED: 'false', MCP_RESOURCE_ORIGIN: undefined },
    async () => {
      for (const url of ['http://localhost:7071/mcp', 'http://127.0.0.1:7071/mcp', 'http://[::1]:7071/mcp']) {
        const local = request('POST', url, {});
        local.headers.set('origin', 'https://browser.example');
        assert.deepEqual(validateMcpRequestOrigin(local), { ok: true });
        assert.equal(getMcpResourceOrigin(local), new URL(url).origin);
      }

      const forwardedAttacker = request('POST', 'http://localhost:7071/mcp', {});
      forwardedAttacker.headers.set('x-forwarded-host', 'attacker.example');
      assert.deepEqual(validateMcpRequestOrigin(forwardedAttacker), {
        ok: false,
        status: 403,
        message: 'Local MCP requests must target localhost.',
      });
      assert.equal(getMcpResourceOrigin(forwardedAttacker), 'http://localhost:7071');

      const remote = request('POST', 'https://attacker.example/mcp', {});
      remote.headers.set('host', 'localhost:7071');
      assert.deepEqual(validateMcpRequestOrigin(remote), {
        ok: false,
        status: 403,
        message: 'Local MCP requests must target localhost.',
      });
    },
  );
});

test('unauthenticated MCP POST fails before reading or forwarding its body', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const unreadRequest = request('POST', 'https://mcp.example.test/mcp', { jsonrpc: '2.0' });
    Object.defineProperty(unreadRequest, 'body', {
      get() {
        throw new Error('unauthenticated body must not be read');
      },
    });
    const response = await handleMcpHttpRequest(unreadRequest, contextStub(), stubServices());
    assert.equal(response.status, 401);
    assert.equal(response.jsonBody.classification, 'authorization_context_mismatch');
    assert.match(response.headers['WWW-Authenticate'], /error_description="Missing bearer token\."/);
  });
});

test('local authenticated MCP keeps a configured HTTPS resource origin for missing-bearer challenges', async () => {
  await withEnv(
    {
      ...baseEnv,
      DEPLOYED_ENVIRONMENT_NAME: 'local',
      AUTH_ENABLED: 'true',
      MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
      OIDC_ISSUER: 'https://login.example.test/tenant/v2.0',
    },
    async () => {
      const unreadRequest = request('POST', 'http://localhost:7071/mcp', { jsonrpc: '2.0' });
      Object.defineProperty(unreadRequest, 'body', {
        get() {
          throw new Error('missing-bearer body must not be read');
        },
      });
      const response = await handleMcpHttpRequest(unreadRequest, contextStub(), stubServices());
      assert.equal(response.status, 401);
      assert.match(
        response.headers['WWW-Authenticate'],
        /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/,
      );
    },
  );
});

test('MCP rejects declared and chunked oversized POST bodies before JSON parsing', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const declared = request('POST', 'https://mcp.example.test/mcp', {}, 'Bearer unverified-token');
    declared.headers.set('content-length', String(MCP_REQUEST_BODY_MAX_BYTES + 1));
    Object.defineProperty(declared, 'body', {
      get() {
        throw new Error('declared oversized body must not be read');
      },
    });
    const declaredResponse = await handleMcpHttpRequest(declared, contextStub(), stubServices());
    assert.equal(declaredResponse.status, 413);
    assert.match(declaredResponse.jsonBody.detail, /262144-byte limit/);

    const chunked = request('POST', 'https://mcp.example.test/mcp', {}, 'Bearer unverified-token');
    chunked.headers.delete('content-length');
    chunked.body = bodyStream([
      new Uint8Array(Math.floor(MCP_REQUEST_BODY_MAX_BYTES / 2)),
      new Uint8Array(Math.floor(MCP_REQUEST_BODY_MAX_BYTES / 2)),
      new Uint8Array(1),
    ]);
    const chunkedResponse = await handleMcpHttpRequest(chunked, contextStub(), stubServices());
    assert.equal(chunkedResponse.status, 413);
    assert.match(chunkedResponse.jsonBody.detail, /262144-byte limit/);
  });
});

test('MCP GET event stream without bearer returns HTTP 401 WWW-Authenticate', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const response = await handleMcpHttpRequest(
      request('GET', 'https://mcp.example.test/mcp'),
      contextStub(),
      stubServices(),
    );
    assert.equal(response.status, 401);
    assert.match(response.headers['WWW-Authenticate'], /Bearer resource_metadata=/);
    assert.match(response.headers['WWW-Authenticate'], /scope="api:\/\/catalogue-test\/catalogue\.read"/);
    assert.match(response.headers['WWW-Authenticate'], /error="invalid_token"/);
    assert.match(response.headers['WWW-Authenticate'], /error_description="Missing bearer token\."/);
  });
});

test('AUTH_ENABLED=true plus a valid signed JWT can call hello_authenticated', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await signToken(privateKey, kid, issuer, {
      sub: 'allowed-subject',
      oid: 'allowed-oid',
      scp: 'catalogue.read',
    });
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const response = await mcpCall('hello_authenticated', {}, `Bearer ${token}`);
      assert.equal(response.status, 200);
      assert.equal(response.jsonBody.result.structuredContent.authenticated, true);
      assert.deepEqual(response.jsonBody.result.structuredContent.user, {
        subject: 'allowed-subject',
        objectId: 'allowed-oid',
        tenantId: 'allowed-tenant-id',
      });
      assert.doesNotMatch(JSON.stringify(response.jsonBody), tokenRegex(token));
    });
  } finally {
    await closeServer(server);
  }
});

test('AUTH_ENABLED=true plus a valid signed JWT can call a protected data tool via stub services', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await signToken(privateKey, kid, issuer, {
      sub: 'allowed-subject',
      oid: 'allowed-oid',
      scp: 'reddit.read',
    });
    const calls = [];
    const services = stubServices(calls);
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const response = await mcpCall('reddit_get_thread', { postId: 'abc' }, `Bearer ${token}`, services);
      assert.equal(response.status, 200);
      assert.equal(response.jsonBody.result.structuredContent.post.id, 'abc');
      assert.deepEqual(calls, [['fetchThread', { post: 'abc' }]]);
      assert.doesNotMatch(JSON.stringify(response.jsonBody), tokenRegex(token));
    });
  } finally {
    await closeServer(server);
  }
});

test('MCP advertises the exact missing operation scope', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await signToken(privateKey, kid, issuer, {
      sub: 'allowed-subject',
      oid: 'allowed-oid',
      scp: 'catalogue.read',
    });
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const response = await mcpCall('reddit_get_thread', { postId: 'abc' }, `Bearer ${token}`);
      assertInsufficientScope(response, 'Required permission is missing: reddit.read.', token, 'reddit.read');
    });
  } finally {
    await closeServer(server);
  }
});

test('wrong audience, missing scope, blocked user, and blocked delegated client fail closed', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const wrongAudience = await signToken(
        privateKey,
        kid,
        issuer,
        { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'catalogue.read' },
        'api://wrong',
      );
      const wrongAudienceResponse = await mcpCall('hello_authenticated', {}, `Bearer ${wrongAudience}`);
      assert.equal(wrongAudienceResponse.jsonBody.result.isError, true);
      assert.equal(wrongAudienceResponse.jsonBody.result.structuredContent.error, 'invalid_token');
      assertChallenge(wrongAudienceResponse.jsonBody.result, {
        error: 'invalid_token',
        errorDescription: 'Invalid bearer token.',
      });
      assert.doesNotMatch(JSON.stringify(wrongAudienceResponse.jsonBody), /api:\/\/wrong|allowed-oid|allowed-subject/);

      const missingScope = await signToken(privateKey, kid, issuer, {
        sub: 'allowed-subject',
        oid: 'allowed-oid',
        scp: 'wrong.scope',
      });
      const missingScopeResponse = await mcpCall('hello_authenticated', {}, `Bearer ${missingScope}`);
      assertInsufficientScope(missingScopeResponse, 'Required permission is missing: catalogue.read.', missingScope);

      const blockedUser = await signToken(privateKey, kid, issuer, {
        sub: 'blocked-subject',
        oid: 'blocked-oid',
        scp: 'catalogue.read',
      });
      const blockedUserResponse = await mcpCall('hello_authenticated', {}, `Bearer ${blockedUser}`);
      assertInsufficientScope(blockedUserResponse, 'User is not allowed.', blockedUser);

      const blockedDelegatedClient = await signToken(privateKey, kid, issuer, {
        sub: 'allowed-subject',
        oid: 'allowed-oid',
        scp: 'catalogue.read',
        azp: 'blocked-client-id',
      });
      await withEnv({ OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'allowed-client-id' }, async () => {
        const blockedDelegatedClientResponse = await mcpCall(
          'hello_authenticated',
          {},
          `Bearer ${blockedDelegatedClient}`,
        );
        assertInsufficientScope(
          blockedDelegatedClientResponse,
          'Delegated OAuth client is not allowed.',
          blockedDelegatedClient,
        );
      });
    });
  } finally {
    await closeServer(server);
  }
});

function assertInsufficientScope(response, errorDescription, token, scope = 'catalogue.read') {
  assert.equal(response.jsonBody.result.isError, true);
  assert.equal(response.jsonBody.result.structuredContent.error, 'insufficient_scope');
  assertChallenge(response.jsonBody.result, { error: 'insufficient_scope', errorDescription, scope });
  assert.doesNotMatch(JSON.stringify(response.jsonBody), tokenRegex(token));
}

function assertChallenge(result, { error, errorDescription, scope = 'catalogue.read' }) {
  const challenge = result._meta['mcp/www_authenticate'][0];
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenge, new RegExp(`scope="api:\\/\\/catalogue-test\\/${escapeRegExp(scope)}"`));
  assert.match(challenge, new RegExp(`error="${escapeRegExp(error)}"`));
  assert.match(challenge, new RegExp(`error_description="${escapeRegExp(errorDescription)}"`));
}

function request(method, url, body, authorization) {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    host: new URL(url).host,
  });
  if (authorization) headers.set('authorization', authorization);
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  if (serializedBody !== undefined) headers.set('content-length', String(Buffer.byteLength(serializedBody)));
  return {
    method,
    url,
    headers,
    params: {},
    body: serializedBody === undefined ? null : bodyStream([new TextEncoder().encode(serializedBody)]),
    json: async () => {
      throw new Error('MCP gateway must use the bounded body reader');
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

async function mcpCall(name, args = {}, authorization, services = stubServices()) {
  return handleMcpHttpRequest(
    request(
      'POST',
      'https://mcp.example.test/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      authorization,
    ),
    contextStub(),
    services,
  );
}

function contextStub() {
  return { invocationId: 'mcp-auth-test', warn: () => undefined };
}

function stubServices(calls = []) {
  return {
    reddit: {
      fetchThread: async (args) => {
        calls.push(['fetchThread', args]);
        return { source: 'reddit', post: { id: args?.post ?? 'abc' }, stats: { commentsReturned: 0 } };
      },
      fetchThreadOverview: async () => ({
        source: 'reddit',
        post: { id: 'abc' },
        stats: { loadedSnapshotCommentCount: 0 },
      }),
    },
    wlh: {
      search: async () => ({ source: 'wlh', rowsReturned: 0, filteredRowsReturned: 0 }),
      offer: async (adId) => ({ source: 'wlh', id: adId }),
      topCategories: async () => [],
      children: async () => [],
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

async function signToken(privateKey, kid, issuer, claims, audience = 'api://catalogue-test') {
  return new SignJWT({ azp: 'allowed-client-id', tid: 'allowed-tenant-id', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function startJwksServer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const kid = 'mcp-auth-test-key';
  jwk.kid = kid;
  jwk.alg = 'RS256';
  const server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
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

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function tokenRegex(token) {
  return new RegExp(escapeRegExp(token));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
