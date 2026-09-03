#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const requiredManagedSettingNames = [
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'AzureWebJobsStorage__blobServiceUri',
  'AzureWebJobsStorage__queueServiceUri',
  'AzureWebJobsStorage__tableServiceUri',
  'AzureWebJobsStorage__credential',
  'FUNCTIONS_EXTENSION_VERSION',
  'FUNCTIONS_WORKER_RUNTIME',
  'DEPLOYED_ENVIRONMENT_NAME',
  'AUTH_ENABLED',
  'OIDC_ISSUER',
  'OIDC_AUDIENCE',
  'OIDC_JWKS_URI',
  'OIDC_REQUIRED_SCOPES',
  'OIDC_ALLOWED_OBJECT_IDS',
  'OIDC_ALLOWED_SUBJECTS',
  'OIDC_ALLOWED_APP_OBJECT_IDS',
  'OIDC_ALLOWED_CLIENT_IDS',
  'OIDC_ALLOWED_DELEGATED_CLIENT_IDS',
  'OIDC_ALLOWED_TENANTS',
  'AUTH_DEBUG',
  'API_CORS_ALLOWED_ORIGINS',
  'MCP_RESOURCE_ORIGIN',
  'MCP_ALLOWED_ORIGINS',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
  'REDDIT_STORAGE_ACCOUNT_NAME',
  'REDDIT_SNAPSHOT_CONTAINER',
  'REDDIT_SNAPSHOT_TTL_SECONDS',
  'REDDIT_SNAPSHOT_MAX_COMMENTS',
  'REDDIT_SNAPSHOT_MAX_BYTES',
  'WLH_BASE_URL',
  'WLH_STORAGE_ACCOUNT_NAME',
  'WLH_CATEGORY_BLOB_CONTAINER',
  'WLH_CATEGORY_BLOB_NAME',
  'WEATHER_ENABLED',
  'GOOGLE_WEATHER_API_KEY',
  'BRING_ENABLED',
  'BRING_ADD_ENABLED',
  'BRING_DESTRUCTIVE_ENABLED',
  'BRING_BASE_URL',
  'BRING_CLIENT_API_KEY',
  'BRING_COUNTRY',
  'BRING_EMAIL',
  'BRING_PASSWORD',
  'BRING_EXPECTED_ACCOUNT_FINGERPRINT',
  'BRING_DEFAULT_LIST_UUID',
  'BRING_READABLE_LIST_UUIDS',
  'BRING_WRITABLE_LIST_UUIDS',
  'BRING_WRITABLE_SHARED_LIST_UUIDS',
  'BRING_SESSION_CACHE_ENABLED',
  'BRING_SESSION_CACHE_CONTAINER',
  'BRING_SESSION_CACHE_BLOB',
  'BRING_MUTATION_CONTAINER',
  'BRING_AUDIT_CONTAINER',
  'BRING_STORAGE_ACCOUNT_NAME',
  'BRING_CONFIRMATION_HMAC_KEY',
  'BRING_MUTATION_ENCRYPTION_KEY',
  'OPENAI_API_KEY',
  'REPAIRABLE_ERRORS_LLM_ENABLED',
  'REPAIRABLE_ERRORS_LLM_MODEL',
];

export const optionalReleaseSettingNames = [
  'WEBSITE_RUN_FROM_PACKAGE',
  'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID',
  'DEPLOYED_COMMIT_SHA',
  'DEPLOYED_SOURCE_REF',
  'DEPLOYMENT_RUN_ID',
  'DEPLOYED_AT_UTC',
  'BUILD_TIMESTAMP_UTC',
  'RELEASE_FUNCTION_SHA256',
  'RELEASE_FRONTEND_SHA256',
  'RELEASE_SBOM_SHA256',
];

function value(env, name, fallback = '') {
  const configured = String(env[name] ?? '').trim();
  return configured || fallback;
}

function requiredValue(env, name) {
  const configured = value(env, name);
  if (!configured) throw new Error(`${name} is required before runtime settings can be accepted.`);
  return configured;
}

