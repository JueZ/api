import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  authorizeRequest,
  clearOidcCachesForTesting,
  discoverJwksUri,
  readAuthConfig,
  verifyJwtWithJose,
} from '../dist/shared/security/auth.js';

const baseConfig = Object.freeze({
  enabled: true,
  issuer: 'https://login.example.test/tenant/v2.0',
  issuers: ['https://login.example.test/tenant/v2.0'],
  audience: 'api://catalogue-test',
  requiredScopes: ['catalogue.read'],
  allowedObjectIds: ['allowed-oid'],
  allowedSubjects: ['allowed-sub'],
  allowedAppObjectIds: ['allowed-app-oid'],
  allowedClientIds: ['allowed-client-id'],
  allowedDelegatedClientIds: ['allowed-delegated-client-id', 'delegated-client-id'],
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

async function authorize(authorization, payload, overrides = {}, policy) {
  return authorizeRequest(
    requestWithAuthorization(authorization),
    context(),
    { ...baseConfig, ...overrides },
    await verifierReturning(payload),
    policy,
  );
}

async function withDeployedEnvironment(environment, action) {
  const previous = process.env.DEPLOYED_ENVIRONMENT_NAME;
  process.env.DEPLOYED_ENVIRONMENT_NAME = environment;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.DEPLOYED_ENVIRONMENT_NAME;
    else process.env.DEPLOYED_ENVIRONMENT_NAME = previous;
  }
}

test('missing Authorization header returns 401', async () => {
  const result = await authorize(undefined, {});

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  assert.equal(result.response.jsonBody.error.code, 'unauthorized');
});

test('disabled authentication fails closed outside local development', async () => {
  const result = await withDeployedEnvironment('test', async () =>
    authorizeRequest(
      requestWithAuthorization(undefined),
      context(),
      { ...baseConfig, enabled: false },
      await verifierReturning({}),
      {
        permission: 'catalogue.read',
        allowedTokenTypes: ['user', 'service'],
        environment: 'local',
      },
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  assert.equal(result.response.jsonBody.error.message, 'Authentication is not configured.');
});

test('disabled authentication retains the local development principal only in local', async () => {
  const result = await withDeployedEnvironment('local', async () =>
    authorizeRequest(
      requestWithAuthorization(undefined),
      context(),
      { ...baseConfig, enabled: false },
      await verifierReturning({}),
      {
        permission: 'catalogue.read',
        allowedTokenTypes: ['user', 'service'],
        environment: 'test',
      },
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.user.subject, 'local-dev-placeholder');
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
    azp: 'allowed-delegated-client-id',
    scp: 'other.scope',
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.code, 'forbidden');
});

test('read permission cannot authorize a write operation', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'allowed-sub',
      oid: 'allowed-oid',
      azp: 'allowed-delegated-client-id',
      scp: 'bring.read',
    },
    {},
    {
      permission: 'bring.write',
      allowedTokenTypes: ['user'],
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Required permission is missing: bring.write.');
});

test('operation policy rejects an otherwise authorized operation in the wrong environment', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'allowed-sub',
      oid: 'allowed-oid',
      azp: 'allowed-delegated-client-id',
      scp: 'bring.write',
    },
    {},
    {
      permission: 'bring.write',
      allowedTokenTypes: ['user'],
      environment: 'test',
      allowedEnvironments: ['local', 'prod'],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Operation is not allowed in this environment.');
});

test('service token is denied for destructive Bring operations even with the matching role', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'allowed-app-oid',
      idtyp: 'app',
      azp: 'service-client-id',
      roles: ['bring.remove'],
    },
    {},
    {
      permission: 'bring.remove',
      allowedTokenTypes: ['user'],
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Token type is not allowed for this operation.');
});

test('valid token for user outside allowlist returns 403', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'blocked-sub',
    oid: 'blocked-oid',
    scp: 'catalogue.read',
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
    azp: 'allowed-delegated-client-id',
    scp: 'catalogue.read',
    preferred_username: 'martin@example.test',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'user-subject',
    objectId: 'allowed-oid',
    tenantId: 'tenant-id',
    clientId: 'allowed-delegated-client-id',
    tokenType: 'user',
    scopes: ['catalogue.read'],
    roles: [],
  });
});

test('allowed subject fallback works only when oid is absent', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'allowed-sub',
    azp: 'allowed-delegated-client-id',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'allowed-sub',
    objectId: undefined,
    tenantId: undefined,
    clientId: 'allowed-delegated-client-id',
    tokenType: 'user',
    scopes: [],
    roles: ['catalogue.read'],
  });
});

