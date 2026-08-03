import type * as z from 'zod/v4';
import type { Permission, TokenType } from '../authorization/types.js';

export type OperationProvider = 'local' | 'reddit' | 'wlh' | 'bring';
export type OperationEffect = 'read' | 'write' | 'destructive';
export type RuntimeEnvironment = 'local' | 'test' | 'prod';
export type IdempotencyPolicy = 'required' | 'not-applicable';
export type ConfirmationPolicy = 'required' | 'not-applicable';

export interface OperationAuditPolicy {
  enabled: boolean;
  includeItemCount: boolean;
  includeResourcePseudonym: boolean;
}

export interface OperationDefinition<Input = unknown, Output = unknown> {
  id: string;
  provider: OperationProvider;
  effect: OperationEffect;
  requiredPermission?: Permission;
  allowedTokenTypes: readonly TokenType[];
  allowedEnvironments: readonly RuntimeEnvironment[];
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  idempotency: IdempotencyPolicy;
  confirmation: ConfirmationPolicy;
  audit: OperationAuditPolicy;
  rest?: { method: 'GET' | 'POST'; path: string };
  mcp?: { toolName: string };
  gptActions: boolean;
}
