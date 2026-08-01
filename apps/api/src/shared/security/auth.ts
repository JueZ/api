import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { authorizeOperation } from '../../application/authorization/policy.js';
import {
  PERMISSIONS,
  type AuthenticatedPrincipal,
  type OperationAuthorizationPolicy,
  type Permission,
} from '../../application/authorization/types.js';
import { getOperationDefinition } from '../../application/operations/registry.js';
import { getDeployedEnvironmentName } from '../config/runtime.js';
import { buildDeterministicRepairableProblem } from '../errors/repairableErrorService.js';

export type { AuthenticatedPrincipal };
export type AuthenticatedUser = AuthenticatedPrincipal;

export interface AuthConfig {
  enabled: boolean;
  issuer?: string;
  issuers?: string[];
  audience?: string;
  jwksUri?: string;
  requiredScopes: string[];
  allowedObjectIds: string[];
  allowedSubjects: string[];
  allowedAppObjectIds: string[];
  allowedClientIds: string[];
  allowedDelegatedClientIds: string[];
  allowedTenants: string[];
  debug: boolean;
}

interface AuthorizationSuccess {
  ok: true;
  user: AuthenticatedPrincipal;
}

interface AuthorizationFailure {
  ok: false;
  response: HttpResponseInit;
}

export type AuthorizationResult = AuthorizationSuccess | AuthorizationFailure;
export type JwtVerifier = (token: string, config: AuthConfig) => Promise<JWTPayload>;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const discoveryCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();
const serviceRolePermissionAliases = new Map<string, Permission>([
  ['catalogue.service.read', 'catalogue.read'],
  ['reddit.service.read', 'reddit.read'],
]);
const defaultAuthorizationPolicy = {
  permission: 'catalogue.read',
  allowedTokenTypes: ['user', 'service'],
} as const satisfies OperationAuthorizationPolicy;

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const issuers = parseCsv(env['OIDC_ISSUER']).map((issuer) => normalizeUrl(issuer));

  return {
    enabled: env['AUTH_ENABLED'] === 'true',
    issuer: issuers[0],
    issuers,
    audience: normalizeOptionalString(env['OIDC_AUDIENCE']),
    jwksUri: normalizeOptionalUrl(env['OIDC_JWKS_URI']),
    requiredScopes: parseCsv(env['OIDC_REQUIRED_SCOPES'] ?? 'catalogue.read'),
    allowedObjectIds: parseCsv(env['OIDC_ALLOWED_OBJECT_IDS']),
    allowedSubjects: parseCsv(env['OIDC_ALLOWED_SUBJECTS']),
    allowedAppObjectIds: parseCsv(env['OIDC_ALLOWED_APP_OBJECT_IDS']),
    allowedClientIds: parseCsv(env['OIDC_ALLOWED_CLIENT_IDS']),
    allowedDelegatedClientIds: parseCsv(env['OIDC_ALLOWED_DELEGATED_CLIENT_IDS']),
    allowedTenants: parseCsv(env['OIDC_ALLOWED_TENANTS']),
    debug: env['AUTH_DEBUG'] === 'true',
  };
}

export async function authorizeRequest(
  request: HttpRequest,
  context: InvocationContext,
  config: AuthConfig = readAuthConfig(),
  verifier: JwtVerifier = verifyJwtWithJose,
  policy: OperationAuthorizationPolicy = defaultAuthorizationPolicy,
): Promise<AuthorizationResult> {
  return authorizeBearerToken(request.headers.get('authorization'), context, config, verifier, policy);
}

export async function authorizeRequestForOperation(
  request: HttpRequest,
  context: InvocationContext,
  operationId: string,
  config: AuthConfig = readAuthConfig(),
  verifier: JwtVerifier = verifyJwtWithJose,
): Promise<AuthorizationResult> {
  const operation = getOperationDefinition(operationId);
  if (!operation.requiredPermission) {
    throw new Error(`Operation ${operationId} does not require authorization.`);
  }
  const result = await authorizeRequest(request, context, config, verifier, {
    permission: operation.requiredPermission,
    allowedTokenTypes: operation.allowedTokenTypes,
    environment: getDeployedEnvironmentName(),
    allowedEnvironments: operation.allowedEnvironments,
  });
  return result.ok ? result : repairableAuthorizationFailure(result, operationId, context);
}

