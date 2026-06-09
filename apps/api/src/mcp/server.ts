import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { createHealthResponse, createHelloResponse } from '../shared/responses.js';
import { RedditThreadService } from '../shared/reddit/service.js';
import type { RedditThreadOverviewRequest, RedditThreadRequest } from '../shared/reddit/types.js';
import { WlhService } from '../shared/wlh/service.js';
import { authorizeMcpTool, buildMcpWwwAuthenticate, getMcpOAuthScope, mcpAuthErrorResult, safeUser, type McpAuthChallengeError } from './auth.js';

export interface McpGatewayServices {
  reddit: Pick<RedditThreadService, 'fetchThread' | 'fetchThreadOverview'>;
  wlh: Pick<WlhService, 'search' | 'offer' | 'topCategories' | 'children'>;
}

export interface McpRequestOptions {
  authorizationHeader?: string | null;
  context: InvocationContext;
  request?: HttpRequest;
  services?: McpGatewayServices;
}

const MCP_VERSION = '0.1.0';
const jsonRpcContentType = 'application/json';
const maxMcpComments = 50;
const maxCommentBodyChars = 800;
const maxCategoryMatches = 10;
const maxCategoryScan = 200;

const serverInstructions = [
  'This private API catalogue MCP server exposes read-only Reddit and Willhaben tools for the authenticated operator.',
  'For Reddit analysis, call reddit_get_thread_overview first; call reddit_get_thread only when comment bodies or a fuller snapshot are needed.',
  'For a specific Willhaben URL or ad ID, call wlh_get_offer directly. For broad Willhaben searches, call wlh_find_category if the category is unclear, then wlh_search, then wlh_get_offer for selected listings.',
  'Do not use these tools for unrelated requests such as weather, reminders, public web browsing outside Reddit/Willhaben, or write/destructive actions.',
].join('\n');

const redditSortSchema = z.enum(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);
const wlhConditionSchema = z.enum(['new', 'like_new', 'used', 'defect']);
const wlhDeliverySchema = z.enum(['pickup', 'shipping']);
const wlhSortSchema = z.enum(['relevance', 'price_asc', 'price_desc', 'newest']);
const noauthSecuritySchemes = [{ type: 'noauth' }];
const localOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const externalReadOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const nonEmptyText = (maxLength: number, description: string) => z.string().trim().min(1).max(maxLength).describe(description);
const redditPostIdSchema = nonEmptyText(32, 'Reddit post ID/base36 fullname ID. Provide this instead of url; do not provide both.');
const redditUrlSchema = nonEmptyText(2048, 'Reddit post URL or supported reddit.com/redd.it share URL. Provide this instead of postId; do not provide both.');
const wlhAdIdSchema = nonEmptyText(32, 'Numeric Willhaben advertisement ID. Provide this instead of url; do not provide both.');
const wlhUrlSchema = nonEmptyText(2048, 'Willhaben listing URL. Provide this instead of adId; do not provide both.');
const isoDateLikeSchema = nonEmptyText(40, 'ISO date or datetime lower bound for listing recency, for example 2026-06-01 or 2026-06-01T12:30:00Z.');
const finiteNumber = (description: string) => z.number().finite().describe(description);
const nullableNumber = z.number().finite().nullable();
const healthToolSecurity = toolSecurityWithStatus(noauthSecuritySchemes, 'Checking API…', 'API reachable');

const categorySchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  depth: z.number(),
  parentId: z.string().optional(),
  hitCount: z.number().optional(),
  hasChildren: z.boolean(),
  url: z.string().optional(),
});
const healthOutputSchema = z.object({
  service: z.literal('api-catalogue'),
  status: z.literal('ok'),
  timestamp: z.string(),
  environmentName: z.string(),
  deployedCommitSha: z.string(),
  deployedSourceRef: z.string(),
  deploymentRunId: z.string(),
  deployedAtUtc: z.string(),
  buildTimestampUtc: z.string(),
  mcpGateway: z.object({ endpoint: z.string(), version: z.string() }),
});
const helloOutputSchema = z.object({
  message: z.literal('Hello, Martin'),
  authenticated: z.literal(true),
  user: z.object({ subject: z.string(), objectId: z.string().optional(), tenantId: z.string().optional() }),
});
const redditPostSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  subreddit: z.string().optional(),
  author: z.string().optional(),
  url: z.string().optional(),
  permalink: z.string().optional(),
  score: z.number().optional(),
  commentCount: z.number().optional(),
  createdUtc: z.number().optional(),
  over18: z.boolean().optional(),
  locked: z.boolean().optional(),
  archived: z.boolean().optional(),
});
const redditCommentSummarySchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  author: z.string().optional(),
  body: z.string(),
  score: z.number().optional(),
  depth: z.number().optional(),
  createdUtc: z.number().optional(),
  permalink: z.string().optional(),
  truncated: z.boolean(),
});
const redditContinuationSchema = z.object({ parentId: z.string(), childCount: z.number(), depth: z.number().optional() });
const redditThreadStatsSchema = z.object({
  commentsReturned: z.number(),
  upstreamCommentsReturned: z.number().optional(),
  modelCommentsReturned: z.number(),
  modelCommentLimit: z.number(),
  bodyCharLimit: z.number(),
  modelTruncated: z.boolean(),
  truncated: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});
