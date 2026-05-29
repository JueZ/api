#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { fetchWithTimeout, getSmokeFetchTimeoutMs, isTimeoutError } from './lib/smoke-utils.mjs';

const TOKEN_ENDPOINT_HOST = 'https://login.microsoftonline.com';
const DEFAULT_GITHUB_OIDC_AUDIENCE = 'api://AzureADTokenExchange';
const MAX_TOKEN_FETCH_TIMEOUT_MS = 120_000;

export function sanitizeTokenEndpointErrorCode(value) {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9_.-]{1,96}$/.test(normalized) ? normalized : '';
}

export function selectServiceAuthConfig(env = process.env) {
  const environmentName = (env.ENVIRONMENT_NAME || '').trim().toLowerCase();
  const prefix = environmentName === 'prod' ? 'PROD' : 'TEST';

  return {
    environmentName,
    prefix,
    clientId: env[`${prefix}_SERVICE_AUTH_CLIENT_ID`] || '',
    tenantId: env[`${prefix}_SERVICE_AUTH_TENANT_ID`] || '',
    scope: env[`${prefix}_SERVICE_AUTH_SCOPE`] || '',
    githubOidcAudience: env.GITHUB_OIDC_AUDIENCE || DEFAULT_GITHUB_OIDC_AUDIENCE,
  };
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
  return [
    ['clientId', config.clientId],
    ['tenantId', config.tenantId],
    ['scope', config.scope],
  ].filter(([, value]) => !value).map(([name]) => name);
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

  const githubRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const githubRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubRequestUrl || !githubRequestToken || !githubEnv) {
    const message = 'GitHub OIDC runtime variables are unavailable. Ensure workflow permissions include id-token: write.';
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
    oidcResponse = await fetchWithTimeout(oidcUrl, {
      headers: {
        Authorization: `bearer ${githubRequestToken}`,
        Accept: 'application/json',
      },
    }, tokenFetchTimeoutMs);
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
    tokenResponse = await fetchWithTimeout(`${TOKEN_ENDPOINT_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }, tokenFetchTimeoutMs);
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

  console.log(`::add-mask::${accessToken}`);
  await appendFile(githubEnv, `AUTH_ACCESS_TOKEN<<__SMOKE_TOKEN__\n${accessToken}\n__SMOKE_TOKEN__\n`);
  console.log(`Minted short-lived ${config.prefix.toLowerCase()} authenticated smoke token using GitHub OIDC.`);
}
