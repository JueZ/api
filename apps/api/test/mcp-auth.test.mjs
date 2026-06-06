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
      resource: 'https://mcp.example.test',
      authorization_servers: ['https://login.example.test/tenant/v2.0'],
      scopes_supported: ['api.access'],
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
    assert.equal(result.structuredContent.error, 'unauthorized');
    assert.match(result._meta['mcp/www_authenticate'][0], /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
  });
});

test('MCP GET event stream without bearer returns HTTP 401 WWW-Authenticate', async () => {
  await withEnv({ ...baseEnv, OIDC_ISSUER: 'https://login.example.test/tenant/v2.0' }, async () => {
    const response = await handleMcpHttpRequest(request('GET', 'https://mcp.example.test/mcp'), contextStub(), stubServices());
    assert.equal(response.status, 401);
    assert.match(response.headers['WWW-Authenticate'], /Bearer resource_metadata=/);
  });
});

test('invalid MCP token scope, audience, and user are rejected without leaking token material', async () => {
  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    await withEnv({ ...baseEnv, OIDC_ISSUER: issuer, OIDC_JWKS_URI: jwksUri }, async () => {
      for (const claims of [
        { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'wrong.scope' },
        { sub: 'blocked-subject', oid: 'blocked-oid', scp: 'api.access' },
      ]) {
        const token = await signToken(privateKey, kid, issuer, claims);
        const response = await mcpCall('hello_authenticated', {}, `Bearer ${token}`);
        assert.equal(response.jsonBody.result.isError, true);
        assert.equal(response.jsonBody.result.structuredContent.error, 'forbidden');
        assert.doesNotMatch(JSON.stringify(response.jsonBody), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }

      const wrongAudience = await signToken(privateKey, kid, issuer, { sub: 'allowed-subject', oid: 'allowed-oid', scp: 'api.access' }, 'api://wrong');
      const response = await mcpCall('hello_authenticated', {}, `Bearer ${wrongAudience}`);
      assert.equal(response.jsonBody.result.isError, true);
      assert.equal(response.jsonBody.result.structuredContent.error, 'unauthorized');
      assert.doesNotMatch(JSON.stringify(response.jsonBody), /api:\/\/wrong|allowed-oid|allowed-subject/);
    });
  } finally {
    await closeServer(server);
  }
});

function request(method, url, body, authorization) {
  const headers = new Headers({ accept: 'application/json, text/event-stream', 'content-type': 'application/json' });
  if (authorization) headers.set('authorization', authorization);
  return { method, url, headers, params: {}, json: async () => body };
}

async function mcpCall(name, args = {}, authorization) {
  return handleMcpHttpRequest(
    request('POST', 'https://mcp.example.test/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, authorization),
    contextStub(),
    stubServices(),
  );
}

function contextStub() {
  return { invocationId: 'mcp-auth-test', warn: () => undefined };
}

function stubServices() {
  return {
    reddit: {
      fetchThread: async () => ({ source: 'reddit', post: { id: 'abc' }, stats: { commentsReturned: 0 } }),
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