const redditThreadOutputSchema = z.object({
  source: z.literal('reddit'),
  fetchedAt: z.string().optional(),
  input: z.string().optional(),
  post: redditPostSummarySchema,
  comments: z.array(redditCommentSummarySchema),
  continuations: z.array(redditContinuationSchema),
  stats: redditThreadStatsSchema,
});
const redditOverviewOutputSchema = z.object({
  source: z.literal('reddit'),
  fetchedAt: z.string().optional(),
  input: z.string().optional(),
  post: redditPostSummarySchema,
  stats: z.object({ topLevelComments: z.number().optional(), maxDepth: z.number().optional(), deletedCount: z.number().optional(), loadedSnapshotCommentCount: z.number() }),
  coverage: z.object({ reportedTotal: z.number().optional(), uniqueReturned: z.number().optional(), knownRemaining: z.number().optional(), snapshotComplete: z.boolean().optional() }).optional(),
  availableSorts: z.array(redditSortSchema).optional(),
});
const wlhListingSchema = z.object({
  id: z.string(),
  title: z.string(),
  priceAmount: nullableNumber.optional(),
  priceDisplay: z.string().optional(),
  location: z.string().optional(),
  postcode: z.string().optional(),
  state: z.string().optional(),
  url: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  sellerId: z.string().optional(),
  paylivery: z.boolean().nullable().optional(),
  publishedAt: z.string().optional(),
  imageCount: z.number().optional(),
});
const wlhSearchQuerySchema = z.object({
  keyword: z.string().optional(),
  categoryId: z.string().optional(),
  categoryPath: z.string().optional(),
  locationText: z.string().optional(),
  postcode: z.string().optional(),
  priceFrom: z.number().optional(),
  priceTo: z.number().optional(),
  areaId: z.string().optional(),
  paylivery: z.boolean().optional(),
  rows: z.number().optional(),
  page: z.number().optional(),
  condition: wlhConditionSchema.optional(),
  delivery: z.array(wlhDeliverySchema).optional(),
  requiredTerms: z.array(z.string()).optional(),
  sort: wlhSortSchema.optional(),
  postedSince: z.string().optional(),
  imageRequired: z.boolean().optional(),
});
const wlhFilterApplicationSchema = z.object({
  field: z.string(),
  appliedAs: z.enum(['sent_to_wlh', 'category_inference', 'service_post_filter', 'mcp_post_filter', 'mcp_post_sort']),
  effective: z.boolean(),
  note: z.string().optional(),
});
const wlhSearchOutputSchema = z.object({
  source: z.literal('wlh'),
  query: wlhSearchQuerySchema,
  totalApprox: nullableNumber,
  rowsReturned: z.number(),
  filteredRowsReturned: z.number(),
  category: categorySchema.optional(),
  results: z.array(wlhListingSchema),
  filterApplications: z.array(wlhFilterApplicationSchema),
  sourceUrl: z.string().optional(),
  fetchedAt: z.string().optional(),
});
const wlhOfferImageSchema = z.object({ id: z.string().optional(), thumb: z.string().optional(), preview: z.string().optional(), full: z.string().optional() });
const wlhOfferOutputSchema = z.object({
  source: z.literal('wlh'),
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priceAmount: nullableNumber.optional(),
  priceDisplay: z.string().optional(),
  location: z.string().optional(),
  postcode: z.string().optional(),
  state: z.string().optional(),
  url: z.string().optional(),
  status: z.string().optional(),
  seller: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
  paylivery: z.boolean(),
  deliveryOptions: z.array(z.object({ carrier: z.string().optional(), parcelSize: z.string().optional(), price: z.unknown().optional(), description: z.string().optional() })),
  images: z.array(wlhOfferImageSchema),
  publishedAt: z.string().optional(),
  changedAt: z.string().optional(),
});
const wlhCategoriesOutputSchema = z.object({ source: z.literal('wlh'), categories: z.array(categorySchema) });
const wlhCategoryChildrenOutputSchema = z.object({ source: z.literal('wlh'), categoryId: z.string(), categories: z.array(categorySchema) });
const wlhFindCategoryOutputSchema = z.object({ source: z.literal('wlh'), query: z.string(), matches: z.array(categorySchema.extend({ score: z.number() })) });

const wlhSearchInputSchema = z.object({
  keyword: nonEmptyText(120, 'Search keywords. Omit only when categoryId/categoryPath and filters are enough.').optional(),
  categoryId: nonEmptyText(40, 'Willhaben category ID from wlh_find_category or category tools. Optional; inferred from keyword/categoryPath when omitted.').optional(),
  categoryPath: nonEmptyText(200, 'Human-readable category path or category words used to infer a categoryId when categoryId is omitted.').optional(),
  locationText: nonEmptyText(120, 'Location text such as Wien or Graz. Applied as an MCP post-filter against returned listing location, postcode, and state fields; not sent to WLH.').optional(),
  postcode: nonEmptyText(16, 'Austrian postcode or short postal prefix. Applied as an MCP post-filter against returned listing postcode; not sent to WLH.').optional(),
  priceFrom: finiteNumber('Minimum price in EUR. Must be non-negative and no greater than priceTo.').optional(),
  priceTo: finiteNumber('Maximum price in EUR. Must be non-negative and no less than priceFrom.').optional(),
  areaId: nonEmptyText(40, 'WLH area/location ID if known.').optional(),
  paylivery: z.boolean().describe('When true, prefer offers with PayLivery.').optional(),
  rows: z.number().int().positive().max(100).describe('Maximum rows requested from WLH; max 100.').optional(),
  page: z.number().int().positive().describe('One-based result page. Defaults to service behavior when omitted.').optional(),
  condition: wlhConditionSchema.describe('Condition filter: new, like_new, used, or defect.').optional(),
  delivery: z.array(wlhDeliverySchema).max(2).describe('Delivery preferences: pickup, shipping, or both.').optional(),
  requiredTerms: z.array(nonEmptyText(60, 'A term that must appear in model-visible search matching.')).max(8).describe('Terms that must appear in a listing. Maximum 8 terms, 60 characters each.').optional(),
  sort: wlhSortSchema.describe('MCP post-sort for the returned page only. WLH global result ordering is not changed.').optional(),
  postedSince: isoDateLikeSchema.describe('MCP post-filter against returned listing publishedAt values; not sent to WLH.').optional(),
  imageRequired: z.boolean().describe('When true, MCP post-filters returned listings to those with imageCount greater than 0; not sent to WLH.').optional(),
}).strict();

