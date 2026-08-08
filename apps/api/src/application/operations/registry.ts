import * as z from 'zod/v4';
import type { OperationDefinition } from './types.js';

const noInput = z.object({}).strict();
const unknownOutput = z.unknown();
const readAudit = { enabled: true, includeItemCount: false, includeResourcePseudonym: false } as const;
const mutationAudit = { enabled: true, includeItemCount: true, includeResourcePseudonym: true } as const;
const allEnvironments = ['local', 'test', 'prod'] as const;
const userAndService = ['user', 'service'] as const;
const userOnly = ['user'] as const;

export const OPERATION_IDS = {
  health: 'local.health',
  hello: 'local.hello',
  redditThread: 'reddit.thread',
  redditThreadOverview: 'reddit.thread-overview',
  redditThreadComments: 'reddit.thread-comments',
  redditCommentTree: 'reddit.comment-tree',
  redditCommentsBatch: 'reddit.comments-batch',
  wlhCategories: 'wlh.categories',
  wlhCategory: 'wlh.category',
  wlhFindCategory: 'wlh.find-category',
  wlhCategoryChildren: 'wlh.category-children',
  wlhSearch: 'wlh.search',
  wlhOffer: 'wlh.offer',
  wlhOfferImages: 'wlh.offer-images',
  bringListLists: 'bring.list-lists',
  bringGetItems: 'bring.get-items',
  bringAddItems: 'bring.add-items',
  bringPrepareComplete: 'bring.prepare-complete-items',
  bringPrepareRemove: 'bring.prepare-remove-items',
  bringApplyComplete: 'bring.apply-complete-items',
  bringApplyRemove: 'bring.apply-remove-items',
} as const;

