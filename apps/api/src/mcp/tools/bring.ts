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

const listUuidSchema = z
  .string()
  .uuid()
  .describe('Bring list UUID. Omit only for read operations to use the configured default list.')
  .optional();
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

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
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
