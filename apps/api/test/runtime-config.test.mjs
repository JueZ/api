import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDeployedEnvironmentName,
  RuntimeConfigurationError,
  validateRuntimeSafety,
} from '../dist/shared/config/runtime.js';

const userObjectId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const listUuid = '33333333-3333-4333-8333-333333333333';
const delegatedClientId = '44444444-4444-4444-8444-444444444444';
const canonicalPermissions = 'catalogue.read,reddit.read,wlh.read,bring.read,bring.write,bring.complete,bring.remove';
const validTestEnvironment = {
  DEPLOYED_ENVIRONMENT_NAME: 'test',
  AUTH_ENABLED: 'true',
  OIDC_ISSUER: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  OIDC_AUDIENCE: 'api://catalogue-test',
  OIDC_REQUIRED_SCOPES: canonicalPermissions,
  OIDC_ALLOWED_OBJECT_IDS: userObjectId,
  OIDC_ALLOWED_DELEGATED_CLIENT_IDS: delegatedClientId,
  OIDC_ALLOWED_TENANTS: tenantId,
  API_CORS_ALLOWED_ORIGINS: 'https://web.example.test',
  MCP_RESOURCE_ORIGIN: 'https://mcp.example.test',
  MCP_ALLOWED_ORIGINS: 'https://chatgpt.com',
  BRING_ENABLED: 'false',
  BRING_ADD_ENABLED: 'false',
  BRING_DESTRUCTIVE_ENABLED: 'false',
};

test('deployed runtime safety accepts complete exact test configuration', () => {
  assert.deepEqual(validateRuntimeSafety(validTestEnvironment), []);
});

test('runtime environment classification requires an explicit exact value', () => {
  assert.equal(getDeployedEnvironmentName({ DEPLOYED_ENVIRONMENT_NAME: 'local' }), 'local');
  assert.deepEqual(validateRuntimeSafety({ DEPLOYED_ENVIRONMENT_NAME: 'local' }), []);

  for (const value of [undefined, '', 'LOCAL', ' local ', 'production', 'staging']) {
    const env = value === undefined ? {} : { DEPLOYED_ENVIRONMENT_NAME: value };
    assert.throws(() => getDeployedEnvironmentName(env), RuntimeConfigurationError);
    assert.deepEqual(validateRuntimeSafety(env), ['DEPLOYED_ENVIRONMENT_NAME must be explicitly local, test, or prod']);
  }
});

test('deployed runtime safety accepts Entra GUIDs without RFC UUID version markers', () => {
  assert.deepEqual(
    validateRuntimeSafety({
      ...validTestEnvironment,
      OIDC_ALLOWED_OBJECT_IDS: '00000000-0000-0000-0000-000000000001',
      OIDC_ALLOWED_TENANTS: 'aaaaaaaa-0000-0000-0000-000000000002',
    }),
    [],
  );
});

test('deployed runtime safety rejects incomplete auth and non-canonical origins', () => {
  const problems = validateRuntimeSafety({
    ...validTestEnvironment,
    OIDC_ISSUER: 'http://issuer.example.test',
    OIDC_JWKS_URI: 'http://keys.example.test/jwks',
    OIDC_REQUIRED_SCOPES: 'catalogue.read',
    OIDC_ALLOWED_OBJECT_IDS: 'not-a-uuid',
    OIDC_ALLOWED_DELEGATED_CLIENT_IDS: '',
    OIDC_ALLOWED_TENANTS: '',
    API_CORS_ALLOWED_ORIGINS: 'https://web.example.test/',
    MCP_RESOURCE_ORIGIN: 'https://mcp.example.test/',
    MCP_ALLOWED_ORIGINS: 'https://chatgpt.com/path',
  });
  assert.ok(problems.some((problem) => problem.startsWith('OIDC_ISSUER')));
  assert.ok(problems.some((problem) => problem.startsWith('OIDC_JWKS_URI')));
  assert.ok(problems.some((problem) => problem.startsWith('OIDC_REQUIRED_SCOPES')));
  assert.ok(problems.some((problem) => problem.startsWith('OIDC_ALLOWED_OBJECT_IDS')));
  assert.ok(problems.some((problem) => problem.startsWith('OIDC_ALLOWED_DELEGATED_CLIENT_IDS')));
  assert.ok(problems.some((problem) => problem.startsWith('OIDC_ALLOWED_TENANTS')));
  assert.ok(problems.some((problem) => problem.startsWith('API_CORS_ALLOWED_ORIGINS')));
  assert.ok(problems.some((problem) => problem.startsWith('MCP_RESOURCE_ORIGIN')));
  assert.ok(problems.some((problem) => problem.startsWith('MCP_ALLOWED_ORIGINS')));
});

test('deployed runtime safety rejects local and IP MCP resource origins', () => {
  for (const origin of [
    'https://localhost',
    'https://api.localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://192.0.2.10',
    'https://[2001:db8::10]',
  ]) {
    const problems = validateRuntimeSafety({ ...validTestEnvironment, MCP_RESOURCE_ORIGIN: origin });
    assert.ok(
      problems.some(
        (problem) => problem === 'MCP_RESOURCE_ORIGIN must be a non-localhost, non-IP HTTPS origin in test',
      ),
      origin,
    );
  }
});

test('deployed runtime safety enforces explicit Bring flags, production-only writes, and list containment', () => {
  const unspecified = { ...validTestEnvironment };
  delete unspecified.BRING_ENABLED;
  assert.ok(validateRuntimeSafety(unspecified).some((problem) => problem.startsWith('BRING_ENABLED')));

  const problems = validateRuntimeSafety({
    ...validTestEnvironment,
    DEPLOYED_ENVIRONMENT_NAME: 'prod',
    BRING_ENABLED: 'false',
    BRING_ADD_ENABLED: 'true',
    BRING_READABLE_LIST_UUIDS: listUuid,
    BRING_WRITABLE_LIST_UUIDS: userObjectId,
  });
  assert.ok(problems.includes('Bring write flags require BRING_ENABLED=true'));
  assert.ok(problems.includes('Every writable Bring list must also be readable'));
});
