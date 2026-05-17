#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';

const TOKEN_ENDPOINT_HOST = 'https://login.microsoftonline.com';
const DEFAULT_GITHUB_OIDC_AUDIENCE = 'api://AzureADTokenExchange';

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

  const oidcUrl = new URL(githubRequestUrl);
  oidcUrl.searchParams.set('audience', config.githubOidcAudience);
  const oidcResponse = await fetch(oidcUrl, {
    headers: {
      Authorization: `bearer ${githubRequestToken}`,
      Accept: 'application/json',
    },
  });
  if (!oidcResponse.ok) {
    console.error(`GitHub OIDC token request failed with HTTP ${oidcResponse.status}.`);
    process.exit(2);
  }
  const oidcPayload = await oidcResponse.json();
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
  const tokenResponse = await fetch(`${TOKEN_ENDPOINT_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!tokenResponse.ok) {
    let errorSummary = '';
    try {
      const errorPayload = await tokenResponse.json();
      errorSummary = typeof errorPayload.error === 'string' ? ` (${errorPayload.error})` : '';
    } catch {
      // Ignore non-JSON Entra errors; do not print response bodies because they can include sensitive context.
    }
    console.error(`Microsoft Entra token exchange failed with HTTP ${tokenResponse.status}${errorSummary}.`);
    process.exit(2);
  }
  const tokenPayload = await tokenResponse.json();
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : '';
  if (!accessToken) {
    console.error('Microsoft Entra token response did not include an access token.');
    process.exit(2);
  }

  console.log(`::add-mask::${accessToken}`);
  await appendFile(githubEnv, `AUTH_ACCESS_TOKEN<<__SMOKE_TOKEN__\n${accessToken}\n__SMOKE_TOKEN__\n`);
  console.log(`Minted short-lived ${config.prefix.toLowerCase()} authenticated smoke token using GitHub OIDC.`);
}