export async function authorizeBearerToken(
  authorizationHeader: string | null | undefined,
  context: InvocationContext,
  config: AuthConfig = readAuthConfig(),
  verifier: JwtVerifier = verifyJwtWithJose,
  policy: OperationAuthorizationPolicy = defaultAuthorizationPolicy,
): Promise<AuthorizationResult> {
  if (!config.enabled) {
    const environment = getDeployedEnvironmentName();
    if (environment !== 'local') {
      logAuthFailure(context, 'missing_config', config.debug);
      return unauthorized('Authentication is not configured.');
    }
    return authorizePrincipal(
      {
        subject: 'local-dev-placeholder',
        tokenType: 'user',
        scopes: [...PERMISSIONS],
        roles: [],
      },
      policy,
    );
  }

  const configError = validateConfig(config);
  if (configError) {
    logAuthFailure(context, 'missing_config', config.debug);
    return unauthorized('Authentication is not configured.');
  }

  if (!authorizationHeader) {
    return unauthorized('Missing bearer token.');
  }

  const bearerMatch = /^Bearer\s+([^\s]+)$/i.exec(authorizationHeader.trim());
  if (!bearerMatch) {
    return unauthorized('Malformed bearer token.');
  }

  const token = bearerMatch[1];
  let payload: JWTPayload;

  try {
    payload = await verifier(token, config);
  } catch (error) {
    logAuthFailure(context, 'invalid_token', config.debug, error);
    return unauthorized('Invalid bearer token.');
  }

  const tenantId = typeof payload['tid'] === 'string' ? payload['tid'] : undefined;
  if (config.allowedTenants.length > 0 && (!tenantId || !config.allowedTenants.includes(tenantId))) {
    return forbidden('Tenant is not allowed.');
  }

  const tokenAccess = getTokenAccess(payload);

  const objectId = typeof payload['oid'] === 'string' ? payload['oid'] : undefined;
  const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (!subject) {
    return forbidden('Subject claim is missing.');
  }

  const clientId = getClientId(payload);
  if (isServiceToken(payload, config, tokenAccess, objectId, clientId)) {
    if (!isAllowedServiceClient(objectId, clientId, config)) {
      return forbidden('Service client is not allowed.');
    }

    return authorizePrincipal(
      {
        subject,
        objectId,
        tenantId,
        clientId,
        tokenType: 'service',
        scopes: tokenAccess.scopes,
        roles: normalizeServiceRoles(tokenAccess.roles),
      },
      policy,
    );
  }

  if (!isAllowedUser(objectId, subject, config)) {
    return forbidden('User is not allowed.');
  }

  if (!isAllowedDelegatedClient(clientId, config)) {
    return forbidden('Delegated OAuth client is not allowed.');
  }

  return authorizePrincipal(
    {
      subject,
      objectId,
      tenantId,
      clientId,
      tokenType: 'user',
      scopes: tokenAccess.scopes,
      roles: tokenAccess.roles,
    },
    policy,
  );
}

export async function verifyJwtWithJose(token: string, config: AuthConfig): Promise<JWTPayload> {
  const issuers = configuredIssuers(config);
  if (issuers.length === 0 || !config.audience) {
    throw new Error('OIDC issuer and audience are required.');
  }

  if (config.jwksUri) {
    const jwks = getJwks(config.jwksUri);
    const result = await jwtVerify(token, jwks, {
      issuer: issuers.length === 1 ? issuers[0] : issuers,
      audience: config.audience,
    });

    return result.payload;
  }

  for (const issuer of issuers) {
    try {
      const jwksUri = await discoverJwksUri(issuer);
      const jwks = getJwks(jwksUri);
      const result = await jwtVerify(token, jwks, {
        issuer,
        audience: config.audience,
      });

      return result.payload;
    } catch {
      // Try the next exact issuer/JWKS pair without leaking token details.
    }
  }

  throw new Error('JWT verification failed for all configured issuers.');
}

function validateConfig(config: AuthConfig): string | undefined {
  if (configuredIssuers(config).length === 0) {
    return 'OIDC_ISSUER';
  }
  if (!config.audience) {
    return 'OIDC_AUDIENCE';
  }
  if (config.requiredScopes.length === 0) {
    return 'OIDC_REQUIRED_SCOPES';
  }
  if (
    config.allowedObjectIds.length === 0 &&
    config.allowedSubjects.length === 0 &&
    config.allowedAppObjectIds.length === 0 &&
    config.allowedClientIds.length === 0
  ) {
    return 'OIDC_ALLOWED_OBJECT_IDS, OIDC_ALLOWED_SUBJECTS, OIDC_ALLOWED_APP_OBJECT_IDS, or OIDC_ALLOWED_CLIENT_IDS';
  }
  return undefined;
}

interface TokenAccess {
  scopes: string[];
  roles: string[];
}

