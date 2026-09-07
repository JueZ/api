#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function selectPreflightEnvironment(env, installedSettings) {
  if (installedSettings === undefined) return env;
  const settings = installedSettings?.properties;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Installed runtime settings are unavailable.');
  }
  const actual = { ...env };
  for (const name of [
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
  ]) {
    if (settings[name] !== undefined && typeof settings[name] !== 'string') {
      throw new Error('Installed runtime authentication settings are malformed.');
    }
    // Missing installed settings cannot inherit more permissive GitHub values.
    actual[name] = settings[name] ?? '';
  }
  return actual;
}

export function requiredSmokeOperations(env) {
  const operations = ['local.hello', 'reddit.thread'];
  for (const [flag, operation] of [
    ['WEATHER_SMOKE_ENABLED', 'weather.forecast'],
    ['YOUTUBE_TRANSCRIPT_SMOKE_ENABLED', 'youtube.transcript'],
  ]) {
    if (env[flag] !== undefined && !['true', 'false'].includes(env[flag])) {
      throw new Error(`Invalid smoke enablement flag: ${flag}`);
    }
    if (env[flag] === 'true') operations.push(operation);
  }
  return operations;
}

// Run the approved package's actual signature, issuer, audience, tenant,
// service-client and operation authorization policy without calling a provider.
export async function verifySmokeIdentity({ auth, env = process.env }) {
  if (!['test', 'prod'].includes(env.ENVIRONMENT_NAME) || env.DEPLOYED_ENVIRONMENT_NAME !== env.ENVIRONMENT_NAME) {
    throw new Error('Smoke identity preflight requires the explicit target runtime environment.');
  }
  if (env.AUTH_ENABLED !== 'true' || !env.AUTH_ACCESS_TOKEN) {
    throw new Error('Smoke identity preflight requires enabled authentication and a freshly minted token.');
  }
  const operations = requiredSmokeOperations(env);
  const context = { invocationId: 'smoke-identity-preflight', warn() {}, error() {}, log() {} };
  const config = auth.readAuthConfig({ ...env, AUTH_DEBUG: 'false' });
  const result = await auth.authenticateBearerToken(`Bearer ${env.AUTH_ACCESS_TOKEN}`, context, config);
  if (!result.ok || result.user.tokenType !== 'service') {
    throw new Error('Smoke service identity failed token or configured access-policy verification.');
  }
  for (const operation of operations) {
    const decision = auth.authorizeAuthenticatedPrincipalForOperation(result.user, context, operation);
    if (!decision.ok) throw new Error(`Smoke service identity is not authorized for ${operation}.`);
  }
  return { status: 'passed', evidence: 'package-authorization-preflight', operations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (
      args[0] !== '--auth-module' ||
      !args[1] ||
      ![2, 3].includes(args.length) ||
      (args.length === 3 && args[2] !== '--installed-settings-stdin')
    )
      throw new Error('Expected --auth-module.');
    const auth = await import(pathToFileURL(resolve(args[1])).href);
    const installed = args.length === 3 ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
    const env = selectPreflightEnvironment(process.env, installed);
    console.log(JSON.stringify(await verifySmokeIdentity({ auth, env })));
  } catch (error) {
    // Even unexpected adapter errors must not serialize JWTs or claim payloads.
    const deniedOperation =
      /^Smoke service identity is not authorized for (local\.hello|reddit\.thread|weather\.forecast|youtube\.transcript)\.$/.exec(
        error.message ?? '',
      );
    console.error(
      deniedOperation
        ? deniedOperation[0]
        : 'Smoke identity preflight failed; verify the target identity, roles and allowlists before mutation.',
    );
    process.exitCode = 1;
  }
}
