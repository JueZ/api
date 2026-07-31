import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
  const configured = normalizeOrigin(env['MCP_RESOURCE_ORIGIN']);
  if (configured) return configured;

  if (getDeployedEnvironmentName(env) !== 'local') {
    throw new Error('MCP_RESOURCE_ORIGIN is required outside local development.');
  }

  if (request && isLocalRequestUrl(request.url)) {
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? request.headers.get('host')?.trim();
    if (host && isLocalHost(host)) {
      const proto =
        forwardedProto && forwardedProto.length > 0 ? forwardedProto : new URL(request.url).protocol.replace(':', '');
      return `${proto}://${host}`.replace(/\/$/, '');
    }
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
  if (environment === 'local') {
    const requestUrl = new URL(request.url);
    if (!isLocalHost(requestUrl.host)) {
      return { ok: false, status: 403, message: 'Local MCP requests must target localhost.' };
    }
    return { ok: true };
  }

  const canonicalOrigin = normalizeOrigin(env['MCP_RESOURCE_ORIGIN']);
  if (!canonicalOrigin) {
    return { ok: false, status: 400, message: 'MCP_RESOURCE_ORIGIN is not configured.' };
  }
  const canonical = new URL(canonicalOrigin);
  const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'));
  const host = firstHeaderValue(request.headers.get('host')) ?? new URL(request.url).host;
  const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'));
  if (host.toLowerCase() !== canonical.host.toLowerCase()) {
    return { ok: false, status: 403, message: 'MCP host is not allowed.' };
  }
  if (forwardedHost && forwardedHost.toLowerCase() !== canonical.host.toLowerCase()) {
    return { ok: false, status: 403, message: 'MCP forwarded host is not allowed.' };
  }
  if (new URL(request.url).protocol !== canonical.protocol) {
    return { ok: false, status: 403, message: 'MCP request scheme is not allowed.' };
  }
  if (forwardedProto && `${forwardedProto.toLowerCase()}:` !== canonical.protocol) {
    return { ok: false, status: 403, message: 'MCP forwarded scheme is not allowed.' };
  }

  const originHeader = request.headers.get('origin');
  if (originHeader) {
    const normalized = normalizeOrigin(originHeader);
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

function firstHeaderValue(value: string | null): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

function isLocalRequestUrl(value: string): boolean {
  try {
    return isLocalHost(new URL(value).host);
  } catch {
    return false;
  }
}

function isLocalHost(value: string): boolean {
  const hostname = value.replace(/:\d+$/, '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