function getTokenAccess(payload: JWTPayload): TokenAccess {
  const scopeClaim = typeof payload['scp'] === 'string' ? payload['scp'] : '';
  const scopes = scopeClaim.split(' ').filter(Boolean);
  const rolesClaim = payload['roles'];
  const roles = Array.isArray(rolesClaim) ? rolesClaim.filter((role): role is string => typeof role === 'string') : [];

  return {
    scopes,
    roles,
  };
}

function normalizeServiceRoles(roles: string[]): string[] {
  return [...new Set(roles.map((role) => serviceRolePermissionAliases.get(role) ?? role))];
}

function isServiceToken(
  payload: JWTPayload,
  config: AuthConfig,
  tokenAccess: TokenAccess,
  objectId: string | undefined,
  clientId: string | undefined,
): boolean {
  if (payload['idtyp'] === 'app') {
    return true;
  }

  // Microsoft Entra app-only access tokens are documented to carry application
  // permissions in the `roles` claim, but not all token versions include the
  // optional `idtyp: app` marker. Treat a roles-only token as service auth only
  // when it also matches the explicit service-client allowlists. Delegated user
  // tokens with `scp` keep the user path and still require the user allowlist.
  return (
    tokenAccess.scopes.length === 0 &&
    tokenAccess.roles.length > 0 &&
    hasClientCredentialAuthMethod(payload) &&
    isAllowedServiceClient(objectId, clientId, config)
  );
}

function hasClientCredentialAuthMethod(payload: JWTPayload): boolean {
  return typeof payload['azpacr'] === 'string' || typeof payload['appidacr'] === 'string';
}

function getClientId(payload: JWTPayload): string | undefined {
  const azp = payload['azp'];
  if (typeof azp === 'string' && azp.length > 0) {
    return azp;
  }

  const appId = payload['appid'];
  if (typeof appId === 'string' && appId.length > 0) {
    return appId;
  }

  return undefined;
}

function isAllowedServiceClient(
  objectId: string | undefined,
  clientId: string | undefined,
  config: AuthConfig,
): boolean {
  if (objectId && config.allowedAppObjectIds.includes(objectId)) {
    return true;
  }

  return clientId !== undefined && config.allowedClientIds.includes(clientId);
}

function isAllowedUser(objectId: string | undefined, subject: string, config: AuthConfig): boolean {
  if (objectId) {
    return config.allowedObjectIds.includes(objectId);
  }

  return config.allowedSubjects.includes(subject);
}

function isAllowedDelegatedClient(clientId: string | undefined, config: AuthConfig): boolean {
  if (config.allowedDelegatedClientIds.length === 0) {
    return true;
  }

  return clientId !== undefined && config.allowedDelegatedClientIds.includes(clientId);
}

export interface OidcDiscoveryOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  cacheTtlMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function discoverJwksUri(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  options: OidcDiscoveryOptions = {},
): Promise<string> {
  const normalizedIssuer = issuer.replace(/\/$/, '');
  const now = options.now ?? Date.now;
  const cached = discoveryCache.get(normalizedIssuer);
  if (cached && cached.expiresAt > now()) return cached.promise;
  if (cached) discoveryCache.delete(normalizedIssuer);

  const promise = discoverJwksUriWithRetry(normalizedIssuer, fetchImpl, options);
  const entry = {
    promise,
    expiresAt: now() + (options.cacheTtlMs ?? 10 * 60_000),
  };
  discoveryCache.set(normalizedIssuer, entry);
  try {
    return await promise;
  } catch (error) {
    if (discoveryCache.get(normalizedIssuer)?.promise === promise) {
      discoveryCache.delete(normalizedIssuer);
    }
    throw error;
  }
}

export function clearOidcCachesForTesting(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function discoverJwksUriWithRetry(
  normalizedIssuer: string,
  fetchImpl: typeof fetch,
  options: OidcDiscoveryOptions,
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 150;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${normalizedIssuer}/.well-known/openid-configuration`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}.`);
      const metadata = (await response.json()) as { jwks_uri?: unknown };
      if (typeof metadata.jwks_uri !== 'string' || metadata.jwks_uri.length === 0) {
        throw new Error('OIDC discovery did not return jwks_uri.');
      }
      const jwksUrl = new URL(metadata.jwks_uri);
      if (
        jwksUrl.protocol !== 'https:' &&
        !(jwksUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(jwksUrl.hostname))
      ) {
        throw new Error('OIDC discovery returned an unsupported jwks_uri.');
      }
      return jwksUrl.toString();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OIDC discovery failed.');
}

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(jwksUri);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  jwksCache.set(jwksUri, jwks);
  return jwks;
}

