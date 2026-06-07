import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { authorizeBearerToken, readAuthConfig, type AuthenticatedUser, type AuthorizationResult } from '../shared/security/auth.js';

export const MCP_SCOPE = 'api.access';
export const MCP_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export type McpAuthChallengeError = 'invalid_token' | 'insufficient_scope';

export interface McpWwwAuthenticateOptions {
  error: McpAuthChallengeError;
  errorDescription: string;
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

  if (request) {
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? request.headers.get('host')?.trim();
    if (host) {
      const proto = forwardedProto && forwardedProto.length > 0 ? forwardedProto : new URL(request.url).protocol.replace(':', '');
      return `${proto}://${host}`.replace(/\/$/, '');
    }
    return new URL(request.url).origin;
  }

  return 'http://localhost:7071';
}

export function getMcpOAuthScope(env: NodeJS.ProcessEnv = process.env): string {
  const configured = normalizeOptionalString(env['MCP_OAUTH_SCOPE']);
  if (configured) return configured;

  return qualifyOAuthScope(readAuthConfig(env).audience, MCP_SCOPE);
}

export function buildMcpProtectedResourceMetadata(request?: HttpRequest, env: NodeJS.ProcessEnv = process.env): McpProtectedResourceMetadata {
  const authConfig = readAuthConfig(env);
  const authorizationServers = (authConfig.issuers && authConfig.issuers.length > 0)
    ? authConfig.issuers
    : authConfig.issuer ? [authConfig.issuer] : [];
  const documentation = normalizeOptionalUrl(env['MCP_RESOURCE_DOCUMENTATION_URL']);
  return {
    resource: authConfig.audience ?? getMcpResourceOrigin(request, env),
    authorization_servers: authorizationServers,
    scopes_supported: [getMcpOAuthScope(env)],
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
    ['scope', getMcpOAuthScope(env)],
    ['error', options.error],
    ['error_description', options.errorDescription],
  ];
  return `Bearer ${parameters.map(([key, value]) => `${key}="${quoteWwwAuthenticateValue(value)}"`).join(', ')}`;
}

export async function authorizeMcpTool(
  authorizationHeader: string | null | undefined,
  context: InvocationContext,
): Promise<AuthorizationResult> {
  return authorizeBearerToken(authorizationHeader, context);
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

export function safeUser(user: AuthenticatedUser): { subject: string; objectId?: string; tenantId?: string } {
  return {
    subject: user.subject,
    ...(user.objectId ? { objectId: user.objectId } : {}),
    ...(user.tenantId ? { tenantId: user.tenantId } : {}),
  };
}

function quoteWwwAuthenticateValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return value.replace(/\/$/, '');
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
