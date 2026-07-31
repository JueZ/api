#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { fetchWithTimeout, getSmokeFetchTimeoutMs, isTimeoutError } from './lib/smoke-utils.mjs';

const TOKEN_ENDPOINT_HOST = 'https://login.microsoftonline.com';
const DEFAULT_GITHUB_OIDC_AUDIENCE = 'api://AzureADTokenExchange';
const MAX_TOKEN_FETCH_TIMEOUT_MS = 120_000;
const ROLE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ACCESS_TOKEN_LENGTH = 131_072;
const DEFAULT_SCOPE_SUFFIX = '/.default';

export function sanitizeTokenEndpointErrorCode(value) {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9_.-]{1,96}$/.test(normalized) ? normalized : '';
}

export function selectServiceAuthConfig(env = process.env) {
  const environmentName = (env.ENVIRONMENT_NAME || '').trim().toLowerCase();
  const configuredPrefix = (env.SERVICE_AUTH_PREFIX || '').trim().toUpperCase();
  if (configuredPrefix && !/^[A-Z][A-Z0-9_]{0,63}$/.test(configuredPrefix)) {
    throw new Error('SERVICE_AUTH_PREFIX must contain only uppercase letters, numbers, and underscores.');
  }
  const prefix = configuredPrefix || (environmentName === 'prod' ? 'PROD' : 'TEST');

  return {
    environmentName,
    prefix,
    clientId: env[`${prefix}_SERVICE_AUTH_CLIENT_ID`] || '',
    tenantId: env[`${prefix}_SERVICE_AUTH_TENANT_ID`] || '',
    scope: env[`${prefix}_SERVICE_AUTH_SCOPE`] || '',
    requiredRoles: parseRequiredRoles(
      env[`${prefix}_SERVICE_AUTH_REQUIRED_ROLES`] || env.SERVICE_AUTH_REQUIRED_ROLES || '',
    ),
    githubOidcAudience: env.GITHUB_OIDC_AUDIENCE || DEFAULT_GITHUB_OIDC_AUDIENCE,
  };
}

function parseRequiredRoles(value) {
  const roles = String(value)
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  if (roles.some((role) => !ROLE_PATTERN.test(role))) {
    throw new Error('SERVICE_AUTH_REQUIRED_ROLES contains an invalid role name.');
  }
  return roles;
}

export function serviceTokenAudiences(scope) {
  const normalized = typeof scope === 'string' ? scope.trim() : '';
  if (
    normalized !== scope ||
    !normalized.endsWith(DEFAULT_SCOPE_SUFFIX) ||
    normalized.length <= DEFAULT_SCOPE_SUFFIX.length ||
    /\s/.test(normalized)
  ) {
    return [];
  }
  const resource = normalized.slice(0, -DEFAULT_SCOPE_SUFFIX.length);
  let resourceUrl;
  try {
    resourceUrl = new URL(resource);
  } catch {
    return [];
  }
  if (
    !['api:', 'https:'].includes(resourceUrl.protocol) ||
    !resourceUrl.hostname ||
    resourceUrl.username ||
    resourceUrl.password ||
    resourceUrl.search ||
    resourceUrl.hash ||
    resource.includes(',')
  ) {
    return [];
  }
  const audiences = [resource];
  const apiGuid = /^api:\/\/([0-9a-f-]+)$/i.exec(resource)?.[1];
  if (apiGuid && GUID_PATTERN.test(apiGuid)) audiences.push(apiGuid);
  return audiences;
}

export function serviceAuthConfigProblems(config) {
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['invalid_config'];
  if (typeof config.tenantId !== 'string' || !GUID_PATTERN.test(config.tenantId)) problems.push('invalid_tenant_id');
  if (typeof config.clientId !== 'string' || !GUID_PATTERN.test(config.clientId)) problems.push('invalid_client_id');
  if (serviceTokenAudiences(config.scope).length !== 2) problems.push('invalid_scope');
  if (!Array.isArray(config.requiredRoles) || config.requiredRoles.length === 0) {
    problems.push('missing_required_roles');
  } else {
    if (config.requiredRoles.some((role) => typeof role !== 'string' || !ROLE_PATTERN.test(role))) {
      problems.push('invalid_required_roles');
    }
    if (new Set(config.requiredRoles).size !== config.requiredRoles.length) {
      problems.push('duplicate_required_roles');
    }
  }
  return problems;
}

export function decodeAccessTokenClaims(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new Error('Microsoft Entra access token was not a compact JWT.');
  }
  const segments = accessToken.split('.');
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        !JWT_SEGMENT_PATTERN.test(segment) || Buffer.from(segment, 'base64url').toString('base64url') !== segment,
    )
  ) {
    throw new Error('Microsoft Entra access token was not a compact JWT.');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Microsoft Entra access token claims were not valid JSON.');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('Microsoft Entra access token claims were not an object.');
  }
  return claims;
}

