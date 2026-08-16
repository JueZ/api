import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isIP } from 'node:net';
import { PERMISSIONS, type AuthenticatedPrincipal, type Permission } from '../application/authorization/types.js';
import { getOperationDefinition } from '../application/operations/registry.js';
import { getDeployedEnvironmentName } from '../shared/config/runtime.js';
import { authorizeBearerToken, readAuthConfig, type AuthorizationResult } from '../shared/security/auth.js';

export const MCP_SCOPE: Permission = 'catalogue.read';
export const MCP_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export type McpAuthChallengeError = 'invalid_token' | 'insufficient_scope';

export interface McpWwwAuthenticateOptions {
  error: McpAuthChallengeError;
  errorDescription: string;
  permission?: Permission;
}

export interface McpProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_documentation?: string;
}

export function getMcpResourceOrigin(request?: HttpRequest, env: NodeJS.ProcessEnv = process.env): string {
  const environment = getDeployedEnvironmentName(env);
  const configured = normalizeOrigin(env['MCP_RESOURCE_ORIGIN']);
  if (configured) {
    if (environment === 'local') {
      if (isLoopbackOrigin(configured) || isDeployableMcpOrigin(configured)) return configured;
    } else if (isDeployableMcpOrigin(configured)) {
      return configured;
    }
    throw new Error('MCP_RESOURCE_ORIGIN is not safe for the active environment.');
  }

  if (environment !== 'local') {
    throw new Error('MCP_RESOURCE_ORIGIN is required outside local development.');
  }

  if (request && isLocalRequestUrl(request.url)) {
    return new URL(request.url).origin;
  }

  return 'http://localhost:7071';
}

export function getMcpOAuthScope(env: NodeJS.ProcessEnv = process.env, permission: Permission = MCP_SCOPE): string {
  const configured = normalizeOptionalString(env['MCP_OAUTH_SCOPE']);
  if (configured && permission === MCP_SCOPE) return configured;

  return qualifyOAuthScope(readAuthConfig(env).audience, permission);
}

export function getMcpOAuthScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  return PERMISSIONS.map((permission) => getMcpOAuthScope(env, permission));
}

export function buildMcpProtectedResourceMetadata(
  request?: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
): McpProtectedResourceMetadata {
  const authConfig = readAuthConfig(env);
  const authorizationServers =
    authConfig.issuers && authConfig.issuers.length > 0
      ? authConfig.issuers
      : authConfig.issuer
        ? [authConfig.issuer]
        : [];
  const documentation = normalizeOptionalUrl(env['MCP_RESOURCE_DOCUMENTATION_URL']);
  return {
    resource: authConfig.audience ?? getMcpResourceOrigin(request, env),
    authorization_servers: authorizationServers,
    scopes_supported: getMcpOAuthScopes(env),
    ...(documentation ? { resource_documentation: documentation } : {}),
  };
}

export function buildMcpWwwAuthenticate(
  request: HttpRequest | undefined,
  options: McpWwwAuthenticateOptions,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origin = getMcpResourceOrigin(request, env);
  const parameters: Array<[string, string]> = [
    ['resource_metadata', `${origin}${MCP_PROTECTED_RESOURCE_PATH}`],
    ['scope', getMcpOAuthScope(env, options.permission)],
    ['error', options.error],
    ['error_description', options.errorDescription],
  ];
  return `Bearer ${parameters.map(([key, value]) => `${key}="${quoteWwwAuthenticateValue(value)}"`).join(', ')}`;
}

export async function authorizeMcpTool(
  authorizationHeader: string | null | undefined,
  context: InvocationContext,
  operationId: string,
): Promise<AuthorizationResult> {
  const operation = getOperationDefinition(operationId);
  if (!operation.requiredPermission) {
    throw new Error(`Operation ${operationId} does not require authorization.`);
  }
  return authorizeBearerToken(authorizationHeader, context, readAuthConfig(), undefined, {
    permission: operation.requiredPermission,
    allowedTokenTypes: operation.allowedTokenTypes,
    environment: getDeployedEnvironmentName(),
    allowedEnvironments: operation.allowedEnvironments,
  });
}

export function mcpAuthErrorResult(
  wwwAuthenticate: string,
  error: McpAuthChallengeError,
  errorDescription: string,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: errorDescription }],
    structuredContent: { error },
    _meta: {
      'mcp/www_authenticate': [wwwAuthenticate],
    },
  };
}

export function safeUser(user: AuthenticatedPrincipal): { subject: string; objectId?: string; tenantId?: string } {
  return {
    subject: user.subject,
    ...(user.objectId ? { objectId: user.objectId } : {}),
    ...(user.tenantId ? { tenantId: user.tenantId } : {}),
  };
}

export type McpOriginValidation = { ok: true } | { ok: false; status: 400 | 403; message: string };

