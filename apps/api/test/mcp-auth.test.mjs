import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authorizeBearerToken } from '../dist/shared/security/auth.js';
import { oauthProtectedResourceHandler } from '../dist/functions/oauthProtectedResource.js';
import { handleMcpHttpRequest } from '../dist/mcp/server.js';

const baseEnv = {
  AUTH_ENABLED: 'true',
  OIDC_AUDIENCE: 'api://catalogue-test',
  OIDC_REQUIRED_SCOPES: 'api.access',
  OIDC_ALLOWED_OBJECT_IDS: 'allowed-oid',
  OIDC_ALLOWED_SUBJECTS: '',
  OIDC_ALLOWED_APP_OBJECT_IDS: '',
  OIDC_ALLOWED_CLIENT_IDS: '',
  OIDC_ALLOWED_DELEGATED_CLIENT_IDS: '',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
};

test('authorizeBearerToken reuses existing JWT validation without an Azure HttpRequest', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'api.access' });
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
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0', MCP_RESOURCE_DOCUMENTATION_URL: 'https://docs.example.test/mcp' }, async () => {
    const response = await oauthProtectedResourceHandler(request('GET', 'https://ignored.test/.well-known/oauth-protected-resource'), contextStub());
    assert.equal(response.status, 200);
    assert.deepEqual(response.jsonBody, {
      resource: 'api://catalogue-test',
      authorization_servers: ['https://login.example.test/tenant/v2.0'],
      scopes_supported: ['api://catalogue-test/api.access'],
      resource_documentation: 'https://docs.example.test/mcp',
    });
  });
});

test('unauthenticated private MCP tool fails closed with OAuth challenge metadata', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const response = await mcpCall('hello_authenticated');
    assert.equal(response.status, 200);
    const result = response.jsonBody.result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, 'invalid_token');
    assertChallenge(result, {
      error: 'invalid_token',
      errorDescription: 'Missing bearer token.',
    });
  });
});

test('MCP GET event stream without bearer returns HTTP 401 WWW-Authenticate', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const response = await handleMcpHttpRequest(request('GET', 'https://mcp.example.test/mcp'), contextStub(), stubServices());
    assert.equal(response.status, 401);
    assert.match(response.headers['WWW-Authenticate'], /Bearer resource_metadata=/);
    assert.match(response.headers['WWW-Authenticate'], /scope="api:\/\/catalogue-test\/api\.access"/);
    assert.match(response.headers['WWW-Authenticate'], /error="invalid_token"/);
    assert.match(response.headers['WWW-Authenticate'], /error_description="Missing bearer token\."/);
  });
});

test('AUTH_ENABLED=true plus a valid signed JWT can call hello_authenticated', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'api.access' });
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const response = await mcpCall('hello_authenticated', {}, `Bearer ${token}`);
      assert.equal(response.status, 200);
      assert.equal(response.jsonBody.result.structuredContent.authenticated, true);
      assert.deepEqual(response.jsonBody.result.structuredContent.user, {
        subject: 'allowed-subject',
        objectId: 'allowed-oid',
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
    const token = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'api.access' });
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

test('wrong audience, missing scope, blocked user, and blocked delegated client fail closed', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      const wrongAudience = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'api.access' }, 'api://wrong');
      const wrongAudienceResponse = await mcpCall('hello_authenticated', {}, `Bearer ${wrongAudience}`);
      assert.equal(wrongAudienceResponse.jsonBody.result.isError, true);
      assert.equal(wrongAudienceResponse.jsonBody.result.structuredContent.error, 'invalid_token');
      assertChallenge(wrongAudienceResponse.jsonBody.result, { error: 'invalid_token', errorDescription: 'Invalid bearer token.' });
      assert.doesNotMatch(JSON.stringify(wrongAudienceResponse.jsonBody), /api:\/\/wrong|allowed-oid|allowed-subject/);

      const missingScope = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'wrong.scope' });
      const missingScopeResponse = await mcpCall('hello_authenticated', {}, `Bearer ${missingScope}`);
      assertInsufficientScope(missingScopeResponse, 'Required scope or role is missing.', missingScope);

      const blockedUser = await signToken(privateKey, kid, issuer, { sub: 'blocked-subject', oid: 'blocked-oid', scp: 'api.access' });
      const blockedUserResponse = await mcpCall('hello_authenticated', {}, `Bearer ${blockedUser}`);
      assertInsufficientScope(blockedUserResponse, 'User is not allowed.', blockedUser);

      const blockedDelegatedClient = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'api.access', azp: 'blocked-client-id' });
      await withEnv({ OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'allowed-client-id' }, async () => {
        const blockedDelegatedClientResponse = await mcpCall('hello_authenticated', {}, `Bearer ${blockedDelegatedClient}`);
        assertInsufficientScope(blockedDelegatedClientResponse, 'Delegated OAuth client is not allowed.', blockedDelegatedClient);
      });
    });
  } finally {
    await closeServer(server);
  }
});

function assertInsufficientScope(response, errorDescription, token) {
  assert.equal(response.jsonBody.result.isError, true);
  assert.equal(response.jsonBody.result.structuredContent.error, 'insufficient_scope');
  assertChallenge(response.jsonBody.result, { error: 'insufficient_scope', errorDescription });
  assert.doesNotMatch(JSON.stringify(response.jsonBody), tokenRegex(token));
}

function assertChallenge(result, { error, errorDescription }) {
  const challenge = result._meta['mcp/www_authenticate'][0];
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenge, /scope="api:\/\/catalogue-test\/api\.access"/);
  assert.match(challenge, new RegExp(`error="${escapeRegExp(error)}"`));
  assert.match(challenge, new RegExp(`error_description="${escapeRegExp(errorDescription)}"`));
}

function request(method, url, body, authorization) {
  const headers = new Headers({ accept: 'application/json, text/event-stream', 'content-type': 'application/json' });
  if (authorization) headers.set('authorization', authorization);
  return { method, url, headers, params: {}, json: async () => body };
}

async function mcpCall(name, args = {}, authorization, services = stubServices()) {
  return handleMcpHttpRequest(
    request('POST', 'https://mcp.example.test/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, authorization),
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
      fetchThreadOverview: async () => ({ source: 'reddit', post: { id: 'abc' }, stats: { loadedSnapshotCommentCount: 0 } }),
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
  return new SignJWT(claims)
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
  return { server, issuer: 'https://login.example.test/tenant/v2.0', jwksUri: `http://127.0.0.1:${port}/jwks`, privateKey, kid };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function tokenRegex(token) {
  return new RegExp(escapeRegExp(token));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
