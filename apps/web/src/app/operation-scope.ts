import type { ApiOperationDoc } from './openapi';
import type { BringMutationOperation } from './bring-confirmation';

export function resolveOperationScope(
  operation: ApiOperationDoc,
  configuredScope: string,
  bringMutationOperation?: BringMutationOperation,
): string {
  const requiredScope = bringMutationOperation
    ? findBringMutationScope(operation.requiredScopes, bringMutationOperation)
    : operation.requiredScopes[0];
  if (bringMutationOperation && !requiredScope) {
    throw new Error(`OpenAPI does not declare the bring.${bringMutationOperation} permission for ${operation.id}.`);
  }
  if (!requiredScope) return configuredScope;
  if (requiredScope.startsWith('api://') || requiredScope.startsWith('https://')) {
    return requiredScope;
  }
  const separator = configuredScope.lastIndexOf('/');
  return separator > 'api://'.length ? `${configuredScope.slice(0, separator + 1)}${requiredScope}` : requiredScope;
}

function findBringMutationScope(
  requiredScopes: readonly string[],
  operation: BringMutationOperation,
): string | undefined {
  const permission = `bring.${operation}`;
  return requiredScopes.find((scope) => scope === permission || scope.endsWith(`/${permission}`));
}
