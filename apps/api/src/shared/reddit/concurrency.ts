import { createHash } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../../application/authorization/types.js';

const activePrincipalRequests = new Set<string>();

export class RedditPrincipalConcurrencyError extends Error {
  readonly status = 429;

  constructor() {
    super('Another Reddit expansion request is already in progress for this principal.');
    this.name = 'RedditPrincipalConcurrencyError';
  }
}

export async function withRedditPrincipalConcurrency<T>(
  principal: AuthenticatedPrincipal,
  operation: () => Promise<T>,
): Promise<T> {
  const key = principalConcurrencyKey(principal);
  if (activePrincipalRequests.has(key)) throw new RedditPrincipalConcurrencyError();
  activePrincipalRequests.add(key);
  try {
    return await operation();
  } finally {
    activePrincipalRequests.delete(key);
  }
}

function principalConcurrencyKey(principal: AuthenticatedPrincipal): string {
  return createHash('sha256')
    .update(
      [
        principal.tokenType,
        principal.tenantId ?? '',
        principal.objectId ?? '',
        principal.subject,
        principal.clientId ?? '',
      ].join('\u0000'),
    )
    .digest('hex');
}
