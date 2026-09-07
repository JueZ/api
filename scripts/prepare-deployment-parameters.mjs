#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const WORKFLOW_REQUIRED_SCOPES =
  'catalogue.read,reddit.read,youtube.read,wlh.read,weather.read,bring.read,bring.write,bring.complete,bring.remove';

const PRIVATE_BINDINGS = Object.freeze({
  redditOAuthSecret: 'REDDIT_CLIENT_SECRET',
  supadataApiKey: 'SUPADATA_API_KEY',
  youtubeTranscriptCursorHmacKey: 'YOUTUBE_TRANSCRIPT_CURSOR_HMAC_KEY',
  wlhBaseUrl: 'WLH_BASE_URL',
  googleWeatherApiKey: 'GOOGLE_WEATHER_API_KEY',
  bringClientApiKey: 'BRING_CLIENT_API_KEY',
  bringEmail: 'BRING_EMAIL',
  bringPassword: 'BRING_PASSWORD',
  bringConfirmationHmacKey: 'BRING_CONFIRMATION_HMAC_KEY',
  bringMutationEncryptionKey: 'BRING_MUTATION_ENCRYPTION_KEY',
  openAiCredential: 'OPENAI_API_KEY',
});

function environmentString(environment, name, fallback = '') {
  const value = environment[name];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function environmentBoolean(environment, name, fallback) {
  const value = environment[name];
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be an exact boolean.`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePrivateConfig(configJSON) {
  let config = configJSON;
  if (typeof configJSON === 'string') {
    try {
      config = JSON.parse(configJSON);
    } catch {
      throw new Error('Private deployment configuration is not valid JSON.');
    }
  }
  if (!isObject(config)) throw new Error('Private deployment configuration must be an object.');
  const keys = Object.keys(config).sort();
  if (keys.length !== 2 || keys[0] !== 'budgetStartDate' || keys[1] !== 'releaseRetentionPolicy') {
    throw new Error('Private deployment configuration has an unsupported shape.');
  }
  if (typeof config.budgetStartDate !== 'string' || !isObject(config.releaseRetentionPolicy)) {
    throw new Error('Resolved budget and release-retention inputs are invalid.');
  }
  return config;
}

function privateValue(environment, parameterName) {
  return environmentString(environment, PRIVATE_BINDINGS[parameterName]);
}

function corsOrigin(environment, environmentName) {
  const redirectName = environmentName === 'prod' ? 'WEB_AUTH_REDIRECT_URI' : 'TEST_WEB_AUTH_REDIRECT_URI';
  const redirect = environmentString(environment, redirectName);
  if (!redirect) return '';
  try {
    return new URL(redirect).origin;
  } catch {
    throw new Error('The environment-specific web authentication redirect URI is invalid.');
  }
}

function isLiteralDefault(value) {
  if (typeof value === 'string') return !value.startsWith('[');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return true;
  if (Array.isArray(value)) return value.every(isLiteralDefault);
  return isObject(value) && Object.values(value).every(isLiteralDefault);
}

function completeParameterValues(workflowValues, compiledTemplate) {
  if (!isObject(compiledTemplate?.parameters)) {
    throw new Error('Compiled deployment template parameters are unavailable.');
  }
  const definitions = compiledTemplate.parameters;
  if (Object.keys(workflowValues).some((name) => !Object.hasOwn(definitions, name))) {
    throw new Error('Workflow deployment parameters do not match the compiled template.');
  }

  const completed = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (!isObject(definition)) throw new Error('Compiled deployment template parameter metadata is invalid.');
    if (Object.hasOwn(workflowValues, name)) {
      completed[name] = workflowValues[name];
    } else if (Object.hasOwn(definition, 'defaultValue') && isLiteralDefault(definition.defaultValue)) {
      completed[name] = structuredClone(definition.defaultValue);
    } else {
      throw new Error('A compiled deployment parameter has no effective workflow value.');
    }
  }
  return completed;
}

/**
 * Materialize the effective parameter values used by deploy-environment.yml.
 * The returned parameter map is private because it contains raw deployment secrets.
 */
export function buildDeploymentParameters(environment, configJSON, compiledTemplate) {
  const env = environment ?? {};
  const config = parsePrivateConfig(configJSON);
  const environmentName = environmentString(env, 'ENVIRONMENT_NAME');
  const repairableErrorsLlmEnabled = environmentBoolean(env, 'REPAIRABLE_ERRORS_LLM_ENABLED', false);
  const privateInputs = Object.fromEntries(
    Object.keys(PRIVATE_BINDINGS).map((parameterName) => [parameterName, privateValue(env, parameterName)]),
  );
  if (!repairableErrorsLlmEnabled) privateInputs.openAiCredential = '';

  const workflowValues = {
    environmentName,
    authEnabled: environmentBoolean(env, 'AUTH_ENABLED'),
    oidcIssuer: environmentString(env, 'OIDC_ISSUER'),
    oidcAudience: environmentString(env, 'OIDC_AUDIENCE'),
    oidcJwksUri: environmentString(env, 'OIDC_JWKS_URI'),
    oidcRequiredScopes: environmentString(env, 'OIDC_REQUIRED_SCOPES', WORKFLOW_REQUIRED_SCOPES),
    oidcAllowedObjectIds: environmentString(env, 'OIDC_ALLOWED_OBJECT_IDS'),
    oidcAllowedSubjects: environmentString(env, 'OIDC_ALLOWED_SUBJECTS'),
    oidcAllowedAppObjectIds: environmentString(env, 'OIDC_ALLOWED_APP_OBJECT_IDS'),
    oidcAllowedClientIds: environmentString(env, 'OIDC_ALLOWED_CLIENT_IDS'),
    oidcAllowedDelegatedClientIds: environmentString(env, 'OIDC_ALLOWED_DELEGATED_CLIENT_IDS'),
    oidcAllowedTenants: environmentString(env, 'OIDC_ALLOWED_TENANTS'),
    authDebug: environmentBoolean(env, 'AUTH_DEBUG', false),
    apiCorsAllowedOrigins: corsOrigin(env, environmentName),
    mcpResourceOrigin: environmentString(env, 'MCP_RESOURCE_ORIGIN'),
    mcpAllowedOrigins: environmentString(env, 'MCP_ALLOWED_ORIGINS'),
    deploymentPrincipalObjectId: environmentString(env, 'AZURE_DEPLOYMENT_PRINCIPAL_OBJECT_ID'),
    releaseRetentionPolicy: config.releaseRetentionPolicy,
    operatorAlertEmail: environmentString(env, 'OPERATOR_ALERT_EMAIL'),
    monthlyBudgetEur: environmentName === 'prod' ? 15 : 10,
    budgetStartDate: config.budgetStartDate,
    redditClientId: environmentString(env, 'REDDIT_CLIENT_ID'),
    redditUserAgent: environmentString(env, 'REDDIT_USER_AGENT'),
    youtubeTranscriptEnabled: environmentBoolean(env, 'YOUTUBE_TRANSCRIPT_ENABLED', false),
    weatherEnabled: environmentBoolean(env, 'WEATHER_ENABLED', true),
    bringEnabled: environmentBoolean(env, 'BRING_ENABLED'),
    bringAddEnabled: environmentBoolean(env, 'BRING_ADD_ENABLED'),
    bringDestructiveEnabled: environmentBoolean(env, 'BRING_DESTRUCTIVE_ENABLED'),
    bringBaseUrl: environmentString(env, 'BRING_BASE_URL', 'https://api.getbring.com/rest/'),
    bringCountry: environmentString(env, 'BRING_COUNTRY', 'AT'),
    bringExpectedAccountFingerprint: environmentString(env, 'BRING_EXPECTED_ACCOUNT_FINGERPRINT'),
    bringConnectionGrants: environmentString(env, 'BRING_CONNECTION_GRANTS'),
    bringDefaultListUuid: environmentString(env, 'BRING_DEFAULT_LIST_UUID'),
    bringReadableListUuids: environmentString(env, 'BRING_READABLE_LIST_UUIDS'),
    bringWritableListUuids: environmentString(env, 'BRING_WRITABLE_LIST_UUIDS'),
    bringWritableSharedListUuids: environmentString(env, 'BRING_WRITABLE_SHARED_LIST_UUIDS'),
    bringSessionCacheEnabled: environmentBoolean(env, 'BRING_SESSION_CACHE_ENABLED', true),
    bringSessionCacheContainer: environmentString(env, 'BRING_SESSION_CACHE_CONTAINER', 'bring-private'),
    bringSessionCacheBlob: environmentString(env, 'BRING_SESSION_CACHE_BLOB', 'session-v1.json'),
    bringMutationContainer: environmentString(env, 'BRING_MUTATION_CONTAINER', 'bring-mutations'),
    bringAuditContainer: environmentString(env, 'BRING_AUDIT_CONTAINER', 'bring-audit'),
    wlhCategoryBlobContainer: environmentString(env, 'WLH_CATEGORY_BLOB_CONTAINER', 'wlh-reference'),
    wlhCategoryBlobName: environmentString(env, 'WLH_CATEGORY_BLOB_NAME', 'categories-marketplace.v1.json.gz'),
    repairableErrorsLlmEnabled,
    repairableErrorsLlmModel: environmentString(env, 'REPAIRABLE_ERRORS_LLM_MODEL'),
    ...privateInputs,
  };

  const values = completeParameterValues(workflowValues, compiledTemplate);
  return {
    parameters: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
  };
}

function privateRunnerPath(root, candidate) {
  const target = resolve(candidate);
  const path = relative(root, target);
  if (!path || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new Error('Private deployment input must stay under the staging directory.');
  }
  return target;
}

async function readJSON(path, description) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${description} is unavailable.`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'config-json': { type: 'string' },
      output: { type: 'string', default: 'deployment-parameters.json' },
    },
    strict: true,
  });
  if (!values['config-json']) throw new Error('Private deployment configuration path is required.');

  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('Deployment parameter staging directory is unavailable.');
  const root = resolve(runnerTemp);
  if (values.output !== basename(values.output)) {
    throw new Error('Deployment parameter output must be a direct child of the staging directory.');
  }
  const output = resolve(root, values.output);
  if (output === root) {
    throw new Error('Deployment parameter output must be a new file under the staging directory.');
  }

  const configPath = privateRunnerPath(root, values['config-json']);
  const configJSON = await readFile(configPath, 'utf8');
  const compiledTemplate = await readJSON(resolve(root, 'deployment-template.json'), 'Compiled deployment template');
  const result = buildDeploymentParameters(process.env, configJSON, compiledTemplate);
  await writeFile(output, `${JSON.stringify(result.parameters)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ status: 'prepared', parameters: Object.keys(result.parameters).length })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Deployment parameter preparation failed.');
    process.exitCode = 1;
  });
}
