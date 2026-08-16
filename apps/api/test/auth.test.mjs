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

const originalDeployedEnvironmentName = process.env.DEPLOYED_ENVIRONMENT_NAME;
test.before(() => {
  process.env.DEPLOYED_ENVIRONMENT_NAME = 'local';
});
test.after(() => {
  if (originalDeployedEnvironmentName === undefined) delete process.env.DEPLOYED_ENVIRONMENT_NAME;
  else process.env.DEPLOYED_ENVIRONMENT_NAME = originalDeployedEnvironmentName;
});

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
  if (environment === undefined) delete process.env.DEPLOYED_ENVIRONMENT_NAME;
  else process.env.DEPLOYED_ENVIRONMENT_NAME = environment;
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

test('missing or malformed environment never receives the local development principal', async () => {
  for (const environment of [undefined, '', 'LOCAL', 'production']) {
    const result = await withDeployedEnvironment(environment, async () =>
      authorizeRequest(
        requestWithAuthorization(undefined),
        context(),
        { ...baseConfig, enabled: false },
        await verifierReturning({}),
      ),
    );

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 401);
    assert.equal(result.response.jsonBody.error.message, 'Authentication is not configured.');
  }
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
    scp: 'catalogue.read',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.user, {
    subject: 'allowed-sub',
    objectId: undefined,
    tenantId: undefined,
    clientId: 'allowed-delegated-client-id',
    tokenType: 'user',
    scopes: ['catalogue.read'],
    roles: [],
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

test('explicit user token can never enter the service authorization path', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'user-shaped-subject',
    oid: 'allowed-app-oid',
    idtyp: 'user',
    azp: 'allowed-client-id',
    azpacr: '2',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'User is not allowed.');
});