export function createPrivateMcpServer(options: McpRequestOptions): McpServer {
  const server = new McpServer({ name: 'api-catalogue-private-mcp', version: MCP_VERSION }, { instructions: serverInstructions });
  const services = options.services ?? defaultServices();
  const protectedToolSecurity = createProtectedToolSecurity();
  async function requireAuth(): Promise<CallToolResult | undefined> {
    const auth = await authorizeMcpTool(options.authorizationHeader, options.context);
    if (!auth.ok) {
      return mcpAuthorizationFailureResult(auth, options.request);
    }
    return undefined;
  }

  server.registerTool(
    'health_check',
    {
      title: 'Health check',
      description: 'Use this when you need to verify that the private MCP gateway and API catalogue are reachable. Returns public health/build metadata only; do not use it for private Reddit or Willhaben data.',
      inputSchema: {},
      outputSchema: healthOutputSchema,
      annotations: localOnlyAnnotations,
      ...healthToolSecurity,
    },
    async () => {
      const health = createHealthResponse();
      const structuredContent = { ...health, mcpGateway: { endpoint: '/mcp', version: MCP_VERSION } };
      return textResult(structuredContent, `API catalogue MCP gateway is ${health.status}.`);
    },
  );

  server.registerTool(
    'hello_authenticated',
    {
      title: 'Hello authenticated',
      description: 'Use this when you need to verify that ChatGPT OAuth linking works for the protected API. Returns only a safe user shape; do not use it for Reddit or Willhaben content.',
      inputSchema: {},
      outputSchema: helloOutputSchema,
      annotations: localOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Checking OAuth…', 'OAuth verified'),
    },
    async () => {
      const auth = await authorizeMcpTool(options.authorizationHeader, options.context);
      if (!auth.ok) return mcpAuthorizationFailureResult(auth, options.request);
      const structuredContent = createHelloResponse(safeUser(auth.user));
      return textResult(structuredContent, 'OAuth linking succeeded for the private API catalogue.');
    },
  );

  server.registerTool(
    'reddit_get_thread',
    {
      title: 'Reddit thread snapshot',
      description: 'Use this when the user asks for Reddit comment bodies, full thread analysis, source extraction, sentiment, named entities, or representative comments. Prefer reddit_get_thread_overview first unless comments are needed.',
      inputSchema: {
        postId: redditPostIdSchema.optional(),
        url: redditUrlSchema.optional(),
        sort: redditSortSchema.describe('Reddit comment sort. Defaults to the existing service default when omitted.').optional(),
        maxComments: z.number().int().positive().max(500).describe('Maximum comments requested from the Reddit service; MCP still returns a bounded model-readable subset.').optional(),
        maxMoreChildrenRequests: z.number().int().min(0).max(500).describe('Maximum Reddit MoreChildren expansion requests. Use 0 to avoid expansion.').optional(),
      },
      outputSchema: redditThreadOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Reading comments…', 'Reddit thread ready'),
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const request = toRedditThreadRequest(args);
      if (isToolErrorResult(request)) return request;
      return await withToolErrorBoundary('reddit', async () => {
        const response = await services.reddit.fetchThread(request);
        const structuredContent = toMcpRedditThread(response);
        return textResult(structuredContent, summarizeRedditThread(structuredContent));
      });
    },
  );

  server.registerTool(
    'reddit_get_thread_overview',
    {
      title: 'Reddit thread overview',
      description: 'Use this first when the user provides a Reddit post URL or asks what a thread is about. Returns compact post, coverage, and count metadata without full comment bodies; do not use for detailed comment analysis.',
      inputSchema: {
        postId: redditPostIdSchema.optional(),
        url: redditUrlSchema.optional(),
        sort: redditSortSchema.describe('Reddit comment sort used for the lightweight overview snapshot.').optional(),
        maxComments: z.number().int().positive().max(500).describe('Maximum comments requested for overview metadata.').optional(),
      },
      outputSchema: redditOverviewOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Reading Reddit…', 'Reddit overview ready'),
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const request = toRedditOverviewRequest(args);
      if (isToolErrorResult(request)) return request;
      return await withToolErrorBoundary('reddit', async () => {
        const response = await services.reddit.fetchThreadOverview(request);
        const structuredContent = toMcpRedditOverview(response);
        return textResult(structuredContent, `Fetched Reddit thread overview ${String(asRecord(structuredContent['post'])['id'] ?? '')}: ${String(asRecord(structuredContent['stats'])['loadedSnapshotCommentCount'] ?? 'unknown')} loaded comments.`);
      });
    },
  );

  server.registerTool(
    'wlh_find_category',
    {
      title: 'WLH find category',
      description: 'Use this when the user describes a Willhaben category in natural language and no categoryId is known. Returns likely category IDs for follow-up wlh_search calls; do not use for offer details.',
      inputSchema: { query: nonEmptyText(120, 'Natural-language Willhaben category description, for example bikes, webcams, or sofas.'), limit: z.number().int().positive().max(maxCategoryMatches).describe('Maximum category matches to return; defaults to 10.').optional() },
      outputSchema: wlhFindCategoryOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Finding category…', 'Categories found'),
    },
    async ({ query, limit }) => {
      const authError = await requireAuth();
      if (authError) return authError;
      return await withToolErrorBoundary('wlh', async () => {
        const matches = await findWlhCategories(services.wlh, query, limit ?? maxCategoryMatches);
        return textResult({ source: 'wlh', query, matches }, `Found ${matches.length} WLH category matches for "${query}".`);
      });
    },
  );

  server.registerTool(
    'wlh_search',
    {
      title: 'WLH search',
      description: 'Use this when the user wants to find Willhaben offers by keyword, price, category, location, condition, PayLivery, delivery preference, recency, image presence, or visible postcode/location text. Use wlh_find_category first when the category is unclear; use wlh_get_offer for a specific listing.',
      inputSchema: wlhSearchInputSchema,
      outputSchema: wlhSearchOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Searching Willhaben…', 'Willhaben results ready'),
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const validationError = validateWlhSearchArgs(args);
      if (validationError) return validationError;
      return await withToolErrorBoundary('wlh', async () => {
        const searchRequest = await toWlhSearchRequest(services.wlh, args);
        const response = await services.wlh.search(searchRequest);
        const structuredContent = toMcpWlhSearch(response, args, searchRequest);
        return textResult(structuredContent, summarizeWlhSearch(structuredContent));
      });
    },
  );

  server.registerTool(
    'wlh_get_offer',
    {
      title: 'WLH offer detail',
      description: 'Use this when the user asks to analyze, price-check, summarize, inspect, or compare a specific Willhaben listing. Accepts either a Willhaben ad ID or URL. Do not use it for broad searches; use wlh_search first.',
      inputSchema: { adId: wlhAdIdSchema.optional(), url: wlhUrlSchema.optional() },
      outputSchema: wlhOfferOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Loading offer…', 'Offer loaded'),
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const adId = extractWlhAdId(args);
      if (isToolErrorResult(adId)) return adId;
      return await withToolErrorBoundary('wlh', async () => {
        const response = await services.wlh.offer(adId);
        const structuredContent = toMcpWlhOffer(response, adId, args.url);
        return textResult(structuredContent, `Fetched WLH offer ${String(structuredContent['id'])}: ${String(structuredContent['title'] || 'untitled offer')}.`);
      });
    },
  );

  server.registerTool(
    'wlh_categories_top',
    {
      title: 'WLH top categories',
      description: 'Use this when the user wants to browse top-level Willhaben categories. For natural-language category lookup, prefer wlh_find_category.',
      inputSchema: {},
      outputSchema: wlhCategoriesOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Loading categories…', 'Categories ready'),
    },
    async () => {
      const authError = await requireAuth();
      if (authError) return authError;
      return await withToolErrorBoundary('wlh', async () => {
        const categories = (await services.wlh.topCategories()).map(toMcpWlhCategory).filter((category) => category.id.length > 0);
        const structuredContent = { source: 'wlh', categories };
        return textResult(structuredContent, `Fetched ${categories.length} top WLH categories.`);
      });
    },
  );

  server.registerTool(
    'wlh_category_children',
    {
      title: 'WLH category children',
      description: 'Use this when you already have a Willhaben categoryId and need its child categories before searching. Do not use for offer details.',
      inputSchema: { categoryId: nonEmptyText(40, 'Willhaben category ID returned by wlh_categories_top, wlh_category_children, or wlh_find_category.') },
      outputSchema: wlhCategoryChildrenOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...withToolStatus(protectedToolSecurity, 'Loading subcategories…', 'Subcategories ready'),
    },
    async ({ categoryId }) => {
      const authError = await requireAuth();
      if (authError) return authError;
      return await withToolErrorBoundary('wlh', async () => {
        const categories = (await services.wlh.children(categoryId)).map(toMcpWlhCategory).filter((category) => category.id.length > 0);
        const structuredContent = { source: 'wlh', categoryId, categories };
        return textResult(structuredContent, `Fetched ${categories.length} child WLH categories for ${categoryId}.`);
      });
    },
  );

  return server;
}