export function validateMcpRequestOrigin(
  request: Pick<HttpRequest, 'url' | 'headers'>,
  env: NodeJS.ProcessEnv = process.env,
): McpOriginValidation {
  const environment = getDeployedEnvironmentName(env);
  const requestUrl = parseRequestUrl(request.url);
  if (!requestUrl) return { ok: false, status: 400, message: 'MCP request URL is malformed.' };

  const hostHeader = singleHeaderValue(request.headers, 'host');
  if (!hostHeader.ok) return { ok: false, status: 400, message: 'MCP Host header is malformed.' };
  const forwardedHost = singleHeaderValue(request.headers, 'x-forwarded-host');
  if (!forwardedHost.ok) return { ok: false, status: 400, message: 'MCP forwarded host header is malformed.' };
  const forwardedProto = singleHeaderValue(request.headers, 'x-forwarded-proto');
  if (!forwardedProto.ok) return { ok: false, status: 400, message: 'MCP forwarded scheme header is malformed.' };
  const originHeader = singleHeaderValue(request.headers, 'origin');
  if (!originHeader.ok) return { ok: false, status: 400, message: 'MCP Origin header is malformed.' };

  if (environment === 'local') {
    if (!isLoopbackUrl(requestUrl)) {
      return { ok: false, status: 403, message: 'Local MCP requests must target localhost.' };
    }
    const requestAuthority = requestUrl.host.toLowerCase();
    if (hostHeader.value) {
      const host = normalizeAuthority(hostHeader.value, requestUrl.protocol);
      if (!host || host !== requestAuthority)
        return { ok: false, status: 403, message: 'Local MCP requests must target localhost.' };
    }
    if (forwardedHost.value) {
      const host = normalizeAuthority(forwardedHost.value, requestUrl.protocol);
      if (!host || host !== requestAuthority)
        return { ok: false, status: 403, message: 'Local MCP requests must target localhost.' };
    }
    if (forwardedProto.value && `${forwardedProto.value.toLowerCase()}:` !== requestUrl.protocol)
      return { ok: false, status: 403, message: 'Local MCP request scheme is not allowed.' };
    return { ok: true };
  }

  const canonicalOrigin = normalizeOrigin(env['MCP_RESOURCE_ORIGIN']);
  if (!canonicalOrigin || !isDeployableMcpOrigin(canonicalOrigin)) {
    return { ok: false, status: 400, message: 'MCP_RESOURCE_ORIGIN is not configured.' };
  }
  const canonical = new URL(canonicalOrigin);
  if (requestUrl.origin !== canonical.origin) {
    return { ok: false, status: 403, message: 'MCP request authority is not allowed.' };
  }
  const host = normalizeAuthority(hostHeader.value ?? requestUrl.host, canonical.protocol);
  if (!host || host !== canonical.host.toLowerCase()) {
    return { ok: false, status: 403, message: 'MCP host is not allowed.' };
  }
  const normalizedForwardedHost = forwardedHost.value
    ? normalizeAuthority(forwardedHost.value, canonical.protocol)
    : undefined;
  if (forwardedHost.value && (!normalizedForwardedHost || normalizedForwardedHost !== canonical.host.toLowerCase())) {
    return { ok: false, status: 403, message: 'MCP forwarded host is not allowed.' };
  }
  if (forwardedProto.value && `${forwardedProto.value.toLowerCase()}:` !== canonical.protocol) {
    return { ok: false, status: 403, message: 'MCP forwarded scheme is not allowed.' };
  }

  if (originHeader.value) {
    const normalized = normalizeOrigin(originHeader.value);
    const allowedOrigins = new Set(parseCsv(env['MCP_ALLOWED_ORIGINS']).map(normalizeOrigin).filter(Boolean));
    if (!normalized || !allowedOrigins.has(normalized)) {
      return { ok: false, status: 403, message: 'MCP browser origin is not allowed.' };
    }
  }

  return { ok: true };
}

function quoteWwwAuthenticateValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  try {
    const normalized = value.trim();
    const parsed = new URL(normalized);
    return parsed.origin === normalized ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return value.trim();
}

function normalizeOptionalUrl(value: string | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function qualifyOAuthScope(audience: string | undefined, scope: string): string {
  if (!audience || scope.includes('://')) return scope;
  return `${audience.replace(/\/$/, '')}/${scope.replace(/^\//, '')}`;
}

function isLocalRequestUrl(value: string): boolean {
  try {
    return isLoopbackUrl(new URL(value));
  } catch {
    return false;
  }
}

function parseRequestUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function singleHeaderValue(headers: Pick<Headers, 'get'>, name: string): { ok: true; value?: string } | { ok: false } {
  const raw = headers.get(name);
  if (raw === null) return { ok: true };
  const value = raw.trim();
  if (!value || value.includes(',')) return { ok: false };
  return { ok: true, value };
}

function normalizeAuthority(value: string, protocol: string): string | undefined {
  try {
    const url = new URL(`${protocol}//${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function isDeployableMcpOrigin(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    !isLoopbackHostname(hostname) &&
    !hostname.endsWith('.localhost') &&
    !isIpHostname(hostname)
  );
}

function isLoopbackOrigin(value: string): boolean {
  try {
    return isLoopbackUrl(new URL(value));
  } catch {
    return false;
  }
}

function isLoopbackUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    isLoopbackHostname(url.hostname)
  );
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isIpHostname(value: string): boolean {
  return isIP(value.replace(/^\[|\]$/g, '')) !== 0;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