const definitions = [
  define({
    id: OPERATION_IDS.health,
    provider: 'local',
    effect: 'read',
    allowedTokenTypes: userAndService,
    allowedEnvironments: allEnvironments,
    inputSchema: noInput,
    outputSchema: unknownOutput,
    idempotency: 'not-applicable',
    confirmation: 'not-applicable',
    audit: { ...readAudit, enabled: false },
    rest: { method: 'GET', path: '/health' },
    mcp: { toolName: 'health_check' },
  }),
  defineRead(OPERATION_IDS.hello, 'local', 'catalogue.read', {
    rest: { method: 'GET', path: '/api/hello' },
    mcp: { toolName: 'hello_authenticated' },
  }),
  defineRead(OPERATION_IDS.redditThread, 'reddit', 'reddit.read', {
    rest: { method: 'POST', path: '/api/reddit/thread' },
    mcp: { toolName: 'reddit_get_thread' },
  }),
  defineRead(OPERATION_IDS.redditThreadOverview, 'reddit', 'reddit.read', {
    rest: { method: 'POST', path: '/api/reddit/thread/overview' },
    mcp: { toolName: 'reddit_get_thread_overview' },
  }),
  defineRead(OPERATION_IDS.redditThreadComments, 'reddit', 'reddit.read', {
    rest: { method: 'POST', path: '/api/reddit/thread/comments' },
  }),
  defineRead(OPERATION_IDS.redditCommentTree, 'reddit', 'reddit.read', {
    rest: { method: 'POST', path: '/api/reddit/comment-tree' },
  }),
  defineRead(OPERATION_IDS.redditCommentsBatch, 'reddit', 'reddit.read', {
    rest: { method: 'POST', path: '/api/reddit/comments/batch' },
  }),
  defineRead(OPERATION_IDS.wlhCategories, 'wlh', 'wlh.read', {
    rest: { method: 'GET', path: '/api/wlh/categories/top' },
    mcp: { toolName: 'wlh_categories_top' },
  }),
  defineRead(OPERATION_IDS.wlhCategory, 'wlh', 'wlh.read', {
    rest: { method: 'GET', path: '/api/wlh/categories/{categoryId}' },
  }),
  defineRead(OPERATION_IDS.wlhFindCategory, 'wlh', 'wlh.read', {
    mcp: { toolName: 'wlh_find_category' },
  }),
  defineRead(OPERATION_IDS.wlhCategoryChildren, 'wlh', 'wlh.read', {
    rest: {
      method: 'GET',
      path: '/api/wlh/categories/{categoryId}/children',
    },
    mcp: { toolName: 'wlh_category_children' },
  }),
  defineRead(OPERATION_IDS.wlhSearch, 'wlh', 'wlh.read', {
    rest: { method: 'POST', path: '/api/wlh/search' },
    mcp: { toolName: 'wlh_search' },
  }),
  defineRead(OPERATION_IDS.wlhOffer, 'wlh', 'wlh.read', {
    rest: { method: 'GET', path: '/api/wlh/offers/{adId}' },
    mcp: { toolName: 'wlh_get_offer' },
  }),
  defineRead(OPERATION_IDS.wlhOfferImages, 'wlh', 'wlh.read', {
    rest: { method: 'GET', path: '/api/wlh/offers/{adId}/images' },
  }),
  defineRead(OPERATION_IDS.bringListLists, 'bring', 'bring.read', {
    rest: { method: 'GET', path: '/api/bring/lists' },
    mcp: { toolName: 'bring_list_lists' },
  }),
  defineRead(OPERATION_IDS.bringGetItems, 'bring', 'bring.read', {
    rest: { method: 'GET', path: '/api/bring/lists/{listUuid}/items' },
    mcp: { toolName: 'bring_get_items' },
  }),
  define({
    id: OPERATION_IDS.bringAddItems,
    provider: 'bring',
    effect: 'write',
    requiredPermission: 'bring.write',
    allowedTokenTypes: userAndService,
    allowedEnvironments: ['local', 'prod'],
    inputSchema: z.unknown(),
    outputSchema: unknownOutput,
    idempotency: 'required',
    confirmation: 'not-applicable',
    audit: mutationAudit,
    rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/items' },
    mcp: { toolName: 'bring_add_item' },
  }),
  define({
    id: OPERATION_IDS.bringPrepareComplete,
    provider: 'bring',
    effect: 'destructive',
    requiredPermission: 'bring.complete',
    allowedTokenTypes: userOnly,
    allowedEnvironments: ['local', 'prod'],
    inputSchema: z.unknown(),
    outputSchema: unknownOutput,
    idempotency: 'required',
    confirmation: 'required',
    audit: mutationAudit,
    rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/mutations/prepare' },
  }),
  define({
    id: OPERATION_IDS.bringPrepareRemove,
    provider: 'bring',
    effect: 'destructive',
    requiredPermission: 'bring.remove',
    allowedTokenTypes: userOnly,
    allowedEnvironments: ['local', 'prod'],
    inputSchema: z.unknown(),
    outputSchema: unknownOutput,
    idempotency: 'required',
    confirmation: 'required',
    audit: mutationAudit,
    rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/mutations/prepare' },
  }),
  define({
    id: OPERATION_IDS.bringApplyComplete,
    provider: 'bring',
    effect: 'destructive',
    requiredPermission: 'bring.complete',
    allowedTokenTypes: userOnly,
    allowedEnvironments: ['local', 'prod'],
    inputSchema: z.unknown(),
    outputSchema: unknownOutput,
    idempotency: 'required',
    confirmation: 'required',
    audit: mutationAudit,
    rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/mutations/apply' },
  }),
  define({
    id: OPERATION_IDS.bringApplyRemove,
    provider: 'bring',
    effect: 'destructive',
    requiredPermission: 'bring.remove',
    allowedTokenTypes: userOnly,
    allowedEnvironments: ['local', 'prod'],
    inputSchema: z.unknown(),
    outputSchema: unknownOutput,
    idempotency: 'required',
    confirmation: 'required',
    audit: mutationAudit,
    rest: { method: 'POST', path: '/api/bring/lists/{listUuid}/mutations/apply' },
  }),
] as const satisfies readonly OperationDefinition[];

const registry = new Map(definitions.map((definition) => [definition.id, definition]));

export function getOperationDefinition(operationId: string): OperationDefinition {
  const definition = registry.get(operationId);
  if (!definition) throw new Error(`Unknown operation: ${operationId}`);
  return definition;
}

export function listOperationDefinitions(): readonly OperationDefinition[] {
  return definitions;
}

function define<Input, Output>(definition: OperationDefinition<Input, Output>): OperationDefinition<Input, Output> {
  return definition;
}

function defineRead(
  id: string,
  provider: 'local' | 'reddit' | 'wlh' | 'bring',
  requiredPermission: 'catalogue.read' | 'reddit.read' | 'wlh.read' | 'bring.read',
  transports: Pick<OperationDefinition, 'rest' | 'mcp'>,
): OperationDefinition {
  return define({
    id,
    provider,
    effect: 'read',
    requiredPermission,
    allowedTokenTypes: userAndService,
    allowedEnvironments: allEnvironments,
    inputSchema: z.unknown(),
    outputSchema: unknownOutput,
    idempotency: 'not-applicable',
    confirmation: 'not-applicable',
    audit: readAudit,
    ...transports,
  });
}
