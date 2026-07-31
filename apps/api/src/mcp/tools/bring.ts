import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { AuthenticatedPrincipal } from '../../application/authorization/types.js';
import type { BringApplicationPort } from '../../application/operations/bring/application.js';
import { OPERATION_IDS } from '../../application/operations/registry.js';

type ToolSecurity = {
  securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }>;
  _meta: Record<string, unknown> & {
    securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }>;
  };
};

export interface BringToolRegistration {
  bring: BringApplicationPort;
  invocationId: string;
  requirePrincipal(operationId: string): Promise<AuthenticatedPrincipal | CallToolResult>;
  securityForOperations(operationIds: readonly string[]): ToolSecurity;
  run(operationId: string, action: () => Promise<CallToolResult>): Promise<CallToolResult>;
  invalidArgument(operationId: string, message: string): CallToolResult;
}

const nonEmptyText = (maxLength: number, description: string) =>
  z.string().trim().min(1).max(maxLength).describe(description);
const listUuidSchema = z
  .string()
  .uuid()
  .describe('Bring list UUID. Omit only for read operations to use the configured default list.')
  .optional();
const writeListUuidSchema = z.string().uuid().describe('Explicit writable own-list UUID.');
const operationIdSchema = z.string().uuid().describe('Caller-generated mutation UUID used for replay protection.');
const expectedListVersionSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('Optional list version returned by bring_get_items for optimistic concurrency.')
  .optional();
const itemInputSchema = z
  .object({
    name: nonEmptyText(200, 'Shopping item name.'),
    specification: z.string().max(500).optional(),
    uuid: z.string().uuid().optional(),
  })
  .strict();