function exactOrigin(raw, name) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('protocol');
    return parsed.origin;
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL before runtime settings can be accepted.`);
  }
}

export function buildExpectedRuntimeSettings(env = process.env) {
  const environmentName = value(env, 'ENVIRONMENT_NAME');
  if (!['test', 'prod'].includes(environmentName)) throw new Error('ENVIRONMENT_NAME must be test or prod.');
  const hostStorage = value(env, 'EFFECTIVE_HOST_STORAGE_ACCOUNT');
  const privateStorage = value(env, 'EFFECTIVE_PRIVATE_STORAGE_ACCOUNT');
  if (!hostStorage || !privateStorage) throw new Error('Resolved host and private storage account names are required.');
  const redirectName = environmentName === 'prod' ? 'WEB_AUTH_REDIRECT_URI' : 'TEST_WEB_AUTH_REDIRECT_URI';
  const corsOrigin = exactOrigin(value(env, redirectName), redirectName);
  const openAiReference =
    value(env, 'REPAIRABLE_ERRORS_LLM_ENABLED', 'false') === 'true'
      ? requiredValue(env, 'EXPECTED_OPENAI_API_KEY_REFERENCE')
      : '';

  return {
    APPLICATIONINSIGHTS_CONNECTION_STRING: requiredValue(env, 'EXPECTED_APPLICATIONINSIGHTS_CONNECTION_STRING'),
    AzureWebJobsStorage__blobServiceUri: `https://${hostStorage}.blob.core.windows.net`,
    AzureWebJobsStorage__queueServiceUri: `https://${hostStorage}.queue.core.windows.net`,
    AzureWebJobsStorage__tableServiceUri: `https://${hostStorage}.table.core.windows.net`,
    AzureWebJobsStorage__credential: 'managedidentity',
    FUNCTIONS_EXTENSION_VERSION: '~4',
    FUNCTIONS_WORKER_RUNTIME: 'node',
    DEPLOYED_ENVIRONMENT_NAME: environmentName,
    AUTH_ENABLED: 'true',
    OIDC_ISSUER: value(env, 'OIDC_ISSUER'),
    OIDC_AUDIENCE: value(env, 'OIDC_AUDIENCE'),
    OIDC_JWKS_URI: value(env, 'OIDC_JWKS_URI'),
    OIDC_REQUIRED_SCOPES: value(
      env,
      'OIDC_REQUIRED_SCOPES',
      'catalogue.read,reddit.read,wlh.read,weather.read,bring.read,bring.write,bring.complete,bring.remove',
    ),
    OIDC_ALLOWED_OBJECT_IDS: value(env, 'OIDC_ALLOWED_OBJECT_IDS'),
    OIDC_ALLOWED_SUBJECTS: value(env, 'OIDC_ALLOWED_SUBJECTS'),
    OIDC_ALLOWED_APP_OBJECT_IDS: value(env, 'OIDC_ALLOWED_APP_OBJECT_IDS'),
    OIDC_ALLOWED_CLIENT_IDS: value(env, 'OIDC_ALLOWED_CLIENT_IDS'),
    OIDC_ALLOWED_DELEGATED_CLIENT_IDS: requiredValue(env, 'OIDC_ALLOWED_DELEGATED_CLIENT_IDS'),
    OIDC_ALLOWED_TENANTS: value(env, 'OIDC_ALLOWED_TENANTS'),
    AUTH_DEBUG: value(env, 'AUTH_DEBUG', 'false'),
    API_CORS_ALLOWED_ORIGINS: corsOrigin,
    MCP_RESOURCE_ORIGIN: value(env, 'MCP_RESOURCE_ORIGIN'),
    MCP_ALLOWED_ORIGINS: value(env, 'MCP_ALLOWED_ORIGINS'),
    REDDIT_CLIENT_ID: value(env, 'REDDIT_CLIENT_ID'),
    REDDIT_CLIENT_SECRET: requiredValue(env, 'EXPECTED_REDDIT_CLIENT_SECRET_REFERENCE'),
    REDDIT_USER_AGENT: value(env, 'REDDIT_USER_AGENT'),
    REDDIT_STORAGE_ACCOUNT_NAME: privateStorage,
    REDDIT_SNAPSHOT_CONTAINER: value(env, 'REDDIT_SNAPSHOT_CONTAINER', 'reddit-snapshots'),
    REDDIT_SNAPSHOT_TTL_SECONDS: value(env, 'REDDIT_SNAPSHOT_TTL_SECONDS', '86400'),
    REDDIT_SNAPSHOT_MAX_COMMENTS: value(env, 'REDDIT_SNAPSHOT_MAX_COMMENTS', '100000'),
    REDDIT_SNAPSHOT_MAX_BYTES: value(env, 'REDDIT_SNAPSHOT_MAX_BYTES', '100663296'),
    WLH_BASE_URL: requiredValue(env, 'EXPECTED_WLH_BASE_URL_REFERENCE'),
    WLH_STORAGE_ACCOUNT_NAME: privateStorage,
    WLH_CATEGORY_BLOB_CONTAINER: value(env, 'WLH_CATEGORY_BLOB_CONTAINER', 'wlh-reference'),
    WLH_CATEGORY_BLOB_NAME: value(env, 'WLH_CATEGORY_BLOB_NAME', 'categories-marketplace.v1.json.gz'),
    WEATHER_ENABLED: value(env, 'WEATHER_ENABLED', 'false'),
    GOOGLE_WEATHER_API_KEY:
      value(env, 'WEATHER_ENABLED', 'false') === 'true'
        ? requiredValue(env, 'EXPECTED_GOOGLE_WEATHER_API_KEY_REFERENCE')
        : '',
    BRING_ENABLED: value(env, 'BRING_ENABLED', 'false'),
    BRING_ADD_ENABLED: value(env, 'BRING_ADD_ENABLED', 'false'),
    BRING_DESTRUCTIVE_ENABLED: value(env, 'BRING_DESTRUCTIVE_ENABLED', 'false'),
    BRING_BASE_URL: value(env, 'BRING_BASE_URL', 'https://api.getbring.com/rest/'),
    BRING_CLIENT_API_KEY: requiredValue(env, 'EXPECTED_BRING_CLIENT_API_KEY_REFERENCE'),
    BRING_COUNTRY: value(env, 'BRING_COUNTRY', 'AT'),
    BRING_EMAIL: requiredValue(env, 'EXPECTED_BRING_EMAIL_REFERENCE'),
    BRING_PASSWORD: requiredValue(env, 'EXPECTED_BRING_PASSWORD_REFERENCE'),
    BRING_EXPECTED_ACCOUNT_FINGERPRINT: value(env, 'BRING_EXPECTED_ACCOUNT_FINGERPRINT'),
    BRING_DEFAULT_LIST_UUID: value(env, 'BRING_DEFAULT_LIST_UUID'),
    BRING_READABLE_LIST_UUIDS: value(env, 'BRING_READABLE_LIST_UUIDS'),
    BRING_WRITABLE_LIST_UUIDS: value(env, 'BRING_WRITABLE_LIST_UUIDS'),
    BRING_WRITABLE_SHARED_LIST_UUIDS: value(env, 'BRING_WRITABLE_SHARED_LIST_UUIDS'),
    BRING_SESSION_CACHE_ENABLED: value(env, 'BRING_SESSION_CACHE_ENABLED', 'true'),
    BRING_SESSION_CACHE_CONTAINER: value(env, 'BRING_SESSION_CACHE_CONTAINER', 'bring-private'),
    BRING_SESSION_CACHE_BLOB: value(env, 'BRING_SESSION_CACHE_BLOB', 'session-v1.json'),
    BRING_MUTATION_CONTAINER: value(env, 'BRING_MUTATION_CONTAINER', 'bring-mutations'),
    BRING_AUDIT_CONTAINER: value(env, 'BRING_AUDIT_CONTAINER', 'bring-audit'),
    BRING_STORAGE_ACCOUNT_NAME: privateStorage,
    BRING_CONFIRMATION_HMAC_KEY: requiredValue(env, 'EXPECTED_BRING_CONFIRMATION_HMAC_KEY_REFERENCE'),
    BRING_MUTATION_ENCRYPTION_KEY: requiredValue(env, 'EXPECTED_BRING_MUTATION_ENCRYPTION_KEY_REFERENCE'),
    OPENAI_API_KEY: openAiReference,
    REPAIRABLE_ERRORS_LLM_ENABLED: value(env, 'REPAIRABLE_ERRORS_LLM_ENABLED', 'false'),
    REPAIRABLE_ERRORS_LLM_MODEL: value(env, 'REPAIRABLE_ERRORS_LLM_MODEL'),
  };
}