test('ambiguous or unknown idtyp values are rejected', async () => {
  for (const idtyp of ['app+user', 'service']) {
    const result = await authorize('Bearer valid-token', {
      sub: 'user-shaped-subject',
      oid: 'allowed-app-oid',
      idtyp,
      azp: 'allowed-client-id',
      azpacr: '2',
      roles: ['catalogue.read'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.response.status, 403);
    assert.equal(result.response.jsonBody.error.message, 'Token claim shape is not supported.');
  }
});

test('delegated user permissions come only from scp and never from app roles', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'user-subject',
      oid: 'allowed-oid',
      idtyp: 'user',
      azp: 'allowed-delegated-client-id',
      azpacr: '2',
      scp: 'bring.read',
      roles: ['bring.write'],
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

test('contradictory app and delegated permission claims are rejected', async () => {
  const result = await authorize('Bearer valid-token', {
    sub: 'service-subject',
    oid: 'allowed-app-oid',
    idtyp: 'app',
    azp: 'allowed-client-id',
    scp: 'catalogue.read',
    roles: ['catalogue.read'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'Token claim shape is not supported.');
});

test('roles-only compatibility accepts only confidential-client markers for an allowlisted app object', async () => {
  const invalidMarkers = [
    { azpacr: '0' },
    { azpacr: '' },
    { azpacr: '3' },
    { azpacr: 2 },
    { azpacr: '1', appidacr: '2' },
  ];

  for (const markerClaims of invalidMarkers) {
    const result = await authorize('Bearer valid-token', {
      sub: 'service-subject',
      oid: 'allowed-app-oid',
      azp: 'service-client-id',
      roles: ['catalogue.read'],
      ...markerClaims,
    });
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 403);
  }

  for (const markerClaims of [{ azpacr: '1' }, { azpacr: '2' }, { appidacr: '1' }, { appidacr: '2' }]) {
    const result = await authorize('Bearer valid-token', {
      sub: 'service-subject',
      oid: 'allowed-app-oid',
      appid: 'service-client-id',
      roles: ['catalogue.read'],
      ...markerClaims,
    });
    assert.equal(result.ok, true);
    assert.equal(result.user.tokenType, 'service');
  }
});

test('conflicting client identifiers and malformed identity claims are rejected', async () => {
  for (const payload of [
    {
      sub: 'allowed-sub',
      oid: 'allowed-oid',
      azp: 'allowed-delegated-client-id',
      appid: 'different-client-id',
      scp: 'catalogue.read',
    },
    {
      sub: 'allowed-sub',
      oid: '',
      azp: 'allowed-delegated-client-id',
      scp: 'catalogue.read',
    },
    {
      sub: 'allowed-sub',
      oid: 42,
      azp: 'allowed-delegated-client-id',
      scp: 'catalogue.read',
    },
    {
      sub: 'allowed-sub',
      oid: 'allowed-oid',
      idtyp: 'unexpected',
      azp: 'allowed-delegated-client-id',
      scp: 'catalogue.read',
    },
  ]) {
    const result = await authorize('Bearer valid-token', payload);
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 403);
    assert.equal(result.response.jsonBody.error.message, 'Token claim shape is not supported.');
  }
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

test('roles-only token without idtyp cannot use a service client ID alone to bypass the user allowlist', async () => {
  const result = await authorize(
    'Bearer valid-token',
    {
      sub: 'service-subject',
      oid: 'blocked-user-oid',
      tid: 'tenant-id',
      azp: 'allowed-client-id',
      azpacr: '2',
      roles: ['catalogue.read'],
    },
    { allowedAppObjectIds: [] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.jsonBody.error.message, 'User is not allowed.');
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

test('non-local authentication requires a non-empty tenant allowlist at the request boundary', async () => {
  const result = await withDeployedEnvironment('test', async () =>
    authorizeRequest(
      requestWithAuthorization('Bearer valid-token'),
      context(),
      { ...baseConfig, allowedTenants: [] },
      await verifierReturning({
        sub: 'user-subject',
        oid: 'allowed-oid',
        tid: 'tenant-id',
        azp: 'allowed-delegated-client-id',
        scp: 'catalogue.read',
      }),
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  assert.equal(result.response.jsonBody.error.message, 'Authentication is not configured.');
});

test('non-local authentication requires an exact tenant claim', async () => {
  await withDeployedEnvironment('test', async () => {
    for (const tenantClaims of [{}, { tid: 'wrong-tenant' }]) {
      const result = await authorize(
        'Bearer valid-token',
        {
          sub: 'user-subject',
          oid: 'allowed-oid',
          azp: 'allowed-delegated-client-id',
          scp: 'catalogue.read',
          ...tenantClaims,
        },
        { allowedTenants: ['expected-tenant'] },
      );
      assert.equal(result.ok, false);
      assert.equal(result.response.status, 403);
      assert.equal(result.response.jsonBody.error.message, 'Tenant is not allowed.');
    }

    const allowed = await authorize(
      'Bearer valid-token',
      {
        sub: 'user-subject',
        oid: 'allowed-oid',
        tid: 'expected-tenant',
        azp: 'allowed-delegated-client-id',
        scp: 'catalogue.read',
      },
      { allowedTenants: ['expected-tenant'] },
    );
    assert.equal(allowed.ok, true);
  });
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
    return Response.json({
      issuer: 'https://recoverable-issuer.example.test',
      jwks_uri: 'https://recoverable-issuer.example.test/jwks',
    });
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
        new Response(
          JSON.stringify({
            issuer: 'https://issuer-with-insecure-jwks.example.test',
            jwks_uri: 'http://keys.example.test/jwks',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      { maxAttempts: 1 },
    ),
    /jwks_uri URL is unsupported/,
  );
  clearOidcCachesForTesting();
});

test('OIDC discovery binds metadata issuer and JWKS origin and rejects malformed metadata URLs', async () => {
  const issuer = 'https://issuer.example.test';
  const rejectedMetadata = [
    {
      metadata: { issuer: 'https://other-issuer.example.test', jwks_uri: `${issuer}/jwks` },
      message: /issuer does not match/,
    },
    {
      metadata: { issuer, jwks_uri: 'https://keys.example.test/jwks' },
      message: /cross-origin jwks_uri/,
    },
    {
      metadata: { issuer, jwks_uri: 'https://user:password@issuer.example.test/jwks' },
      message: /jwks_uri URL is unsupported/,
    },
    {
      metadata: { issuer, jwks_uri: `${issuer}/jwks?tenant=other` },
      message: /jwks_uri URL is unsupported/,
    },
    {
      metadata: { issuer, userinfo_endpoint: `${issuer}/userinfo` },
      message: /did not return jwks_uri/,
    },
  ];

  for (const { metadata, message } of rejectedMetadata) {
    clearOidcCachesForTesting();
    await assert.rejects(
      discoverJwksUri(issuer, async () => Response.json(metadata), { maxAttempts: 1 }),
      message,
    );
  }
  clearOidcCachesForTesting();
});

test('OIDC discovery rejects redirects and respects its bounded timeout', async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect/.well-known/openid-configuration') {
      response.writeHead(302, { location: '/redirected-metadata' });
      response.end();
      return;
    }
    if (request.url === '/redirected-metadata') {
      redirectedRequests += 1;
      response.end('{}');
      return;
    }
    if (request.url === '/timeout/.well-known/openid-configuration') {
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    clearOidcCachesForTesting();
    await assert.rejects(discoverJwksUri(`${baseUrl}/redirect`, fetch, { maxAttempts: 1 }));
    assert.equal(redirectedRequests, 0);

    clearOidcCachesForTesting();
    await assert.rejects(
      discoverJwksUri(`${baseUrl}/timeout`, fetch, { maxAttempts: 1, timeoutMs: 10 }),
      /timeout|aborted/i,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    clearOidcCachesForTesting();
  }
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
      response.end(JSON.stringify({ issuer: `${baseUrl}/issuer-a`, jwks_uri: `${baseUrl}/issuer-a/jwks` }));
      return;
    }
    if (request.url === '/issuer-b/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer: `${baseUrl}/issuer-b`, jwks_uri: `${baseUrl}/issuer-b/jwks` }));
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

test('explicit operator-configured JWKS preserves issuer, audience, and bounded token-time validation', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'claim-matrix-key';
  const issuer = 'https://configured-issuer.example.test';
  const audience = 'api://catalogue-test';
  const server = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = {
      ...baseConfig,
      issuer,
      issuers: [issuer],
      audience,
      jwksUri: `http://127.0.0.1:${server.address().port}/jwks`,
    };
    const sign = async ({ tokenIssuer = issuer, tokenAudience = audience, expiration = '5m', notBefore } = {}) => {
      let builder = new SignJWT({ scp: 'catalogue.read' })
        .setProtectedHeader({ alg: 'RS256', kid: 'claim-matrix-key' })
        .setIssuer(tokenIssuer)
        .setAudience(tokenAudience)
        .setSubject('allowed-sub');
      if (expiration !== null) builder = builder.setExpirationTime(expiration);
      if (notBefore !== undefined) builder = builder.setNotBefore(notBefore);
      return builder.sign(privateKey);
    };

    assert.equal((await verifyJwtWithJose(await sign(), config)).sub, 'allowed-sub');
    for (const token of [
      await sign({ tokenIssuer: 'https://wrong-issuer.example.test' }),
      await sign({ tokenAudience: 'api://wrong-audience' }),
      await sign({ expiration: Math.floor(Date.now() / 1000) - 1 }),
      await sign({ notBefore: '5m' }),
      await sign({ expiration: null }),
    ]) {
      await assert.rejects(verifyJwtWithJose(token, config));
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    clearOidcCachesForTesting();
  }
});

test('remote JWKS cache refreshes an unknown key after provider key rotation', async () => {
  const oldKeys = await generateKeyPair('RS256');
  const newKeys = await generateKeyPair('RS256');
  const oldJwk = await exportJWK(oldKeys.publicKey);
  const newJwk = await exportJWK(newKeys.publicKey);
  oldJwk.kid = 'old-key';
  newJwk.kid = 'new-key';
  let activeJwk = oldJwk;
  let jwksRequests = 0;

  const server = createServer((request, response) => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/issuer/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer: `${baseUrl}/issuer`, jwks_uri: `${baseUrl}/issuer/jwks` }));
      return;
    }
    if (request.url === '/issuer/jwks') {
      jwksRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [activeJwk] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const realDateNow = Date.now;
  try {
    clearOidcCachesForTesting();
    const issuer = `http://127.0.0.1:${server.address().port}/issuer`;
    const config = { ...baseConfig, issuer, issuers: [issuer], audience: 'api://catalogue-test' };
    const sign = (privateKey, kid) =>
      new SignJWT({ scp: 'catalogue.read' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(issuer)
        .setAudience('api://catalogue-test')
        .setSubject('allowed-sub')
        .setExpirationTime('5m')
        .sign(privateKey);

    assert.equal((await verifyJwtWithJose(await sign(oldKeys.privateKey, 'old-key'), config)).sub, 'allowed-sub');
    activeJwk = newJwk;
    Date.now = () => realDateNow() + 31_000;
    assert.equal((await verifyJwtWithJose(await sign(newKeys.privateKey, 'new-key'), config)).sub, 'allowed-sub');
    assert.ok(jwksRequests >= 2);
  } finally {
    Date.now = realDateNow;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    clearOidcCachesForTesting();
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
      response.end(
        JSON.stringify({
          issuer: `${baseUrl}/${entraTenantId}/v2.0`,
          jwks_uri: `${baseUrl}/${entraTenantId}/v2.0/jwks`,
        }),
      );
      return;
    }
    if (request.url === `/${entraTenantId}/.well-known/openid-configuration`) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ issuer: `${baseUrl}/${entraTenantId}/`, jwks_uri: `${baseUrl}/${entraTenantId}/jwks` }),
      );
      return;
    }
    if (request.url === `/${entraTenantId}/v2.0/jwks`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [issuerJwk] }));
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
