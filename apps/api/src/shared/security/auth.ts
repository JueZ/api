import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface AuthenticatedUser {
  subject: string;
  objectId?: string;
  tenantId?: string;
}

export interface AuthConfig {
  enabled: boolean;
  issuer?: string;
  issuers?: string[];
  audience?: string;
  jwksUri?: string;
  requiredScopes: string[];
  allowedObjectIds: string[];
  allowedSubjects: string[];
  allowedTenants: string[];
  debug: boolean;
}

interface AuthorizationSuccess {
  ok: true;
  user: AuthenticatedUser;
}

interface AuthorizationFailure {
  ok: false;
  response: HttpResponseInit;
}

export type AuthorizationResult = AuthorizationSuccess | AuthorizationFailure;
export type JwtVerifier = (token: string, config: AuthConfig) => Promise<JWTPayload>;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const discoveryCache = new Map<string, Promise<string>>();

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const issuers = parseCsv(env['OIDC_ISSUER']).map((issuer) => normalizeUrl(issuer));

  return {
    enabled: env['AUTH_ENABLED'] === 'true',
    issuer: issuers[0],
    issuers,
    audience: normalizeOptionalString(env['OIDC_AUDIENCE']),
    jwksUri: normalizeOptionalUrl(env['OIDC_JWKS_URI']),
    requiredScopes: parseCsv(env['OIDC_REQUIRED_SCOPES'] ?? 'api.access'),
    allowedObjectIds: parseCsv(env['OIDC_ALLOWED_OBJECT_IDS']),
    allowedSubjects: parseCsv(env['OIDC_ALLOWED_SUBJECTS']),
    allowedTenants: parseCsv(env['OIDC_ALLOWED_TENANTS']),
    debug: env['AUTH_DEBUG'] === 'true',
  };
}

export async function authorizeRequest(
  request: HttpRequest,
  context: InvocationContext,
  config: AuthConfig = readAuthConfig(),
  verifier: JwtVerifier = verifyJwtWithJose,
): Promise<AuthorizationResult> {
  if (!config.enabled) {
    return {
      ok: true,
      user: {
        subject: 'local-dev-placeholder',
      },
    };
  }

  const configError = validateConfig(config);
  if (configError) {
    logAuthFailure(context, 'missing_config', config.debug);
    return unauthorized('Authentication is not configured.');
  }

  const authorizationHeader = request.headers.get('authorization');
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

  if (!hasRequiredScopeOrRole(payload, config.requiredScopes)) {
    return forbidden('Required scope or role is missing.');
  }

  const objectId = typeof payload['oid'] === 'string' ? payload['oid'] : undefined;
  const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (!subject) {
    return forbidden('Subject claim is missing.');
  }

  if (!isAllowedUser(objectId, subject, config)) {
    return forbidden('User is not allowed.');
  }

  return {
    ok: true,
    user: {
      subject,
      objectId,
      tenantId,
    },
  };
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
  if (config.allowedObjectIds.length === 0 && config.allowedSubjects.length === 0) {
    return 'OIDC_ALLOWED_OBJECT_IDS or OIDC_ALLOWED_SUBJECTS';
  }
  return undefined;
}

function hasRequiredScopeOrRole(payload: JWTPayload, requiredScopes: string[]): boolean {
  const scopeClaim = typeof payload['scp'] === 'string' ? payload['scp'] : '';
  const scopes = scopeClaim.split(' ').filter(Boolean);
  const rolesClaim = payload['roles'];
  const roles = Array.isArray(rolesClaim) ? rolesClaim.filter((role): role is string => typeof role === 'string') : [];

  return requiredScopes.some((requiredScope) => scopes.includes(requiredScope) || roles.includes(requiredScope));
}

function isAllowedUser(objectId: string | undefined, subject: string, config: AuthConfig): boolean {
  if (objectId) {
    return config.allowedObjectIds.includes(objectId);
  }

  return config.allowedSubjects.includes(subject);
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const normalizedIssuer = issuer.replace(/\/$/, '');
  let discovery = discoveryCache.get(normalizedIssuer);
  if (!discovery) {
    discovery = fetch(`${normalizedIssuer}/.well-known/openid-configuration`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('OIDC discovery failed.');
        }
        return response.json() as Promise<{ jwks_uri?: unknown }>;
      })
      .then((metadata) => {
        if (typeof metadata.jwks_uri !== 'string' || metadata.jwks_uri.length === 0) {
          throw new Error('OIDC discovery did not return jwks_uri.');
        }
        return metadata.jwks_uri;
      });
    discoveryCache.set(normalizedIssuer, discovery);
  }
  return discovery;
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
    if (host.toLowerCase() !== 'login.microsoftonline.com') {
      return [sameHostV1Issuer];
    }

    return [sameHostV1Issuer, `https://sts.windows.net/${tenantId}`];
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