export function validateServiceTokenClaims(claims, config) {
  const configProblems = serviceAuthConfigProblems(config);
  if (configProblems.length > 0) return configProblems.map((problem) => `invalid_config:${problem}`);

  const problems = [];
  const version = claims.ver === '1.0' || claims.ver === '2.0' ? claims.ver : '';
  if (!version) problems.push('invalid_token_version');

  const tenantId = typeof claims.tid === 'string' && GUID_PATTERN.test(claims.tid) ? claims.tid : '';
  if (!tenantId) {
    problems.push('missing_or_invalid_tenant');
  } else if (tenantId.toLowerCase() !== config.tenantId.toLowerCase()) {
    problems.push('tenant_mismatch');
  }

  const requiredClientClaim = version === '1.0' ? 'appid' : version === '2.0' ? 'azp' : '';
  if (
    !requiredClientClaim ||
    typeof claims[requiredClientClaim] !== 'string' ||
    !GUID_PATTERN.test(claims[requiredClientClaim])
  ) {
    problems.push('missing_or_invalid_client');
  }
  for (const claimName of ['azp', 'appid']) {
    if (
      Object.hasOwn(claims, claimName) &&
      (typeof claims[claimName] !== 'string' ||
        !GUID_PATTERN.test(claims[claimName]) ||
        claims[claimName].toLowerCase() !== config.clientId.toLowerCase())
    ) {
      problems.push(`${claimName}_mismatch`);
    }
  }
  if (version === '1.0' && Object.hasOwn(claims, 'azp')) problems.push('unexpected_azp');
  if (version === '2.0' && Object.hasOwn(claims, 'appid')) problems.push('unexpected_appid');

  const expectedIssuer =
    version === '1.0'
      ? `https://sts.windows.net/${config.tenantId.toLowerCase()}/`
      : version === '2.0'
        ? `https://login.microsoftonline.com/${config.tenantId.toLowerCase()}/v2.0`
        : '';
  if (claims.iss !== expectedIssuer) {
    problems.push('issuer_mismatch');
  }

  const configuredAudiences = serviceTokenAudiences(config.scope);
  const expectedAudiences = new Set(version === '2.0' ? configuredAudiences.slice(1) : configuredAudiences);
  if (typeof claims.aud !== 'string' || !expectedAudiences.has(claims.aud)) {
    problems.push('audience_mismatch');
  }

  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
    problems.push('missing_subject');
  }
  if (Object.hasOwn(claims, 'scp') && (typeof claims.scp !== 'string' || claims.scp.trim().length > 0)) {
    problems.push('delegated_scope_present');
  }
  if (Object.hasOwn(claims, 'idtyp') && claims.idtyp !== 'app') {
    problems.push('invalid_idtyp');
  }
  for (const markerName of ['azpacr', 'appidacr']) {
    if (Object.hasOwn(claims, markerName) && claims[markerName] !== '1' && claims[markerName] !== '2') {
      problems.push(`invalid_${markerName}`);
    }
  }
  if (version === '1.0' && Object.hasOwn(claims, 'azpacr')) problems.push('unexpected_azpacr');
  if (version === '2.0' && Object.hasOwn(claims, 'appidacr')) problems.push('unexpected_appidacr');
  const confidentialClientMarker = version === '1.0' ? claims.appidacr : version === '2.0' ? claims.azpacr : '';
  if (claims.idtyp !== 'app' && confidentialClientMarker !== '1' && confidentialClientMarker !== '2') {
    problems.push('missing_confidential_client_marker');
  }

  if (
    !Array.isArray(claims.roles) ||
    claims.roles.some((role) => typeof role !== 'string' || !ROLE_PATTERN.test(role))
  ) {
    problems.push('invalid_roles_claim');
  } else {
    const grantedRoles = new Set(claims.roles);
    if (grantedRoles.size !== claims.roles.length) problems.push('duplicate_roles_claim');
    const missingRoles = config.requiredRoles.filter((role) => !grantedRoles.has(role));
    const unexpectedRoles = [...grantedRoles].filter((role) => !config.requiredRoles.includes(role));
    if (missingRoles.length > 0) problems.push(`missing_roles:${missingRoles.join(',')}`);
    if (unexpectedRoles.length > 0) problems.push(`unexpected_roles:${unexpectedRoles.join(',')}`);
  }
  return problems;
}