test('app-only service token with allowed app object ID returns service authorization result', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'service-subject',
    oid: 'allowed-app-oid',
    tid: 'tenant-id',
    idtyp: 'app',
    azp: 'service-client-id',
    azpacr: '2',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'service-subject',
    objectId: 'allowed-app-oid',
    tenantId: 'tenant-id',
    clientId: 'service-client-id',
    tokenType: 'service',
    scopes: [],
    roles: ['catalogue.read'],
  });
});

test('app-only service role aliases normalize to canonical operation permissions', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'allowed-app-oid',
      tid: 'tenant-id',
      idtyp: 'app',
      azp: 'service-client-id',
      azpacr: '2',
      roles: ['catalogue.service.read', 'reddit.service.read', 'catalogue.read'],
    },
    {},
    {
      permission: 'reddit.read',
      allowedTokenTypes: ['service'],
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.user.roles, ['catalogue.read', 'reddit.read']);
});

test('service role aliases do not grant delegated user permissions', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'tenant-id',
      azp: 'delegated-client-id',
      scp: 'profile',
      roles: ['catalogue.service.read'],
    },
    {},
    {
      permission: 'catalogue.read',
      allowedTokenTypes: ['user'],
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Required permission is missing: catalogue.read.');
});

test('app-only service token can be allowed by client ID', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'unlisted-app-oid',
      tid: 'tenant-id',
      idtyp: 'app',
      azp: 'allowed-client-id',
      azpacr: '2',
      roles: ['catalogue.read'],
    },
    { allowedAppObjectIds: [] },
  );

  assert.equal(result.ok, true);
  assert.equal(result.user.tokenType, 'service');
  assert.equal(result.user.clientId, 'allowed-client-id');
});

test('roles-only service token without idtyp but with client-credential marker can be allowed by app object ID', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'service-subject',
    oid: 'allowed-app-oid',
    tid: 'tenant-id',
    azp: 'service-client-id',
    azpacr: '2',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'service-subject',
    objectId: 'allowed-app-oid',
    tenantId: 'tenant-id',
    clientId: 'service-client-id',
    tokenType: 'service',
    scopes: [],
    roles: ['catalogue.read'],
  });
});

test('roles-only service token without idtyp but with client-credential marker can be allowed by client ID', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'unlisted-app-oid',
      tid: 'tenant-id',
      azp: 'allowed-client-id',
      azpacr: '2',
      roles: ['catalogue.read'],
    },
    { allowedAppObjectIds: [] },
  );

  assert.equal(result.ok, true);
  assert.equal(result.user.tokenType, 'service');
  assert.equal(result.user.clientId, 'allowed-client-id');
});

test('delegated user token fails closed when delegated client allowlist is empty', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'tenant-id',
      azp: 'unlisted-delegated-client-id',
      scp: 'catalogue.read',
    },
    { allowedDelegatedClientIds: [] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Delegated OAuth client is not allowed.');
});

test('delegated user token with allowed azp passes delegated client allowlist', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'tenant-id',
      azp: 'allowed-delegated-client-id',
      scp: 'catalogue.read',
    },
    { allowedDelegatedClientIds: ['allowed-delegated-client-id'] },
  );

  assert.equal(result.ok, true);
  assert.equal(result.user.tokenType, 'user');
});

test('delegated user token with allowed appid passes delegated client allowlist', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'tenant-id',
      appid: 'allowed-delegated-client-id',
      scp: 'catalogue.read',
    },
    { allowedDelegatedClientIds: ['allowed-delegated-client-id'] },
  );

  assert.equal(result.ok, true);
  assert.equal(result.user.tokenType, 'user');
});

test('delegated user token from blocked OAuth client returns 403 after user allowlist', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'tenant-id',
      azp: 'blocked-delegated-client-id',
      scp: 'catalogue.read',
    },
    { allowedDelegatedClientIds: ['allowed-delegated-client-id'] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Delegated OAuth client is not allowed.');
});

test('delegated user token without client claim returns 403 when delegated client allowlist is configured', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'tenant-id',
      scp: 'catalogue.read',
    },
    { allowedDelegatedClientIds: ['allowed-delegated-client-id'] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Delegated OAuth client is not allowed.');
});

test('roles-only token without app-only marker cannot bypass user allowlist via allowed client ID', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'blocked-sub',
    oid: 'blocked-user-oid',
    tid: 'tenant-id',
    azp: 'allowed-client-id',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.code, 'forbidden');
  assert.equal(result.response.jsonBody.error.message, 'User is not allowed.');
});

test('app-only service token remains independent when delegated client allowlist is empty', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'allowed-app-oid',
      tid: 'tenant-id',
      idtyp: 'app',
      azp: 'service-client-id',
      roles: ['catalogue.read'],
    },
    { allowedDelegatedClientIds: [] },
  );

  assert.equal(result.ok, true);
  assert.equal(result.user.tokenType, 'service');
});