export async function handleMcpHttpRequest(request: HttpRequest, context: InvocationContext, services?: McpGatewayServices): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') {
    return { status: 204, headers: corsHeaders() };
  }

  if (request.method === 'GET' && !request.headers.get('authorization')) {
    return {
      status: 401,
      headers: {
        ...corsHeaders(),
        'WWW-Authenticate': buildMcpWwwAuthenticate(request, {
          error: 'invalid_token',
          errorDescription: 'Missing bearer token.',
        }),
      },
      jsonBody: { error: { code: 'unauthorized', message: 'Authentication is required to open an MCP event stream.' } },
    };
  }

  const parsedBody = request.method === 'POST' ? await safeReadJson(request) : undefined;
  if (parsedBody === invalidJson) {
    return {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': jsonRpcContentType },
      jsonBody: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createPrivateMcpServer({
    authorizationHeader: request.headers.get('authorization'),
    context,
    request,
    services,
  });
  await server.connect(transport);

  try {
    const webRequest = toWebRequest(request, parsedBody === undefined ? undefined : parsedBody);
    const response = await transport.handleRequest(webRequest, parsedBody === undefined ? undefined : { parsedBody });
    return await toHttpResponseInit(response);
  } finally {
    await server.close();
  }
}

function createProtectedToolSecurity(): { securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }>; _meta: { securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }> } } {
  const protectedSecuritySchemes = [{ type: 'oauth2' as const, scopes: [getMcpOAuthScope()] }];
  return { securitySchemes: protectedSecuritySchemes, _meta: { securitySchemes: protectedSecuritySchemes } };
}

type ToolSecurity = {
  securitySchemes: Array<{ type: string; scopes?: string[] }>;
  _meta: Record<string, unknown> & { securitySchemes: Array<{ type: string; scopes?: string[] }> };
};
type ToolSource = 'reddit' | 'wlh' | 'mcp';
type SafeToolErrorCode = 'invalid_arguments' | 'upstream_unavailable' | 'upstream_rate_limited' | 'not_found' | 'unsupported_url';

function toolSecurityWithStatus(securitySchemes: ToolSecurity['securitySchemes'], invoking: string, invoked: string): ToolSecurity {
  return { securitySchemes, _meta: { securitySchemes, 'openai/toolInvocation/invoking': invoking, 'openai/toolInvocation/invoked': invoked } };
}

function withToolStatus<T extends ToolSecurity>(security: T, invoking: string, invoked: string): T {
  return { ...security, _meta: { ...security._meta, 'openai/toolInvocation/invoking': invoking, 'openai/toolInvocation/invoked': invoked } };
}

async function withToolErrorBoundary(source: ToolSource, action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return safeToolError(classifyToolError(error), safeToolErrorMessage(error, source), source);
  }
}

function classifyToolError(error: unknown): SafeToolErrorCode {
  const record = asRecord(error);
  const status = numberValue(record['status']) ?? numberValue(record['statusCode']);
  const name = stringValue(record['name']) ?? '';
  const message = typeof record['message'] === 'string' ? record['message'].toLowerCase() : '';
  if (status === 429 || message.includes('rate-limit') || message.includes('rate limit')) return 'upstream_rate_limited';
  if (status === 404 || name.includes('NotFound') || message.includes('not found')) return 'not_found';
  return 'upstream_unavailable';
}

function safeToolErrorMessage(error: unknown, source: ToolSource): string {
  const code = classifyToolError(error);
  if (code === 'upstream_rate_limited') return `${source.toUpperCase()} is rate limiting requests. Retry later.`;
  if (code === 'not_found') return `${source.toUpperCase()} resource was not found.`;
  return `${source.toUpperCase()} service is temporarily unavailable.`;
}

function safeToolError(code: SafeToolErrorCode, message: string, source?: ToolSource): CallToolResult {
  return { isError: true, structuredContent: compactRecord({ error: code, source }) as Record<string, unknown>, content: [{ type: 'text', text: message }] };
}

function isToolErrorResult(value: unknown): value is CallToolResult {
  return isRecord(value) && value['isError'] === true;
}


function mcpAuthorizationFailureResult(auth: Extract<Awaited<ReturnType<typeof authorizeMcpTool>>, { ok: false }>, request?: HttpRequest): CallToolResult {
  const challenge = authChallengeForFailure(auth);
  return mcpAuthErrorResult(
    buildMcpWwwAuthenticate(request, challenge),
    challenge.error,
    challenge.errorDescription,
  );
}

