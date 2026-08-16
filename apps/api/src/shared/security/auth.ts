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

export async function authenticateRequest(
  request: HttpRequest,
  context: InvocationContext,
  config: AuthConfig = readAuthConfig(),
  verifier: JwtVerifier = verifyJwtWithJose,
): Promise<AuthorizationResult> {
  return authenticateBearerToken(request.headers.get('authorization'), context, config, verifier);
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

export function authorizeAuthenticatedPrincipalForOperation(
  principal: AuthenticatedPrincipal,
  context: InvocationContext,
  operationId: string,
): AuthorizationResult {
  const operation = getOperationDefinition(operationId);
  if (!operation.requiredPermission) {
    throw new Error(`Operation ${operationId} does not require authorization.`);
  }
  const result = authorizePrincipal(principal, {
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
  const authentication = await authenticateBearerToken(authorizationHeader, context, config, verifier);
  return authentication.ok ? authorizePrincipal(authentication.user, policy) : authentication;
}

export async function authenticateBearerToken(
  authorizationHeader: string | null | undefined,
  context: InvocationContext,
  config: AuthConfig = readAuthConfig(),
  verifier: JwtVerifier = verifyJwtWithJose,
): Promise<AuthorizationResult> {
  let environment: ReturnType<typeof getDeployedEnvironmentName>;
  try {
    environment = getDeployedEnvironmentName();
  } catch (error) {
    logAuthFailure(context, 'missing_config', config.debug, error);
    return unauthorized('Authentication is not configured.');
  }

  if (!config.enabled) {
    if (environment !== 'local') {
      logAuthFailure(context, 'missing_config', config.debug);
      return unauthorized('Authentication is not configured.');
    }
    return {
      ok: true,
      user: {
        subject: 'local-dev-placeholder',
        tokenType: 'user',
        scopes: [...PERMISSIONS],
        roles: [],
      },
    };
  }

  const configError = validateConfig(config, environment);
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

  const tokenClaims = readTokenIdentityClaims(payload);
  if (!tokenClaims.valid) {
    return forbidden('Token claim shape is not supported.');
  }

  const { tenantId, objectId, subject, clientId } = tokenClaims;
  if (config.allowedTenants.length > 0 && (!tenantId || !config.allowedTenants.includes(tenantId))) {
    return forbidden('Tenant is not allowed.');
  }

  const tokenAccess = getTokenAccess(payload);
  if (!tokenAccess.valid) {
    return forbidden('Token claim shape is not supported.');
  }

  if (!subject) {
    return forbidden('Subject claim is missing.');
  }

  const tokenType = classifyToken(payload, config, tokenAccess, objectId);
  if (tokenType === 'invalid') {
    return forbidden('Token claim shape is not supported.');
  }

  if (tokenType === 'service') {
    if (!isAllowedServiceClient(objectId, clientId, config)) {
      return forbidden('Service client is not allowed.');
    }

    return {
      ok: true,
      user: {
        subject,
        objectId,
        tenantId,
        clientId,
        tokenType: 'service',
        scopes: [],
        roles: normalizeServiceRoles(tokenAccess.roles),
      },
    };
  }

  if (!isAllowedUser(objectId, subject, config)) {
    return forbidden('User is not allowed.');
  }

  if (!isAllowedDelegatedClient(clientId, config)) {
    return forbidden('Delegated OAuth client is not allowed.');
  }

  return {
    ok: true,
    user: {
      subject,
      objectId,
      tenantId,
      clientId,
      tokenType: 'user',
      scopes: tokenAccess.scopes,
      roles: [],
    },
  };
}

export async function verifyJwtWithJose(token: string, config: AuthConfig): Promise<JWTPayload> {
  const issuerSources = configuredIssuerSources(config);
  const acceptedIssuers = configuredIssuers(config);
  if (issuerSources.length === 0 || !config.audience) {
    throw new Error('OIDC issuer and audience are required.');
  }
  if (issuerSources.some((issuer) => !isSupportedOidcUrl(issuer))) {
    throw new Error('OIDC issuer URL is not supported.');
  }

  if (config.jwksUri) {
    if (!isSupportedOidcUrl(config.jwksUri)) {
      throw new Error('OIDC JWKS URL is not supported.');
    }
    // An explicit JWKS URI is a protected operator pin and may intentionally use
    // a different origin. Discovery metadata below is untrusted and is therefore
    // bound to the configured issuer and its own origin.
    const jwks = getJwks(config.jwksUri);
    const result = await jwtVerify(token, jwks, {
      issuer: acceptedIssuers.length === 1 ? acceptedIssuers[0] : acceptedIssuers,
      audience: config.audience,
      requiredClaims: ['exp'],
    });

    return result.payload;
  }

  for (const issuer of issuerSources) {
    const issuerAliases = uniqueStrings([issuer, ...deriveMicrosoftEntraV1IssuerAliases([issuer])]);
    try {
      const jwksUri = await discoverJwksUri(issuer, fetch, { allowedIssuers: issuerAliases });
      const jwks = getJwks(jwksUri);
      const result = await jwtVerify(token, jwks, {
        issuer: issuerAliases.length === 1 ? issuerAliases[0] : issuerAliases,
        audience: config.audience,
        requiredClaims: ['exp'],
      });

      return result.payload;
    } catch {
      // Try the next exact issuer/JWKS pair without leaking token details.
    }
  }

  throw new Error('JWT verification failed for all configured issuers.');
}

function validateConfig(
  config: AuthConfig,
  environment: ReturnType<typeof getDeployedEnvironmentName>,
): string | undefined {
  const issuerSources = configuredIssuerSources(config);
  if (issuerSources.length === 0 || issuerSources.some((issuer) => !isSupportedOidcUrl(issuer))) {
    return 'OIDC_ISSUER';
  }
  if (!config.audience) {
    return 'OIDC_AUDIENCE';
  }
  if (config.jwksUri && !isSupportedOidcUrl(config.jwksUri)) {
    return 'OIDC_JWKS_URI';
  }
  if (config.requiredScopes.length === 0) {
    return 'OIDC_REQUIRED_SCOPES';
  }
  if (environment !== 'local' && config.allowedTenants.length === 0) {
    return 'OIDC_ALLOWED_TENANTS';
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
  valid: boolean;
  scopes: string[];
  roles: string[];
}

function getTokenAccess(payload: JWTPayload): TokenAccess {
  const scopeClaim = payload['scp'];
  if (scopeClaim !== undefined && (typeof scopeClaim !== 'string' || scopeClaim.trim().length === 0)) {
    return { valid: false, scopes: [], roles: [] };
  }
  const scopes = typeof scopeClaim === 'string' ? scopeClaim.split(' ').filter(Boolean) : [];
  const rolesClaim = payload['roles'];
  if (
    rolesClaim !== undefined &&
    (!Array.isArray(rolesClaim) || rolesClaim.some((role) => typeof role !== 'string' || role.length === 0))
  ) {
    return { valid: false, scopes: [], roles: [] };
  }
  const roles = Array.isArray(rolesClaim) ? (rolesClaim as string[]) : [];

  return {
    valid: true,
    scopes,
    roles,
  };
}

function normalizeServiceRoles(roles: string[]): string[] {
  return [...new Set(roles.map((role) => serviceRolePermissionAliases.get(role) ?? role))];
}

type TokenClassification = 'user' | 'service' | 'invalid';

function classifyToken(
  payload: JWTPayload,
  config: AuthConfig,
  tokenAccess: TokenAccess,
  objectId: string | undefined,
): TokenClassification {
  const idtyp = payload['idtyp'];
  if (idtyp !== undefined && idtyp !== 'app' && idtyp !== 'user') {
    return 'invalid';
  }

  const credentialEvidence = getClientCredentialEvidence(payload);
  if (!credentialEvidence.valid) {
    return 'invalid';
  }

  if (idtyp === 'app') {
    if (tokenAccess.scopes.length > 0 || credentialEvidence.publicClient) return 'invalid';
    return 'service';
  }

  if (idtyp === 'user' || tokenAccess.scopes.length > 0) {
    return 'user';
  }

  // Microsoft Entra app-only access tokens are documented to carry application
  // permissions in the `roles` claim, but not all token versions include the
  // optional `idtyp: app` marker. For that compatibility path, require a
  // confidential-client marker and the service principal's object ID. A client
  // ID alone is not enough because it can also identify a delegated OAuth app.
  if (
    tokenAccess.roles.length > 0 &&
    credentialEvidence.confidentialClient &&
    objectId !== undefined &&
    config.allowedAppObjectIds.includes(objectId)
  ) {
    return 'service';
  }

  return 'user';
}

interface ClientCredentialEvidence {
  valid: boolean;
  confidentialClient: boolean;
  publicClient: boolean;
}

function getClientCredentialEvidence(payload: JWTPayload): ClientCredentialEvidence {
  const markers = [payload['azpacr'], payload['appidacr']].filter((value) => value !== undefined);
  if (
    markers.some((value) => typeof value !== 'string' || !['0', '1', '2'].includes(value)) ||
    new Set(markers).size > 1
  ) {
    return { valid: false, confidentialClient: false, publicClient: false };
  }

  const marker = markers[0];
  return {
    valid: true,
    confidentialClient: marker === '1' || marker === '2',
    publicClient: marker === '0',
  };
}

interface TokenIdentityClaims {
  valid: boolean;
  tenantId?: string;
  objectId?: string;
  subject?: string;
  clientId?: string;
}

function readTokenIdentityClaims(payload: JWTPayload): TokenIdentityClaims {
  const tenant = readOptionalNonEmptyStringClaim(payload, 'tid');
  const object = readOptionalNonEmptyStringClaim(payload, 'oid');
  const subject = readOptionalNonEmptyStringClaim(payload, 'sub');
  const authorizedParty = readOptionalNonEmptyStringClaim(payload, 'azp');
  const application = readOptionalNonEmptyStringClaim(payload, 'appid');
  if (!tenant.valid || !object.valid || !subject.valid || !authorizedParty.valid || !application.valid) {
    return { valid: false };
  }
  if (authorizedParty.value && application.value && authorizedParty.value !== application.value) {
    return { valid: false };
  }

  return {
    valid: true,
    tenantId: tenant.value,
    objectId: object.value,
    subject: subject.value,
    clientId: authorizedParty.value ?? application.value,
  };
}

function readOptionalNonEmptyStringClaim(payload: JWTPayload, name: string): { valid: boolean; value?: string } {
  const value = payload[name];
  if (value === undefined) return { valid: true };
  return typeof value === 'string' && value.length > 0 ? { valid: true, value } : { valid: false };
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
  return clientId !== undefined && config.allowedDelegatedClientIds.includes(clientId);
}

export interface OidcDiscoveryOptions {
  allowedIssuers?: readonly string[];
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
  const normalizedIssuer = normalizeSupportedOidcUrl(issuer, 'issuer');
  const allowedIssuers = uniqueStrings(
    (options.allowedIssuers ?? [normalizedIssuer, ...deriveMicrosoftEntraV1IssuerAliases([normalizedIssuer])]).map(
      (allowedIssuer) => normalizeSupportedOidcUrl(allowedIssuer, 'metadata issuer'),
    ),
  );
  const cacheKey = `${normalizedIssuer}\n${[...allowedIssuers].sort().join(',')}`;
  const now = options.now ?? Date.now;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.promise;
  if (cached) discoveryCache.delete(cacheKey);

  const promise = discoverJwksUriWithRetry(normalizedIssuer, allowedIssuers, fetchImpl, options);
  const entry = {
    promise,
    expiresAt: now() + (options.cacheTtlMs ?? 10 * 60_000),
  };
  discoveryCache.set(cacheKey, entry);
  try {
    return await promise;
  } catch (error) {
    if (discoveryCache.get(cacheKey)?.promise === promise) {
      discoveryCache.delete(cacheKey);
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
  allowedIssuers: readonly string[],
  fetchImpl: typeof fetch,
  options: OidcDiscoveryOptions,
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 150;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  const discoveryUrl = new URL(`${normalizedIssuer}/.well-known/openid-configuration`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(discoveryUrl, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.redirected || (response.url && response.url !== discoveryUrl.toString())) {
        throw new Error('OIDC discovery redirects are not allowed.');
      }
      if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}.`);
      const metadata = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (typeof metadata.issuer !== 'string' || metadata.issuer.length === 0) {
        throw new Error('OIDC discovery did not return issuer.');
      }
      const metadataIssuer = normalizeSupportedOidcUrl(metadata.issuer, 'metadata issuer');
      if (!allowedIssuers.includes(metadataIssuer)) {
        throw new Error('OIDC discovery issuer does not match the configured issuer.');
      }
      if (typeof metadata.jwks_uri !== 'string' || metadata.jwks_uri.length === 0) {
        throw new Error('OIDC discovery did not return jwks_uri.');
      }
      const jwksUrl = new URL(normalizeSupportedOidcUrl(metadata.jwks_uri, 'jwks_uri'));
      if (jwksUrl.origin !== discoveryUrl.origin) {
        throw new Error('OIDC discovery returned a cross-origin jwks_uri.');
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
  const issuers = configuredIssuerSources(config);
  return uniqueStrings([...issuers, ...deriveMicrosoftEntraV1IssuerAliases(issuers)]);
}

function configuredIssuerSources(config: AuthConfig): string[] {
  return config.issuers && config.issuers.length > 0 ? config.issuers : config.issuer ? [config.issuer] : [];
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

function isSupportedOidcUrl(value: string): boolean {
  try {
    normalizeSupportedOidcUrl(value, 'URL');
    return true;
  } catch {
    return false;
  }
}

function normalizeSupportedOidcUrl(value: string, label: string): string {
  if (value !== value.trim()) {
    throw new Error(`OIDC ${label} URL is malformed.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`OIDC ${label} URL is malformed.`);
  }
  const loopbackHttp =
    parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`OIDC ${label} URL is unsupported.`);
  }
  return parsed.toString().replace(/\/$/, '');
}