function unauthorized(message: string): AuthorizationFailure {
  return {
    ok: false,
    response: {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer',
      },
      jsonBody: {
        error: {
          code: 'unauthorized',
          message,
        },
      },
    },
  };
}

function forbidden(message: string): AuthorizationFailure {
  return {
    ok: false,
    response: {
      status: 403,
      jsonBody: {
        error: {
          code: 'forbidden',
          message,
        },
      },
    },
  };
}

function repairableAuthorizationFailure(
  failure: AuthorizationFailure,
  operationId: string,
  context: InvocationContext,
): AuthorizationFailure {
  const status = failure.response.status === 403 ? 403 : 401;
  const problem = buildDeterministicRepairableProblem({
    operationId,
    status,
    endpoint: getOperationDefinition(operationId).rest?.path ?? '/api',
    classification: 'authorization_context_mismatch',
    title: status === 401 ? 'Authentication is required' : 'Authorization context does not permit this operation',
    detail: safeAuthorizationFailureMessage(failure, status),
    callerInstruction:
      status === 401
        ? 'Obtain a valid bearer token for this API and retry the same operation with the credential attached.'
        : 'Do not mutate the operation arguments. Use an identity and token with the required operation permission, or stop and report that access is denied.',
    safeDebugSummary: `Deterministic authorization failure for ${operationId}; http_status=${status}; no credential material included.`,
    repairable: true,
    retryPolicy: { can_retry: true, same_request: false, idempotency_required: false },
    traceId: context.invocationId,
    repairPlan: [
      {
        action: 'retry_with_modified_request',
        reason:
          status === 401
            ? 'A valid bearer credential is required before this operation can run.'
            : 'The authenticated principal does not satisfy the operation authorization policy.',
      },
    ],
  });
  return {
    ok: false,
    response: {
      ...failure.response,
      headers: { ...failure.response.headers, 'Content-Type': 'application/problem+json' },
      jsonBody: problem,
    },
  };
}

function safeAuthorizationFailureMessage(failure: AuthorizationFailure, status: 401 | 403): string {
  const body = failure.response.jsonBody;
  if (isRecord(body)) {
    const error = body['error'];
    if (isRecord(error) && typeof error['message'] === 'string' && error['message'].length > 0) {
      return error['message'];
    }
  }
  return status === 401 ? 'A valid bearer token was not provided.' : 'The authenticated principal is not permitted.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authorizePrincipal(
  principal: AuthenticatedPrincipal,
  policy: OperationAuthorizationPolicy,
): AuthorizationResult {
  const decision = authorizeOperation(principal, policy);
  if (decision.ok) return { ok: true, user: principal };
  if (decision.reason === 'token_type_not_allowed') {
    return forbidden('Token type is not allowed for this operation.');
  }
  if (decision.reason === 'environment_not_allowed') {
    return forbidden('Operation is not allowed in this environment.');
  }
  return forbidden(`Required permission is missing: ${policy.permission}.`);
}

function logAuthFailure(context: InvocationContext, reason: string, debug: boolean, error?: unknown): void {
  if (!debug) {
    context.warn(`Authentication failed: ${reason}`);
    return;
  }

  const errorName = error instanceof Error ? error.name : undefined;
  context.warn('Authentication failed.', { reason, errorName });
}

function configuredIssuers(config: AuthConfig): string[] {
  const issuers = config.issuers && config.issuers.length > 0 ? config.issuers : config.issuer ? [config.issuer] : [];
  return uniqueStrings([...issuers, ...deriveMicrosoftEntraV1IssuerAliases(issuers)]);
}

function deriveMicrosoftEntraV1IssuerAliases(issuers: string[]): string[] {
  return issuers.flatMap((issuer) => {
    const match = /^(https?):\/\/([^/]+)\/([0-9a-fA-F-]{36})\/v2\.0$/.exec(issuer);
    if (!match) {
      return [];
    }

    const [, protocol, host, tenantId] = match;
    const sameHostV1Issuer = `${protocol}://${host}/${tenantId}`;
    // Microsoft Entra v1 access tokens can use an exact issuer with a trailing slash.
    const sameHostV1IssuerWithSlash = `${sameHostV1Issuer}/`;
    if (host.toLowerCase() !== 'login.microsoftonline.com') {
      return [sameHostV1Issuer, sameHostV1IssuerWithSlash];
    }

    return [sameHostV1Issuer, sameHostV1IssuerWithSlash, `https://sts.windows.net/${tenantId}/`];
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalUrl(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalizeUrl(normalized) : undefined;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/$/, '');
}