function authChallengeForFailure(auth: Extract<Awaited<ReturnType<typeof authorizeMcpTool>>, { ok: false }>): { error: McpAuthChallengeError; errorDescription: string } {
  const status = auth.response.status ?? 401;
  return {
    error: status === 403 ? 'insufficient_scope' : 'invalid_token',
    errorDescription: safeAuthErrorDescription(auth),
  };
}

function safeAuthErrorDescription(auth: Extract<Awaited<ReturnType<typeof authorizeMcpTool>>, { ok: false }>): string {
  const body = auth.response.jsonBody;
  if (isRecord(body)) {
    const error = body['error'];
    if (isRecord(error) && typeof error['message'] === 'string' && error['message'].trim().length > 0) {
      return error['message'];
    }
  }
  return auth.response.status === 403 ? 'Token is valid but is not authorized for this MCP tool.' : 'Missing, malformed, or invalid bearer token.';
}

function defaultServices(): McpGatewayServices {
  return { reddit: new RedditThreadService(), wlh: new WlhService() };
}

function textResult(structuredContent: object, text: string): CallToolResult {
  return { structuredContent: structuredContent as Record<string, unknown>, content: [{ type: 'text', text }] };
}

function invalidArgument(message: string, code: SafeToolErrorCode = 'invalid_arguments'): CallToolResult {
  return safeToolError(code, message, 'mcp');
}

function toRedditThreadRequest(args: { postId?: string; url?: string; sort?: string; maxComments?: number; maxMoreChildrenRequests?: number }): RedditThreadRequest | CallToolResult {
  const source = validateExactlyOneRedditSource(args);
  if (isToolErrorResult(source)) return source;
  return compactRecord({
    ...source,
    sort: args.sort as RedditThreadRequest['sort'] | undefined,
    maxComments: args.maxComments,
    maxMoreChildrenRequests: args.maxMoreChildrenRequests,
  }) as RedditThreadRequest;
}

function toRedditOverviewRequest(args: { postId?: string; url?: string; sort?: string; maxComments?: number }): RedditThreadOverviewRequest | CallToolResult {
  const source = validateExactlyOneRedditSource(args);
  if (isToolErrorResult(source)) return source;
  return compactRecord({
    ...source,
    sort: args.sort as RedditThreadOverviewRequest['sort'] | undefined,
    maxComments: args.maxComments,
  }) as RedditThreadOverviewRequest;
}

function validateExactlyOneRedditSource(args: { postId?: string; url?: string }): { post?: string; url?: string } | CallToolResult {
  const postId = args.postId?.trim();
  const url = args.url?.trim();
  if (!postId && !url) return invalidArgument('Provide exactly one of postId or url for Reddit tools.');
  if (postId && url) return invalidArgument('Provide either postId or url for Reddit tools, not both.');
  if (postId) {
    if (!/^(?:t3_)?[a-z0-9][a-z0-9_]{1,31}$/i.test(postId)) return invalidArgument('postId must look like a Reddit post ID.');
    return { post: postId };
  }
  if (url && !isSupportedRedditUrl(url)) return invalidArgument('Unsupported Reddit URL. Use reddit.com, old.reddit.com, np.reddit.com, www.reddit.com, or redd.it.', 'unsupported_url');
  return { url };
}

function toMcpRedditThread(response: unknown): Record<string, unknown> {
  const record = asRecord(response);
  const allComments = flattenRedditComments(record['comments']);
  const comments = allComments.slice(0, maxMcpComments);
  const upstreamStats = asRecord(record['stats']);
  const upstreamCommentsReturned = numberValue(upstreamStats['commentsReturned']) ?? allComments.length;
  const bodyTruncated = comments.some((comment) => comment['truncated'] === true);
  const countTruncated = allComments.length > comments.length;
  const modelTruncated = bodyTruncated || countTruncated;
  return compactRecord({
    source: 'reddit',
    fetchedAt: stringValue(record['fetchedAt']),
    input: stringValue(record['input']),
    post: toMcpRedditPost(record['post']),
    comments,
    continuations: arrayValue(record['commentContinuations']).map(toMcpRedditContinuation),
    stats: compactRecord({
      commentsReturned: upstreamCommentsReturned,
      upstreamCommentsReturned,
      modelCommentsReturned: comments.length,
      modelCommentLimit: maxMcpComments,
      bodyCharLimit: maxCommentBodyChars,
      modelTruncated,
      truncated: booleanValue(upstreamStats['truncated']),
      warnings: arrayValue(upstreamStats['warnings']).filter((warning): warning is string => typeof warning === 'string'),
    }),
  });
}

function toMcpRedditOverview(response: unknown): Record<string, unknown> {
  const record = asRecord(response);
  const stats = asRecord(record['stats']);
  const coverage = compactRecord(asRecord(record['coverage']));
  const availableSorts = arrayValue(record['availableSorts']).filter((value): value is z.infer<typeof redditSortSchema> => redditSortSchema.safeParse(value).success);
  return compactRecord({
    source: 'reddit',
    fetchedAt: stringValue(record['fetchedAt']),
    input: stringValue(record['input']),
    post: toMcpRedditPost(record['post']),
    stats: compactRecord({
      topLevelComments: numberValue(stats['topLevelComments']),
      maxDepth: numberValue(stats['maxDepth']),
      deletedCount: numberValue(stats['deletedCount']),
      loadedSnapshotCommentCount: numberValue(stats['loadedSnapshotCommentCount']) ?? 0,
    }),
    coverage: Object.keys(coverage).length > 0 ? coverage : undefined,
    availableSorts: availableSorts.length > 0 ? availableSorts : undefined,
  });
}

function toMcpRedditPost(value: unknown): Record<string, unknown> {
  const post = asRecord(value);
  return compactRecord({
    id: stringValue(post['id']) ?? '',
    title: stringValue(post['title']) ?? '',
    subreddit: stringValue(post['subreddit']),
    author: stringValue(post['author']),
    url: stringValue(post['url']),
    permalink: stringValue(post['permalink']),
    score: numberValue(post['score']),
    commentCount: numberValue(post['numComments']) ?? numberValue(post['commentCount']),
    createdUtc: numberValue(post['createdUtc']),
    over18: booleanValue(post['over18']),
    locked: booleanValue(post['locked']),
    archived: booleanValue(post['archived']),
  });
}

