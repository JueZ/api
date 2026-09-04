export const PERMISSIONS = [
  'catalogue.read',
  'reddit.read',
  'youtube.read',
  'wlh.read',
  'weather.read',
  'bring.read',
  'bring.write',
  'bring.complete',
  'bring.remove',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type TokenType = 'user' | 'service';

export interface AuthenticatedPrincipal {
  subject: string;
  objectId?: string;
  tenantId?: string;
  clientId?: string;
  tokenType: TokenType;
  scopes: string[];
  roles: string[];
}

export interface OperationAuthorizationPolicy {
  permission: Permission;
  allowedTokenTypes: readonly TokenType[];
  environment?: 'local' | 'test' | 'prod';
  allowedEnvironments?: readonly ('local' | 'test' | 'prod')[];
}

export type OperationAuthorizationDecision =
  { ok: true } | { ok: false; reason: 'missing_permission' | 'token_type_not_allowed' | 'environment_not_allowed' };
