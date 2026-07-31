import type { AuthenticatedPrincipal, OperationAuthorizationDecision, OperationAuthorizationPolicy } from './types.js';

export function authorizeOperation(
  principal: AuthenticatedPrincipal,
  policy: OperationAuthorizationPolicy,
): OperationAuthorizationDecision {
  if (policy.environment && policy.allowedEnvironments && !policy.allowedEnvironments.includes(policy.environment)) {
    return { ok: false, reason: 'environment_not_allowed' };
  }

  if (!policy.allowedTokenTypes.includes(principal.tokenType)) {
    return { ok: false, reason: 'token_type_not_allowed' };
  }

  const grantedPermissions = new Set([...principal.scopes, ...principal.roles]);
  if (!grantedPermissions.has(policy.permission)) {
    return { ok: false, reason: 'missing_permission' };
  }

  return { ok: true };
}