function flattenRedditComments(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  for (const item of arrayValue(value)) {
    const comment = asRecord(item);
    const body = stringValue(comment['body']) ?? '';
    out.push(compactRecord({
      id: stringValue(comment['id']) ?? '',
      parentId: stringValue(comment['parentId']),
      author: stringValue(comment['author']),
      body: truncate(body, maxCommentBodyChars),
      score: numberValue(comment['score']),
      depth: numberValue(comment['depth']),
      createdUtc: numberValue(comment['createdUtc']),
      permalink: stringValue(comment['permalink']),
      truncated: body.length > maxCommentBodyChars,
    }));
    flattenRedditComments(comment['replies'], out);
  }
  return out;
}

function toMcpRedditContinuation(value: unknown): Record<string, unknown> {
  const continuation = asRecord(value);
  return compactRecord({
    parentId: stringValue(continuation['parentId']) ?? '',
    childCount: numberValue(continuation['childCount']) ?? arrayValue(continuation['children']).length,
    depth: numberValue(continuation['depth']),
  });
}

async function toWlhSearchRequest(wlh: McpGatewayServices['wlh'], args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const categoryId = stringValue(args['categoryId']) ?? await inferWlhCategoryId(wlh, args);
  const delivery = arrayValue(args['delivery']).filter((item): item is string => typeof item === 'string');
  const requiredTerms = arrayValue(args['requiredTerms']).filter((item): item is string => typeof item === 'string');
  return compactRecord({
    keyword: stringValue(args['keyword']),
    categoryId,
    priceFrom: numberValue(args['priceFrom']),
    priceTo: numberValue(args['priceTo']),
    areaId: stringValue(args['areaId']),
    paylivery: booleanValue(args['paylivery']),
    rows: numberValue(args['rows']),
    page: numberValue(args['page']),
    condition: stringValue(args['condition']),
    delivery: delivery.length > 0 ? delivery : undefined,
    requiredTerms: requiredTerms.length > 0 ? requiredTerms : undefined,
  });
}

async function inferWlhCategoryId(wlh: McpGatewayServices['wlh'], args: Record<string, unknown>): Promise<string> {
  const query = stringValue(args['categoryPath']) ?? stringValue(args['keyword']);
  if (query) {
    const matches = await findWlhCategories(wlh, query, 1);
    if (matches[0]) return matches[0].id;
  }
  return '0';
}

function validateWlhSearchArgs(args: Record<string, unknown>): CallToolResult | undefined {
  const priceFrom = numberValue(args['priceFrom']);
  const priceTo = numberValue(args['priceTo']);
  if (args['priceFrom'] !== undefined && priceFrom === undefined) return invalidArgument('priceFrom must be a finite number.');
  if (args['priceTo'] !== undefined && priceTo === undefined) return invalidArgument('priceTo must be a finite number.');
  if (priceFrom !== undefined && priceFrom < 0) return invalidArgument('priceFrom must be non-negative.');
  if (priceTo !== undefined && priceTo < 0) return invalidArgument('priceTo must be non-negative.');
  if (priceFrom !== undefined && priceTo !== undefined && priceFrom > priceTo) return invalidArgument('priceFrom must be less than or equal to priceTo.');
  const postedSince = stringValue(args['postedSince']);
  if (args['postedSince'] !== undefined && (!postedSince || !isIsoDateOrDateTime(postedSince))) return invalidArgument('postedSince must be a valid ISO date or ISO datetime.');
  return undefined;
}

function toMcpWlhSearch(response: unknown, query: unknown, searchRequest: unknown): Record<string, unknown> {
  const record = asRecord(response);
  const rawResults = arrayValue(record['results']).map(toMcpWlhListing).filter((listing) => listing.id.length > 0);
  const postFiltered = applyMcpWlhPostFilters(rawResults, query);
  const results = sortMcpWlhResults(postFiltered, stringValue(asRecord(query)['sort']));
  const category = toMcpWlhCategory(record['category']);
  return compactRecord({
    source: 'wlh',
    query: toMcpWlhSearchQuery({ ...asRecord(query), categoryId: stringValue(asRecord(searchRequest)['categoryId']) ?? stringValue(asRecord(query)['categoryId']) }),
    totalApprox: numberValue(record['rowsFound']) ?? null,
    rowsReturned: numberValue(record['rowsReturned']) ?? rawResults.length,
    filteredRowsReturned: results.length,
    category: category.id.length > 0 ? category : undefined,
    results,
    filterApplications: describeWlhFilterApplications(query, searchRequest),
    sourceUrl: stringValue(record['sourceUrl']),
    fetchedAt: stringValue(record['fetchedAt']),
  });
}


function toMcpWlhSearchQuery(value: unknown): Record<string, unknown> {
  const query = asRecord(value);
  return compactRecord({
    keyword: stringValue(query['keyword']),
    categoryId: stringValue(query['categoryId']),
    categoryPath: stringValue(query['categoryPath']),
    locationText: stringValue(query['locationText']),
    postcode: stringValue(query['postcode']),
    priceFrom: numberValue(query['priceFrom']),
    priceTo: numberValue(query['priceTo']),
    areaId: stringValue(query['areaId']),
    paylivery: booleanValue(query['paylivery']),
    rows: numberValue(query['rows']),
    page: numberValue(query['page']),
    condition: stringValue(query['condition']),
    delivery: arrayValue(query['delivery']).filter((item): item is string => typeof item === 'string'),
    requiredTerms: arrayValue(query['requiredTerms']).filter((item): item is string => typeof item === 'string'),
    sort: stringValue(query['sort']),
    postedSince: stringValue(query['postedSince']),
    imageRequired: booleanValue(query['imageRequired']),
  });
}

