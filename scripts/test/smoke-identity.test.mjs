import assert from 'node:assert/strict';
import { generateKeyPair, jwtVerify, SignJWT } from 'jose';
import test from 'node:test';
import * as auth from '../../apps/api/dist/shared/security/auth.js';
import { requiredSmokeOperations, selectPreflightEnvironment, verifySmokeIdentity } from '../verify-smoke-identity.mjs';

const keys = await generateKeyPair('RS256');
const env = {
  ENVIRONMENT_NAME: 'prod',
  DEPLOYED_ENVIRONMENT_NAME: 'prod',
  AUTH_ENABLED: 'true',
  OIDC_ISSUER: 'https://issuer.example.test/tenant/v2.0',
  OIDC_AUDIENCE: 'api://catalogue',
  OIDC_REQUIRED_SCOPES: 'catalogue.read',
  OIDC_ALLOWED_TENANTS: 'tenant',
  OIDC_ALLOWED_APP_OBJECT_IDS: 'smoke-object',
  OIDC_ALLOWED_CLIENT_IDS: 'smoke-client',
  WEATHER_SMOKE_ENABLED: 'true',
};
const originalEnvironment = process.env.DEPLOYED_ENVIRONMENT_NAME;
test.before(() => {
  process.env.DEPLOYED_ENVIRONMENT_NAME = 'prod';
});
test.after(() => {
  if (originalEnvironment === undefined) delete process.env.DEPLOYED_ENVIRONMENT_NAME;
  else process.env.DEPLOYED_ENVIRONMENT_NAME = originalEnvironment;
});

// Use real cryptographic verification with a local key instead of fetching JWKS.
// All claim parsing, allowlists and operation policies are the shipped API code.
const localAuth = {
  ...auth,
  authenticateBearerToken(header, context, config) {
    return auth.authenticateBearerToken(
      header,
      context,
      config,
      async (token) =>
        (await jwtVerify(token, keys.publicKey, { issuer: config.issuer, audience: config.audience })).payload,
    );
  },
};

async function token(overrides = {}, privateKey = keys.privateKey) {
  return new SignJWT({
    sub: 'smoke-subject',
    tid: 'tenant',
    oid: 'smoke-object',
    azp: 'smoke-client',
    idtyp: 'app',
    roles: ['catalogue.service.read', 'reddit.service.read', 'weather.service.read'],
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.OIDC_ISSUER)
    .setAudience(env.OIDC_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

test('the smoke principal satisfies real package authorization without any provider operation', async () => {
  const result = await verifySmokeIdentity({ auth: localAuth, env: { ...env, AUTH_ACCESS_TOKEN: await token() } });
  assert.deepEqual(result, {
    status: 'passed',
    evidence: 'package-authorization-preflight',
    operations: ['local.hello', 'reddit.thread', 'weather.forecast'],
  });
  assert.doesNotMatch(JSON.stringify(result), /smoke-object|smoke-client|smoke-subject/);
});

test('a valid token missing the weather role blocks promotion before a provider call', async () => {
  await assert.rejects(
    verifySmokeIdentity({
      auth: localAuth,
      env: { ...env, AUTH_ACCESS_TOKEN: await token({ roles: ['catalogue.service.read', 'reddit.service.read'] }) },
    }),
    /not authorized for weather.forecast/,
  );
});

test('wrong tenant, service-client identity and token signature cannot pass preflight', async () => {
  for (const claims of [{ tid: 'other-tenant' }, { oid: 'other-object', azp: 'other-client' }]) {
    await assert.rejects(
      verifySmokeIdentity({ auth: localAuth, env: { ...env, AUTH_ACCESS_TOKEN: await token(claims) } }),
      /failed token or configured access-policy/,
    );
  }
  const otherKeys = await generateKeyPair('RS256');
  await assert.rejects(
    verifySmokeIdentity({ auth: localAuth, env: { ...env, AUTH_ACCESS_TOKEN: await token({}, otherKeys.privateKey) } }),
    /failed token or configured access-policy/,
  );
});

test('optional smoke coverage is explicit and cannot silently ignore malformed enablement', () => {
  assert.deepEqual(
    requiredSmokeOperations({ WEATHER_SMOKE_ENABLED: 'false', YOUTUBE_TRANSCRIPT_SMOKE_ENABLED: 'true' }),
    ['local.hello', 'reddit.thread', 'youtube.transcript'],
  );
  assert.throws(() => requiredSmokeOperations({ WEATHER_SMOKE_ENABLED: 'enabled' }), /Invalid smoke enablement/);
});

test('package-only recovery uses installed authentication policy when health is unavailable', async () => {
  const intended = { ...env, AUTH_ACCESS_TOKEN: await token() };
  const matchingInstalled = selectPreflightEnvironment(intended, { properties: { ...env } });
  assert.equal((await verifySmokeIdentity({ auth: localAuth, env: matchingInstalled })).status, 'passed');
  for (const difference of [
    { OIDC_ISSUER: 'https://other-issuer.example.test' },
    { OIDC_AUDIENCE: 'api://other' },
    { OIDC_ALLOWED_TENANTS: 'other-tenant' },
    { OIDC_ALLOWED_APP_OBJECT_IDS: '', OIDC_ALLOWED_CLIENT_IDS: '' },
  ]) {
    const installed = selectPreflightEnvironment(intended, { properties: { ...env, ...difference } });
    await assert.rejects(
      verifySmokeIdentity({ auth: localAuth, env: installed }),
      /failed token or configured access-policy/,
    );
  }
  assert.throws(() => selectPreflightEnvironment(env, {}), /Installed runtime settings are unavailable/);
  const missing = selectPreflightEnvironment(env, { properties: {} });
  assert.equal(missing.OIDC_ALLOWED_CLIENT_IDS, '');
});

test('missing target identity, disabled authentication and missing tokens fail closed', async () => {
  for (const overrides of [
    { DEPLOYED_ENVIRONMENT_NAME: 'local' },
    { AUTH_ENABLED: 'false' },
    { AUTH_ACCESS_TOKEN: '' },
  ]) {
    await assert.rejects(
      verifySmokeIdentity({ auth: localAuth, env: { ...env, AUTH_ACCESS_TOKEN: await token(), ...overrides } }),
    );
  }
});