export function validateDeployedRuntimeSettings(settings, settingNames, env = process.env) {
  const errors = [];
  const expected = buildExpectedRuntimeSettings(env);
  const names = Array.isArray(settingNames) ? settingNames : [];
  const nameSet = new Set(names);
  const allowedNames = new Set([...requiredManagedSettingNames, ...optionalReleaseSettingNames]);

  for (const name of requiredManagedSettingNames) {
    if (!nameSet.has(name)) errors.push(`required managed setting is missing: ${name}`);
  }
  for (const name of names) {
    if (!allowedNames.has(name)) errors.push(`unmanaged app setting is present: ${name}`);
  }
  if (nameSet.size !== names.length) errors.push('app setting names contain duplicates');

  for (const [name, expectedValue] of Object.entries(expected)) {
    if (settings?.[name] !== expectedValue) errors.push(`runtime safety setting does not match policy: ${name}`);
  }
  const actualValueNames = Object.keys(settings ?? {});
  for (const name of actualValueNames) {
    if (!(name in expected)) errors.push(`unexpected runtime safety value was returned: ${name}`);
  }

  return errors;
}

export function validateArmRuntimeSettingsResponse(response, env = process.env) {
  const properties = response?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return ['Azure app-settings response is missing its properties object'];
  }
  const expectedNames = Object.keys(buildExpectedRuntimeSettings(env));
  const policySettings = Object.fromEntries(expectedNames.map((name) => [name, properties[name]]));
  return validateDeployedRuntimeSettings(policySettings, Object.keys(properties), env);
}

async function readStandardInput() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--arm-response') {
    console.error(
      'Usage: az rest ... --output json | node scripts/validate-deployed-runtime-settings.mjs --arm-response',
    );
    process.exit(2);
  }
  const response = JSON.parse(await readStandardInput());
  const errors = validateArmRuntimeSettingsResponse(response);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('Effective runtime policy settings and managed key set match policy.');
}