function applyMcpWlhPostFilters(results: Array<{ id: string; [key: string]: unknown }>, queryValue: unknown): Array<{ id: string; [key: string]: unknown }> {
  const query = asRecord(queryValue);
  const locationText = normalizeMcpSearchText(stringValue(query['locationText']));
  const postcode = normalizeMcpSearchText(stringValue(query['postcode']));
  const postedSince = dateTimeValue(stringValue(query['postedSince']));
  const imageRequired = booleanValue(query['imageRequired']);
  return results.filter((listing) => {
    if (locationText) {
      const locationHaystack = normalizeMcpSearchText([listing['location'], listing['postcode'], listing['state']].filter(Boolean).join(' '));
      if (!locationHaystack.includes(locationText)) return false;
    }
    if (postcode) {
      const listingPostcode = normalizeMcpSearchText(stringValue(listing['postcode']));
      if (!listingPostcode.startsWith(postcode)) return false;
    }
    if (postedSince) {
      const publishedAt = dateTimeValue(stringValue(listing['publishedAt']));
      if (!publishedAt || publishedAt < postedSince) return false;
    }
    if (imageRequired === true && (numberValue(listing['imageCount']) ?? 0) <= 0) return false;
    return true;
  });
}

function sortMcpWlhResults(results: Array<{ id: string; [key: string]: unknown }>, sort: string | undefined): Array<{ id: string; [key: string]: unknown }> {
  const sorted = [...results];
  if (sort === 'price_asc') return sorted.sort((a, b) => nullableSortNumber(a['priceAmount'], Number.POSITIVE_INFINITY) - nullableSortNumber(b['priceAmount'], Number.POSITIVE_INFINITY));
  if (sort === 'price_desc') return sorted.sort((a, b) => nullableSortNumber(b['priceAmount'], Number.NEGATIVE_INFINITY) - nullableSortNumber(a['priceAmount'], Number.NEGATIVE_INFINITY));
  if (sort === 'newest') return sorted.sort((a, b) => (dateTimeValue(stringValue(b['publishedAt']))?.getTime() ?? 0) - (dateTimeValue(stringValue(a['publishedAt']))?.getTime() ?? 0));
  return sorted;
}

function describeWlhFilterApplications(queryValue: unknown, searchRequestValue: unknown): Array<Record<string, unknown>> {
  const query = asRecord(queryValue);
  const searchRequest = asRecord(searchRequestValue);
  const applications: Array<Record<string, unknown>> = [];
  const sentFields = ['keyword', 'categoryId', 'priceFrom', 'priceTo', 'areaId', 'paylivery', 'rows', 'page', 'condition', 'delivery'];
  for (const field of sentFields) {
    if (searchRequest[field] !== undefined) applications.push({ field, appliedAs: 'sent_to_wlh', effective: true });
  }
  if (query['categoryPath'] !== undefined && query['categoryId'] === undefined) applications.push({ field: 'categoryPath', appliedAs: 'category_inference', effective: true, note: `Inferred categoryId ${String(searchRequest['categoryId'] ?? '') || '0'} before calling WLH.` });
  if (Array.isArray(searchRequest['requiredTerms']) && searchRequest['requiredTerms'].length > 0) applications.push({ field: 'requiredTerms', appliedAs: 'service_post_filter', effective: true, note: 'Filtered by the WLH service against returned listing title/body text before MCP shaping.' });
  for (const field of ['locationText', 'postcode', 'postedSince', 'imageRequired']) {
    if (query[field] !== undefined) applications.push({ field, appliedAs: 'mcp_post_filter', effective: true, note: 'Applied only to the listings returned by the underlying WLH request.' });
  }
  const sort = stringValue(query['sort']);
  if (sort && sort !== 'relevance') applications.push({ field: 'sort', appliedAs: 'mcp_post_sort', effective: true, note: 'Sorted only the listings returned by the underlying WLH request; WLH global result ordering is unchanged.' });
  if (sort === 'relevance') applications.push({ field: 'sort', appliedAs: 'mcp_post_sort', effective: false, note: 'Relevance is the default WLH order; MCP does not send a sort parameter or reorder the returned page.' });
  return applications;
}

function nullableSortNumber(value: unknown, fallback: number): number {
  const number = numberValue(value);
  return number === undefined ? fallback : number;
}

function dateTimeValue(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeMcpSearchText(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('de-AT');
}

function toMcpWlhListing(value: unknown): { id: string; [key: string]: unknown } {
  const listing = asRecord(value);
  return compactRecord({
    id: stringValue(listing['id']) ?? '',
    title: stringValue(listing['title']) ?? '',
    priceAmount: numberValue(listing['priceAmount']),
    priceDisplay: stringValue(listing['priceDisplay']),
    location: stringValue(listing['location']),
    postcode: stringValue(listing['postcode']),
    state: stringValue(listing['state']),
    url: stringValue(listing['url']),
    thumbnailUrl: stringValue(listing['thumbnailUrl']),
    sellerId: stringValue(listing['sellerId']),
    paylivery: booleanValue(listing['paylivery']),
    publishedAt: stringValue(listing['publishedAt']),
    imageCount: numberValue(listing['imageCount']),
  }) as { id: string; [key: string]: unknown };
}

function toMcpWlhOffer(response: unknown, fallbackAdId: string, inputUrl: unknown): Record<string, unknown> {
  const offer = asRecord(response);
  const seller = compactRecord(asRecord(offer['seller']));
  return compactRecord({
    source: 'wlh',
    id: stringValue(offer['id']) ?? fallbackAdId,
    title: stringValue(offer['title']) ?? '',
    description: stringValue(offer['description']),
    priceAmount: numberValue(offer['priceAmount']),
    priceDisplay: stringValue(offer['priceDisplay']),
    location: stringValue(offer['location']),
    postcode: stringValue(offer['postcode']),
    state: stringValue(offer['state']),
    url: stringValue(inputUrl) ?? `https://www.willhaben.at/iad/object?adId=${encodeURIComponent(fallbackAdId)}`,
    status: stringValue(offer['status']),
    seller: Object.keys(seller).length > 0 ? seller : undefined,
    paylivery: booleanValue(offer['paylivery']) ?? false,
    deliveryOptions: arrayValue(offer['deliveryOptions']).map((option) => compactRecord(asRecord(option))),
    images: dedupeWlhImages(offer['images']),
    publishedAt: stringValue(offer['publishedAt']),
    changedAt: stringValue(offer['changedAt']),
  });
}

function dedupeWlhImages(value: unknown): Array<Record<string, unknown>> {
  const byUrl = new Map<string, Record<string, unknown>>();
  for (const image of arrayValue(value)) {
    const record = asRecord(image);
    const url = stringValue(record['url']) ?? stringValue(record['full']) ?? stringValue(record['preview']) ?? stringValue(record['thumb']);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, compactRecord({ id: stringValue(record['id']), thumb: url, preview: url, full: url }));
  }
  return [...byUrl.values()];
}

