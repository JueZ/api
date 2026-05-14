import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authorizeRequest, readAuthConfig, verifyJwtWithJose } from '../dist/shared/security/auth.js';

const baseConfig = Object.freeze({
  enabled: true,
  issuer: 'https://login.example.test/tenant/v2.0',
  issuers: ['https://login.example.test/tenant/v2.0'],
  audience: 'api://catalogue-test',
  requiredScopes: ['api.access'],
  allowedObjectIds: ['allowed-oid'],
  allowedSubjects: ['allowed-sub'],
  allowedTenants: [],
  debug: false,
});

function requestWithAuthorization(value) {
  return {
    headers: new Headers(value === undefined ? {} : { authorization: value }),
  };
}

function context() {
  return {
    warnings: [],
    warn(...args) {
      this.warnings.push(args);
    },
  };
}

async function verifierReturning(payload) {
  return async () => payload;
}

async function authorize(authorization, payload, overrides = {}) {
  return authorizeRequest(
    requestWithAuthorization(authorization),
    context(),
    { ...baseConfig, ...overrides },
    await verifierReturning(payload),
  );
}

test('missing Authorization header returns 401', async () => {
  const result = await authorize(undefined, {});

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  assert.equal(result.response.jsonBody.error.code, 'unauthorized');
});

test('malformed Authorization header returns 401', async () => {
  const result = await authorize('Basic abc123', {});

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  assert.equal(result.response.jsonBody.error.code, 'unauthorized');
});

test('invalid token returns 401 without leaking raw verifier errors or token material', async () => {
  const result = await authorizeRequest(
    requestWithAuthorization('Bearer header.payload.signature'),
    context(),
    baseConfig,
    async () => {
      throw new Error('internal verifier failure with sensitive details');
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  const serializedBody = JSON.stringify(result.response.jsonBody);
  assert.equal(serializedBody.includes('header.payload.signature'), false);
  assert.equal(serializedBody.includes('internal verifier failure'), false);
});

test('valid token missing required scope or role returns 403', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'allowed-sub',
    oid: 'allowed-oid',
    scp: 'other.scope',
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.code, 'forbidden');
});

test('valid token for user outside allowlist returns 403', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'blocked-sub',
    oid: 'blocked-oid',
    scp: 'api.access',
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.code, 'forbidden');
});

test('valid token for allowed object ID returns 200 authorization result', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'user-subject',
    oid: 'allowed-oid',
    tid: 'tenant-id',
    scp: 'api.access',
    preferred_username: 'martin@example.test',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'user-subject',
    objectId: 'allowed-oid',
    tenantId: 'tenant-id',
  });
});

test('allowed subject fallback works only when oid is absent', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'allowed-sub',
    roles: ['api.access'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'allowed-sub',
    objectId: undefined,
    tenantId: undefined,
  });
});

test('allowed tenants are enforced when configured', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'wrong-tenant',
      scp: 'api.access',
    },
    { allowedTenants: ['expected-tenant'] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
});

test('missing required OIDC config fails closed when auth is enabled', async () => {
  const result = await authorizeRequest(
    requestWithAuthorization('Bearer valid-token'),
    context(),
    { ...baseConfig, issuer: undefined, issuers: [] },
    await verifierReturning({ sub: 'allowed-sub', scp: 'api.access' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
});


test('readAuthConfig supports multiple comma-separated issuers', () => {
  const config = readAuthConfig({
    AUTH_ENABLED: 'true',
    OIDC_ISSUER: ' https://login.example.test/tenant/v2.0/, https://login.example.test/consumers/v2.0/ ',
    OIDC_AUDIENCE: 'api://catalogue-test',
    OIDC_ALLOWED_OBJECT_IDS: 'allowed-oid',
  });

  assert.equal(config.issuer, 'https://login.example.test/tenant/v2.0');
  assert.deepEqual(config.issuers, [
    'https://login.example.test/tenant/v2.0',
    'https://login.example.test/consumers/v2.0',
  ]);
});


test('verifyJwtWithJose discovers JWKS for the matching configured issuer', async () => {
  const issuerAKeys = await generateKeyPair('RS256');
  const issuerBKeys = await generateKeyPair('RS256');
  const issuerAJwk = await exportJWK(issuerAKeys.publicKey);
  const issuerBJwk = await exportJWK(issuerBKeys.publicKey);
  issuerAJwk.kid = 'issuer-a';
  issuerBJwk.kid = 'issuer-b';

  const server = createServer((request, response) => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/issuer-a/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jwks_uri: `${baseUrl}/issuer-a/jwks` }));
      return;
    }
    if (request.url === '/issuer-b/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jwks_uri: `${baseUrl}/issuer-b/jwks` }));
      return;
    }
    if (request.url === '/issuer-a/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [issuerAJwk] }));
      return;
    }
    if (request.url === '/issuer-b/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [issuerBJwk] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const token = await new SignJWT({ scp: 'api.access' })
      .setProtectedHeader({ alg: 'RS256', kid: 'issuer-b' })
      .setIssuer(`${baseUrl}/issuer-b`)
      .setAudience('api://catalogue-test')
      .setSubject('allowed-sub')
      .setExpirationTime('5m')
      .sign(issuerBKeys.privateKey);

    const payload = await verifyJwtWithJose(token, {
      ...baseConfig,
      issuer: `${baseUrl}/issuer-a`,
      issuers: [`${baseUrl}/issuer-a`, `${baseUrl}/issuer-b`],
      audience: 'api://catalogue-test',
    });

    assert.equal(payload.iss, `${baseUrl}/issuer-b`);
    assert.equal(payload.sub, 'allowed-sub');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