export function parseSmokeTokenFetchTimeoutMs(env = process.env) {
  const raw = env.SMOKE_TOKEN_FETCH_TIMEOUT_MS;
  if (raw === undefined || raw === '') return getSmokeFetchTimeoutMs(env.SMOKE_FETCH_TIMEOUT_MS);

  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TOKEN_FETCH_TIMEOUT_MS) {
    throw new Error(`SMOKE_TOKEN_FETCH_TIMEOUT_MS must be an integer from 1 to ${MAX_TOKEN_FETCH_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

async function safeReadErrorCode(response) {
  try {
    const errorPayload = await response.json();
    return sanitizeTokenEndpointErrorCode(errorPayload?.error);
  } catch {
    // Ignore non-JSON Entra errors; do not print response bodies because they can include sensitive context.
    return '';
  }
}

export function missingServiceAuthFields(config) {
  const missing = [
    ['clientId', config.clientId],
    ['tenantId', config.tenantId],
    ['scope', config.scope],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (!Array.isArray(config.requiredRoles) || config.requiredRoles.length === 0) missing.push('requiredRoles');
  return missing;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = selectServiceAuthConfig();
  const missing = missingServiceAuthFields(config);
  const requireToken = process.env.REQUIRE_AUTH_SMOKE === 'true' || config.environmentName === 'prod';

  if (missing.length > 0) {
    const message = `${config.prefix}_SERVICE_AUTH_* variables are incomplete: ${missing.join(', ')}`;
    if (requireToken) {
      console.error(message);
      process.exit(2);
    }
    console.log(`Authenticated smoke token mint skipped: ${message}`);
    process.exit(0);
  }

  const configProblems = serviceAuthConfigProblems(config);
  if (configProblems.length > 0) {
    console.error(`${config.prefix}_SERVICE_AUTH_* variables are invalid: ${configProblems.join(', ')}`);
    process.exit(2);
  }

  const githubRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const githubRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubRequestUrl || !githubRequestToken || !githubEnv) {
    const message =
      'GitHub OIDC runtime variables are unavailable. Ensure workflow permissions include id-token: write.';
    if (requireToken) {
      console.error(message);
      process.exit(2);
    }
    console.log(`Authenticated smoke token mint skipped: ${message}`);
    process.exit(0);
  }

  let tokenFetchTimeoutMs;
  try {
    tokenFetchTimeoutMs = parseSmokeTokenFetchTimeoutMs();
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const oidcUrl = new URL(githubRequestUrl);
  oidcUrl.searchParams.set('audience', config.githubOidcAudience);
  let oidcResponse;
  try {
    oidcResponse = await fetchWithTimeout(
      oidcUrl,
      {
        headers: {
          Authorization: `bearer ${githubRequestToken}`,
          Accept: 'application/json',
        },
      },
      tokenFetchTimeoutMs,
    );
  } catch (error) {
    const message = isTimeoutError(error)
      ? `GitHub OIDC token request timed out after ${tokenFetchTimeoutMs}ms.`
      : 'GitHub OIDC token request failed before receiving a response.';
    console.error(message);
    process.exit(2);
  }
  if (!oidcResponse.ok) {
    console.error(`GitHub OIDC token request failed with HTTP ${oidcResponse.status}.`);
    process.exit(2);
  }
  let oidcPayload;
  try {
    oidcPayload = await oidcResponse.json();
  } catch {
    console.error('GitHub OIDC token response was not valid JSON.');
    process.exit(2);
  }
  const clientAssertion = typeof oidcPayload.value === 'string' ? oidcPayload.value : '';
  if (!clientAssertion) {
    console.error('GitHub OIDC token response did not contain a token value.');
    process.exit(2);
  }

  const form = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });
  let tokenResponse;
  try {
    tokenResponse = await fetchWithTimeout(
      `${TOKEN_ENDPOINT_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      },
      tokenFetchTimeoutMs,
    );
  } catch (error) {
    const message = isTimeoutError(error)
      ? `Microsoft Entra token exchange timed out after ${tokenFetchTimeoutMs}ms.`
      : 'Microsoft Entra token exchange failed before receiving a response.';
    console.error(message);
    process.exit(2);
  }
  if (!tokenResponse.ok) {
    const errorCode = await safeReadErrorCode(tokenResponse);
    const errorSummary = errorCode ? ` (${errorCode})` : '';
    console.error(`Microsoft Entra token exchange failed with HTTP ${tokenResponse.status}${errorSummary}.`);
    process.exit(2);
  }
  let tokenPayload;
  try {
    tokenPayload = await tokenResponse.json();
  } catch {
    console.error('Microsoft Entra token response was not valid JSON.');
    process.exit(2);
  }
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : '';
  if (!accessToken) {
    console.error('Microsoft Entra token response did not include an access token.');
    process.exit(2);
  }

  let tokenClaims;
  try {
    tokenClaims = decodeAccessTokenClaims(accessToken);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const claimProblems = validateServiceTokenClaims(tokenClaims, config);
  if (claimProblems.length > 0) {
    const missingRoles = claimProblems.find((problem) => problem.startsWith('missing_roles:'));
    const unexpectedRoles = claimProblems.find((problem) => problem.startsWith('unexpected_roles:'));
    if (claimProblems.length === 1 && missingRoles) {
      console.error(
        `Microsoft Entra service token is missing required application roles: ${missingRoles.slice('missing_roles:'.length)}.`,
      );
    } else if (claimProblems.length === 1 && unexpectedRoles) {
      console.error(
        `Microsoft Entra service token has unexpected application roles: ${unexpectedRoles.slice('unexpected_roles:'.length)}.`,
      );
    } else {
      console.error('Microsoft Entra service token does not match the exact configured smoke identity and role set.');
    }
    process.exit(2);
  }

  console.log(`::add-mask::${accessToken}`);
  await appendFile(githubEnv, `AUTH_ACCESS_TOKEN<<__SMOKE_TOKEN__\n${accessToken}\n__SMOKE_TOKEN__\n`);
  console.log(`Minted short-lived ${config.prefix.toLowerCase()} authenticated smoke token using GitHub OIDC.`);
}