const itemsInputSchema = {
  operationId: operationIdSchema,
  listUuid: writeListUuidSchema,
  expectedListVersion: expectedListVersionSchema,
  items: z.array(itemInputSchema).min(1).max(50),
};
const listsOutputSchema = z.object({
  source: z.literal('bring'),
  lists: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      theme: z.string().optional(),
      isDefault: z.boolean(),
      shared: z.boolean(),
    }),
  ),
});
const listOutputSchema = z.object({
  uuid: z.string(),
  name: z.string().optional(),
  version: z.string(),
  items: z.array(
    z.object({
      uuid: z.string().optional(),
      name: z.string(),
      specification: z.string().optional(),
      status: z.enum(['active', 'completed']),
    }),
  ),
});
const mutationOutputSchema = z.object({
  source: z.literal('bring'),
  listUuid: z.string(),
  operation: z.enum(['add', 'complete', 'remove']),
  operationId: z.string(),
  itemCount: z.number(),
  state: z.literal('succeeded'),
  replayed: z.boolean(),
});
const prepareResultOutputSchema = z.object({
  source: z.literal('bring'),
  state: z.enum(['prepared', 'succeeded']),
  operationId: z.string(),
  operation: z.enum(['complete', 'remove']),
  itemCount: z.number(),
  replayed: z.boolean(),
  listPseudonym: z.string().optional(),
  expiresAt: z.string().optional(),
  confirmationToken: z.string().optional(),
  listUuid: z.string().optional(),
});

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const addAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerBringTools(server: McpServer, options: BringToolRegistration): void {
  const security = (operationIds: readonly string[], invoking: string, invoked: string) =>
    withToolStatus(options.securityForOperations(operationIds), invoking, invoked);

  server.registerTool(
    'bring_list_lists',
    {
      title: 'Bring lists',
      description:
        'List normalized, explicitly readable Bring shopping lists. Never returns credentials, tokens, or raw account data.',
      inputSchema: {},
      outputSchema: listsOutputSchema,
      annotations: readAnnotations,
      ...security([OPERATION_IDS.bringListLists], 'Loading Bring lists…', 'Bring lists ready'),
    },
    async () => {
      const principal = await options.requirePrincipal(OPERATION_IDS.bringListLists);
      if (isToolResult(principal)) return principal;
      return options.run(OPERATION_IDS.bringListLists, async () => {
        const result = await options.bring.listLists();
        return textResult(result, `Found ${result.lists.length} readable Bring shopping lists.`);
      });
    },
  );

  server.registerTool(
    'bring_get_items',
    {
      title: 'Bring list items',
      description:
        'Read normalized items and a list-version digest. Omit listUuid only to use the configured readable default.',
      inputSchema: { listUuid: listUuidSchema },
      outputSchema: listOutputSchema,
      annotations: readAnnotations,
      ...security([OPERATION_IDS.bringGetItems], 'Loading Bring items…', 'Bring items ready'),
    },
    async ({ listUuid }) => {
      const principal = await options.requirePrincipal(OPERATION_IDS.bringGetItems);
      if (isToolResult(principal)) return principal;
      return options.run(OPERATION_IDS.bringGetItems, async () => {
        const result = await options.bring.getList(listUuid);
        return textResult(result, `Loaded ${result.items.length} Bring items.`);
      });
    },
  );

  server.registerTool(
    'bring_add_items',
    {
      title: 'Add Bring items',
      description:
        'Idempotently add 1–50 items to one explicitly writable, non-shared list. Generate a new operationId; retry only the identical payload with that ID.',
      inputSchema: itemsInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: addAnnotations,
      ...security([OPERATION_IDS.bringAddItems], 'Adding Bring items…', 'Bring items added'),
    },
    async ({ operationId, listUuid, expectedListVersion, items }) => {
      const principal = await options.requirePrincipal(OPERATION_IDS.bringAddItems);
      if (isToolResult(principal)) return principal;
      return options.run(OPERATION_IDS.bringAddItems, async () => {
        const result = await options.bring.addItems(
          principal,
          { operationId, listUuid, expectedListVersion, items },
          options.invocationId,
        );
        return textResult(result, `${result.replayed ? 'Replayed' : 'Added'} ${result.itemCount} Bring items.`);
      });
    },
  );

  server.registerTool(
    'bring_prepare_item_mutation',
    {
      title: 'Prepare Bring item mutation',
      description:
        'Validate, but do not execute, a complete or remove operation. Returns a pseudonymous summary and five-minute confirmation token without echoing item names.',
      inputSchema: {
        ...itemsInputSchema,
        operation: z.enum(['complete', 'remove']),
      },
      outputSchema: prepareResultOutputSchema,
      annotations: destructiveAnnotations,
      ...security(
        [OPERATION_IDS.bringPrepareComplete, OPERATION_IDS.bringPrepareRemove],
        'Preparing Bring mutation…',
        'Bring mutation prepared',
      ),
    },
    async ({ operationId, listUuid, expectedListVersion, operation, items }) => {
      const authOperationId =
        operation === 'complete' ? OPERATION_IDS.bringPrepareComplete : OPERATION_IDS.bringPrepareRemove;
      const principal = await options.requirePrincipal(authOperationId);
      if (isToolResult(principal)) return principal;
      return options.run(authOperationId, async () => {
        const result = await options.bring.prepareMutation(
          principal,
          { operationId, listUuid, expectedListVersion, operation, items },
          options.invocationId,
        );
        return textResult(
          result,
          result.state === 'prepared'
            ? `Prepared ${result.operation} for ${result.itemCount} Bring items; explicit confirmation is still required.`
            : `Mutation ${result.operationId} already succeeded.`,
        );
      });
    },
  );

  server.registerTool(
    'bring_apply_item_mutation',
    {
      title: 'Apply Bring item mutation',
      description:
        'Apply one prepared complete or remove operation using its identity- and payload-bound confirmation token. Never invent or substitute an operationId.',
      inputSchema: {
        operationId: operationIdSchema,
        listUuid: writeListUuidSchema,
        confirmationToken: nonEmptyText(4096, 'Confirmation token returned by bring_prepare_item_mutation.'),
      },
      outputSchema: mutationOutputSchema,
      annotations: destructiveAnnotations,
      ...security(
        [OPERATION_IDS.bringApplyComplete, OPERATION_IDS.bringApplyRemove],
        'Applying Bring mutation…',
        'Bring mutation applied',
      ),
    },
    async ({ operationId, listUuid, confirmationToken }) => {
      const operation = options.bring.getConfirmationOperation(confirmationToken);
      if (!operation)
        return options.invalidArgument(OPERATION_IDS.bringApplyComplete, 'confirmationToken is malformed.');
      const authOperationId =
        operation === 'complete' ? OPERATION_IDS.bringApplyComplete : OPERATION_IDS.bringApplyRemove;
      const principal = await options.requirePrincipal(authOperationId);
      if (isToolResult(principal)) return principal;
      return options.run(authOperationId, async () => {
        const result = await options.bring.applyMutation(
          principal,
          { operationId, listUuid, confirmationToken },
          options.invocationId,
        );
        return textResult(
          result,
          `${result.replayed ? 'Replayed' : 'Applied'} ${result.operation} for ${result.itemCount} Bring items.`,
        );
      });
    },
  );
}

function withToolStatus(security: ToolSecurity, invoking: string, invoked: string): ToolSecurity {
  return {
    ...security,
    _meta: {
      ...security._meta,
      'openai/toolInvocation/invoking': invoking,
      'openai/toolInvocation/invoked': invoked,
    },
  };
}

function textResult(structuredContent: object, text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

function isToolResult(value: AuthenticatedPrincipal | CallToolResult): value is CallToolResult {
  return Array.isArray((value as CallToolResult).content);
}