function extractWlhAdId(args: { adId?: string; url?: string }): string | CallToolResult {
  const adId = args.adId?.trim();
  const url = args.url?.trim();
  if (!adId && !url) return invalidArgument('Provide exactly one of adId or url for wlh_get_offer.');
  if (adId && url) return invalidArgument('Provide either adId or url for wlh_get_offer, not both.');
  if (adId) {
    if (!/^\d{5,20}$/.test(adId)) return invalidArgument('adId must be a realistic numeric Willhaben advertisement ID.');
    return adId;
  }
  if (!url || !isSupportedWlhUrl(url)) return invalidArgument('Unsupported Willhaben URL. Use a willhaben.at listing URL.', 'unsupported_url');
  const parsed = new URL(url);
  const queryAdId = parsed.searchParams.get('adId');
  if (queryAdId?.trim() && /^\d{5,20}$/.test(queryAdId.trim())) return queryAdId.trim();
  const match = parsed.pathname.match(/(?:^|[-/])(\d{5,20})(?:$|[/?#])/);
  if (match?.[1]) return match[1];
  return invalidArgument('Willhaben URL did not contain a numeric advertisement ID.');
}

async function findWlhCategories(wlh: McpGatewayServices['wlh'], query: string, limit: number): Promise<Array<ReturnType<typeof toMcpWlhCategory> & { score: number }>> {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const seen = new Set<string>();
  const queue = [...await wlh.topCategories()];
  const scanned: unknown[] = [];
  while (queue.length > 0 && scanned.length < maxCategoryScan) {
    const category = queue.shift();
    const mapped = toMcpWlhCategory(category);
    if (!mapped.id || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    scanned.push(category);
    if (mapped.hasChildren) {
      queue.push(...await wlh.children(mapped.id));
    }
  }
  return scanned
    .map((category) => ({ ...toMcpWlhCategory(category), score: scoreCategory(category, tokens, normalizedQuery) }))
    .filter((category) => category.score > 0)
    .sort((a, b) => b.score - a.score || a.depth - b.depth)
    .slice(0, limit);
}

function scoreCategory(category: unknown, tokens: string[], normalizedQuery: string): number {
  const record = asRecord(category);
  const label = normalizeSearchText(stringValue(record['label']) ?? '');
  const path = normalizeSearchText(stringValue(record['path']) ?? '');
  let score = 0;
  if (label === normalizedQuery) score += 100;
  if (path === normalizedQuery) score += 80;
  for (const token of tokens) {
    if (label.includes(token)) score += 10;
    if (path.includes(token)) score += 4;
  }
  return score;
}

function toMcpWlhCategory(value: unknown): { id: string; label: string; path: string; depth: number; parentId?: string; hitCount?: number; hasChildren: boolean; url?: string } {
  const category = asRecord(value);
  return compactRecord({
    id: stringValue(category['id']) ?? '',
    label: stringValue(category['label']) ?? '',
    path: stringValue(category['path']) ?? '',
    depth: numberValue(category['depth']) ?? 0,
    parentId: stringValue(category['parentId']),
    hitCount: numberValue(category['hitCount']),
    hasChildren: booleanValue(category['hasChildren']) ?? false,
    url: stringValue(category['url']),
  }) as { id: string; label: string; path: string; depth: number; parentId?: string; hitCount?: number; hasChildren: boolean; url?: string };
}

function summarizeRedditThread(response: Record<string, unknown>): string {
  const postId = String(asRecord(response['post'])['id'] ?? '');
  const stats = asRecord(response['stats']);
  const modelCommentsReturned = numberValue(stats['modelCommentsReturned']) ?? arrayValue(response['comments']).length;
  const truncated = booleanValue(stats['modelTruncated']) ?? false;
  return `Fetched Reddit thread ${postId} with ${modelCommentsReturned} model-readable comments${truncated ? ' (truncated for model safety).' : '.'}`;
}

function summarizeWlhSearch(response: Record<string, unknown>): string {
  const filtered = typeof response['filteredRowsReturned'] === 'number' ? response['filteredRowsReturned'] : undefined;
  const returned = typeof response['rowsReturned'] === 'number' ? response['rowsReturned'] : undefined;
  return `Found ${filtered ?? returned ?? 'unknown'} model-readable WLH offers.`;
}

const invalidJson = Symbol('invalidJson');

async function safeReadJson(request: HttpRequest): Promise<unknown | typeof invalidJson> {
  try {
    return await request.json();
  } catch {
    return invalidJson;
  }
}

function toWebRequest(request: HttpRequest, parsedBody: unknown): Request {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    headers.set(key, value);
  }
  if (parsedBody !== undefined && !headers.has('content-type')) headers.set('content-type', jsonRpcContentType);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: parsedBody === undefined ? undefined : JSON.stringify(parsedBody),
  });
}

async function toHttpResponseInit(response: Response): Promise<HttpResponseInit> {
  const headers = corsHeaders();
  response.headers.forEach((value, key) => { headers[key] = value; });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('application/json') && text.length > 0) {
    return { status: response.status, headers, jsonBody: addTopLevelSecuritySchemes(JSON.parse(text) as unknown) };
  }
  return { status: response.status, headers, body: text };
}

function addTopLevelSecuritySchemes(jsonBody: unknown): unknown {
  if (!isRecord(jsonBody) || !isRecord(jsonBody['result'])) return jsonBody;
  const tools = jsonBody['result']['tools'];
  if (!Array.isArray(tools)) return jsonBody;
  for (const tool of tools) {
    if (!isRecord(tool) || tool['securitySchemes'] !== undefined || !isRecord(tool['_meta'])) continue;
    const securitySchemes = tool['_meta']['securitySchemes'];
    if (Array.isArray(securitySchemes)) {
      tool['securitySchemes'] = securitySchemes;
    }
  }
  return jsonBody;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, mcp-session-id, mcp-protocol-version',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function isSupportedRedditUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'np.reddit.com', 'redd.it'].includes(host);
  } catch {
    return false;
  }
}

function isSupportedWlhUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /(^|\.)willhaben\.at$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isIsoDateOrDateTime(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(value);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