test('app-only service token outside app allowlists returns 403', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'service-subject',
    oid: 'blocked-app-oid',
    tid: 'tenant-id',
    idtyp: 'app',
    azp: 'blocked-client-id',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.code, 'forbidden');
});

test('app-only service token from wrong tenant returns 403 before service allowlist', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'allowed-app-oid',
      tid: 'wrong-tenant',
      idtyp: 'app',
      azp: 'allowed-client-id',
      roles: ['catalogue.read'],
    },
    { allowedTenants: ['expected-tenant'] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
});

test('allowed tenants are enforced when configured', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      tid: 'wrong-tenant',
      scp: 'catalogue.read',
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
    await verifierReturning({ sub: 'allowed-sub', scp: 'catalogue.read' }),
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
    OIDC_ALLOWED_APP_OBJECT_IDS: 'allowed-app-oid',
    OIDC_ALLOWED_CLIENT_IDS: 'allowed-client-id',
    OIDC_ALLOWED_DELEGATED_CLIENT_IDS: 'allowed-delegated-client-id, second-delegated-client-id',
  });

  assert.equal(config.issuer, 'https://login.example.test/tenant/v2.0');
  assert.deepEqual(config.issuers, [
    'https://login.example.test/tenant/v2.0',
    'https://login.example.test/consumers/v2.0',
  ]);
  assert.deepEqual(config.allowedAppObjectIds, ['allowed-app-oid']);
  assert.deepEqual(config.allowedClientIds, ['allowed-client-id']);
  assert.deepEqual(config.allowedDelegatedClientIds, ['allowed-delegated-client-id', 'second-delegated-client-id']);
});

test('failed OIDC discovery is evicted so a later request can recover', async () => {
  clearOidcCachesForTesting();
  let requests = 0;
  const issuer = 'https://recoverable-issuer.example.test';
  const fetchStub = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response('temporarily unavailable', { status: 503 });
    }
    return Response.json({ jwks_uri: 'https://recoverable-issuer.example.test/jwks' });
  };

  await assert.rejects(discoverJwksUri(issuer, fetchStub, { maxAttempts: 1, retryDelayMs: 0 }), /HTTP 503/);
  assert.equal(
    await discoverJwksUri(issuer, fetchStub, { maxAttempts: 1, retryDelayMs: 0 }),
    'https://recoverable-issuer.example.test/jwks',
  );
  assert.equal(requests, 2);
  clearOidcCachesForTesting();
});

test('OIDC discovery rejects non-local HTTP JWKS endpoints', async () => {
  clearOidcCachesForTesting();
  await assert.rejects(
    discoverJwksUri(
      'https://issuer-with-insecure-jwks.example.test',
      async () =>
        new Response(JSON.stringify({ jwks_uri: 'http://keys.example.test/jwks' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      { maxAttempts: 1 },
    ),
    /unsupported jwks_uri/,
  );
  clearOidcCachesForTesting();
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
    const token = await new SignJWT({ scp: 'catalogue.read' })
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

test('tenant-specific Microsoft Entra v2 issuer also accepts v1 access token issuer', async () => {
  const entraTenantId = '11111111-2222-3333-4444-555555555555';
  const issuerKeys = await generateKeyPair('RS256');
  const issuerJwk = await exportJWK(issuerKeys.publicKey);
  issuerJwk.kid = 'entra-v1';

  const server = createServer((request, response) => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (request.url === `/${entraTenantId}/v2.0/.well-known/openid-configuration`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jwks_uri: `${baseUrl}/${entraTenantId}/v2.0/jwks` }));
      return;
    }
    if (request.url === `/${entraTenantId}/.well-known/openid-configuration`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jwks_uri: `${baseUrl}/${entraTenantId}/jwks` }));
      return;
    }
    if (request.url === `/${entraTenantId}/v2.0/jwks`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [] }));
      return;
    }
    if (request.url === `/${entraTenantId}/jwks`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [issuerJwk] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const token = await new SignJWT({ scp: 'catalogue.read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'entra-v1' })
      .setIssuer(`${baseUrl}/${entraTenantId}/`)
      .setAudience('api://catalogue-test')
      .setSubject('allowed-sub')
      .setExpirationTime('5m')
      .sign(issuerKeys.privateKey);

    const payload = await verifyJwtWithJose(token, {
      ...baseConfig,
      issuer: `${baseUrl}/${entraTenantId}/v2.0`,
      issuers: [`${baseUrl}/${entraTenantId}/v2.0`],
      audience: 'api://catalogue-test',
    });

    assert.equal(payload.iss, `${baseUrl}/${entraTenantId}/`);
    assert.equal(payload.sub, 'allowed-sub');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
