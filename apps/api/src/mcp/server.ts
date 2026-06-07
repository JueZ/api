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
const noauthSecuritySchemes = [{ type: 'noauth' }];
const localOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const externalReadOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const healthToolSecurity = { securitySchemes: noauthSecuritySchemes, _meta: { securitySchemes: noauthSecuritySchemes } };

const nullableNumber = z.number().nullable();
const categorySchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  depth: z.number(),
  parentId: z.string().optional(),
  hitCount: z.number().optional(),
  hasChildren: z.boolean(),
  url: z.string().optional(),
}).passthrough();
const healthOutputSchema = z.object({
  service: z.literal('api-catalogue'),
  status: z.literal('ok'),
  mcpGateway: z.object({ endpoint: z.string(), version: z.string() }).passthrough(),
}).passthrough();
const helloOutputSchema = z.object({
  message: z.literal('Hello, Martin'),
  authenticated: z.literal(true),
  user: z.object({ subject: z.string(), objectId: z.string().optional(), tenantId: z.string().optional() }).passthrough(),
}).passthrough();
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
}).passthrough();
const redditCommentSummarySchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  author: z.string().optional(),
  body: z.string(),
  score: z.number().optional(),
  depth: z.number().optional(),
  createdUtc: z.number().optional(),
  permalink: z.string().optional(),
  truncated: z.boolean().optional(),
}).passthrough();
const redditThreadOutputSchema = z.object({
  source: z.literal('reddit'),
  fetchedAt: z.string().optional(),
  input: z.string().optional(),
  post: redditPostSummarySchema,
  comments: z.array(redditCommentSummarySchema),
  continuations: z.array(z.object({ parentId: z.string(), childCount: z.number(), depth: z.number().optional() }).passthrough()),
  stats: z.object({ commentsReturned: z.number(), truncated: z.boolean().optional(), warnings: z.array(z.string()).optional() }).passthrough(),
}).passthrough();
const redditOverviewOutputSchema = z.object({
  source: z.literal('reddit'),
  fetchedAt: z.string().optional(),
  input: z.string().optional(),
  post: redditPostSummarySchema,
  stats: z.object({ topLevelComments: z.number().optional(), maxDepth: z.number().optional(), deletedCount: z.number().optional(), loadedSnapshotCommentCount: z.number() }).passthrough(),
  coverage: z.object({ reportedTotal: z.number().optional(), uniqueReturned: z.number().optional(), knownRemaining: z.number().optional(), snapshotComplete: z.boolean().optional() }).passthrough().optional(),
  availableSorts: z.array(redditSortSchema).optional(),
}).passthrough();
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
  sellerType: z.string().optional(),
  sellerId: z.string().optional(),
  paylivery: z.boolean().nullable().optional(),
  publishedAt: z.string().optional(),
  imageCount: z.number().optional(),
}).passthrough();
const wlhSearchOutputSchema = z.object({
  source: z.literal('wlh'),
  query: z.object({ keyword: z.string().optional(), categoryId: z.string().optional(), categoryPath: z.string().optional(), priceFrom: z.number().optional(), priceTo: z.number().optional() }).passthrough(),
  totalApprox: nullableNumber,
  rowsReturned: z.number(),
  filteredRowsReturned: z.number(),
  category: categorySchema.optional(),
  results: z.array(wlhListingSchema),
  sourceUrl: z.string().optional(),
  fetchedAt: z.string().optional(),
}).passthrough();
const wlhOfferImageSchema = z.object({ id: z.string().optional(), thumb: z.string().optional(), preview: z.string().optional(), full: z.string().optional() }).passthrough();
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
  seller: z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough().optional(),
  paylivery: z.boolean().optional(),
  deliveryOptions: z.array(z.object({ carrier: z.string().optional(), parcelSize: z.string().optional(), price: z.unknown().optional(), description: z.string().optional() }).passthrough()).optional(),
  images: z.array(wlhOfferImageSchema),
  publishedAt: z.string().optional(),
  changedAt: z.string().optional(),
}).passthrough();
const wlhCategoriesOutputSchema = z.object({
  source: z.literal('wlh'),
  categories: z.array(categorySchema),
}).passthrough();
const wlhCategoryChildrenOutputSchema = z.object({
  source: z.literal('wlh'),
  categoryId: z.string(),
  categories: z.array(categorySchema),
}).passthrough();
const wlhFindCategoryOutputSchema = z.object({
  source: z.literal('wlh'),
  query: z.string(),
  matches: z.array(categorySchema.extend({ score: z.number() })),
}).passthrough();

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
      ...protectedToolSecurity,
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
        postId: z.string().optional(),
        url: z.string().optional(),
        sort: redditSortSchema.optional(),
        maxComments: z.number().int().positive().max(500).optional(),
        maxMoreChildrenRequests: z.number().int().min(0).max(500).optional(),
      },
      outputSchema: redditThreadOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const request = toRedditThreadRequest(args);
      const response = await services.reddit.fetchThread(request);
      const structuredContent = toMcpRedditThread(response);
      return textResult(structuredContent, `Fetched Reddit thread ${String(asRecord(structuredContent['post'])['id'] ?? '')} with ${arrayValue(structuredContent['comments']).length} model-readable comments.`);
    },
  );

  server.registerTool(
    'reddit_get_thread_overview',
    {
      title: 'Reddit thread overview',
      description: 'Use this first when the user provides a Reddit post URL or asks what a thread is about. Returns compact post, coverage, and count metadata without full comment bodies; do not use for detailed comment analysis.',
      inputSchema: {
        postId: z.string().optional(),
        url: z.string().optional(),
        sort: redditSortSchema.optional(),
        maxComments: z.number().int().positive().max(500).optional(),
      },
      outputSchema: redditOverviewOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const request = toRedditOverviewRequest(args);
      const response = await services.reddit.fetchThreadOverview(request);
      const structuredContent = toMcpRedditOverview(response);
      return textResult(structuredContent, `Fetched Reddit thread overview ${String(asRecord(structuredContent['post'])['id'] ?? '')}: ${String(asRecord(structuredContent['stats'])['loadedSnapshotCommentCount'] ?? 'unknown')} loaded comments.`);
    },
  );

  server.registerTool(
    'wlh_find_category',
    {
      title: 'WLH find category',
      description: 'Use this when the user describes a Willhaben category in natural language and no categoryId is known. Returns likely category IDs for follow-up wlh_search calls; do not use for offer details.',
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(maxCategoryMatches).optional() },
      outputSchema: wlhFindCategoryOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async ({ query, limit }) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const matches = await findWlhCategories(services.wlh, query, limit ?? maxCategoryMatches);
      return textResult({ source: 'wlh', query, matches }, `Found ${matches.length} WLH category matches for "${query}".`);
    },
  );

  server.registerTool(
    'wlh_search',
    {
      title: 'WLH search',
      description: 'Use this when the user wants to find Willhaben offers by keyword, price, category, location, condition, PayLivery, or delivery preference. Use wlh_find_category first when the category is unclear; use wlh_get_offer for a specific listing.',
      inputSchema: {
        keyword: z.string().optional(),
        categoryId: z.string().optional(),
        categoryPath: z.string().optional(),
        locationText: z.string().optional(),
        postcode: z.string().optional(),
        radiusKm: z.number().positive().optional(),
        priceFrom: z.number().optional(),
        priceTo: z.number().optional(),
        areaId: z.string().optional(),
        paylivery: z.boolean().optional(),
        rows: z.number().int().positive().max(100).optional(),
        page: z.number().int().positive().optional(),
        condition: z.enum(['new', 'like_new', 'used', 'defect']).optional(),
        delivery: z.array(z.enum(['pickup', 'shipping'])).optional(),
        requiredTerms: z.array(z.string()).optional(),
        sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest']).optional(),
        postedSince: z.string().optional(),
        sellerType: z.enum(['private', 'commercial']).optional(),
        imageRequired: z.boolean().optional(),
      },
      outputSchema: wlhSearchOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const searchRequest = await toWlhSearchRequest(services.wlh, args);
      const response = await services.wlh.search(searchRequest);
      const structuredContent = toMcpWlhSearch(response, args);
      return textResult(structuredContent, summarizeWlhSearch(structuredContent));
    },
  );

  server.registerTool(
    'wlh_get_offer',
    {
      title: 'WLH offer detail',
      description: 'Use this when the user asks to analyze, price-check, summarize, inspect, or compare a specific Willhaben listing. Accepts either a Willhaben ad ID or URL. Do not use it for broad searches; use wlh_search first.',
      inputSchema: { adId: z.string().optional(), url: z.string().optional() },
      outputSchema: wlhOfferOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const adId = extractWlhAdId(args);
      if (!adId) return toolError('Provide either adId or a valid Willhaben listing URL.');
      const response = await services.wlh.offer(adId);
      const structuredContent = toMcpWlhOffer(response, adId, args.url);
      return textResult(structuredContent, `Fetched WLH offer ${String(structuredContent['id'])}: ${String(structuredContent['title'] || 'untitled offer')}.`);
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
      ...protectedToolSecurity,
    },
    async () => {
      const authError = await requireAuth();
      if (authError) return authError;
      const categories = (await services.wlh.topCategories()).map(toMcpWlhCategory);
      const structuredContent = { source: 'wlh', categories };
      return textResult(structuredContent, `Fetched ${categories.length} top WLH categories.`);
    },
  );

  server.registerTool(
    'wlh_category_children',
    {
      title: 'WLH category children',
      description: 'Use this when you already have a Willhaben categoryId and need its child categories before searching. Do not use for offer details.',
      inputSchema: { categoryId: z.string() },
      outputSchema: wlhCategoryChildrenOutputSchema,
      annotations: externalReadOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async ({ categoryId }) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const categories = (await services.wlh.children(categoryId)).map(toMcpWlhCategory);
      const structuredContent = { source: 'wlh', categoryId, categories };
      return textResult(structuredContent, `Fetched ${categories.length} child WLH categories for ${categoryId}.`);
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

function toolError(message: string): CallToolResult {
  return { isError: true, structuredContent: { error: 'invalid_arguments', message }, content: [{ type: 'text', text: message }] };
}

function toRedditThreadRequest(args: { postId?: string; url?: string; sort?: string; maxComments?: number; maxMoreChildrenRequests?: number }): RedditThreadRequest {
  return {
    ...(args.postId ? { post: args.postId } : {}),
    ...(args.url ? { url: args.url } : {}),
    ...(args.sort ? { sort: args.sort as RedditThreadRequest['sort'] } : {}),
    ...(args.maxComments ? { maxComments: args.maxComments } : {}),
    ...(args.maxMoreChildrenRequests !== undefined ? { maxMoreChildrenRequests: args.maxMoreChildrenRequests } : {}),
  };
}

function toRedditOverviewRequest(args: { postId?: string; url?: string; sort?: string; maxComments?: number }): RedditThreadOverviewRequest {
  return {
    ...(args.postId ? { post: args.postId } : {}),
    ...(args.url ? { url: args.url } : {}),
    ...(args.sort ? { sort: args.sort as RedditThreadOverviewRequest['sort'] } : {}),
    ...(args.maxComments ? { maxComments: args.maxComments } : {}),
  };
}

function toMcpRedditThread(response: unknown): Record<string, unknown> {
  const record = asRecord(response);
  const comments = flattenRedditComments(record['comments']).slice(0, maxMcpComments);
  return {
    source: 'reddit',
    fetchedAt: stringValue(record['fetchedAt']),
    input: stringValue(record['input']),
    post: toMcpRedditPost(record['post']),
    comments,
    continuations: arrayValue(record['commentContinuations']).map(toMcpRedditContinuation),
    stats: asRecord(record['stats']),
    redditRateLimit: record['redditRateLimit'],
  };
}

function toMcpRedditOverview(response: unknown): Record<string, unknown> {
  const record = asRecord(response);
  return {
    source: 'reddit',
    fetchedAt: stringValue(record['fetchedAt']),
    input: stringValue(record['input']),
    post: toMcpRedditPost(record['post']),
    stats: asRecord(record['stats']),
    coverage: asRecord(record['coverage']),
    availableSorts: arrayValue(record['availableSorts']).filter((value): value is string => typeof value === 'string'),
    redditRateLimit: record['redditRateLimit'],
  };
}

function toMcpRedditPost(value: unknown): Record<string, unknown> {
  const post = asRecord(value);
  return {
    id: stringValue(post['id']) ?? '',
    title: stringValue(post['title']) ?? '',
    subreddit: stringValue(post['subreddit']),
    author: stringValue(post['author']),
    url: stringValue(post['url']),
    permalink: stringValue(post['permalink']),
    score: numberValue(post['score']),
    commentCount: numberValue(post['numComments']),
    createdUtc: numberValue(post['createdUtc']),
    over18: booleanValue(post['over18']),
    locked: booleanValue(post['locked']),
    archived: booleanValue(post['archived']),
  };
}

function flattenRedditComments(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  for (const item of arrayValue(value)) {
    const comment = asRecord(item);
    const body = stringValue(comment['body']) ?? '';
    out.push({
      id: stringValue(comment['id']) ?? '',
      parentId: stringValue(comment['parentId']),
      author: stringValue(comment['author']),
      body: truncate(body, maxCommentBodyChars),
      score: numberValue(comment['score']),
      depth: numberValue(comment['depth']),
      createdUtc: numberValue(comment['createdUtc']),
      truncated: body.length > maxCommentBodyChars,
    });
    flattenRedditComments(comment['replies'], out);
  }
  return out;
}

function toMcpRedditContinuation(value: unknown): Record<string, unknown> {
  const continuation = asRecord(value);
  return {
    parentId: stringValue(continuation['parentId']) ?? '',
    depth: numberValue(continuation['depth']),
    childCount: numberValue(continuation['childCount']) ?? arrayValue(continuation['children']).length,
  };
}

async function toWlhSearchRequest(wlh: McpGatewayServices['wlh'], args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const categoryId = stringValue(args['categoryId']) ?? await inferWlhCategoryId(wlh, args);
  return {
    ...args,
    categoryId,
    ...(args['locationText'] && !args['requiredTerms'] ? { requiredTerms: [String(args['locationText'])] } : {}),
  };
}

async function inferWlhCategoryId(wlh: McpGatewayServices['wlh'], args: Record<string, unknown>): Promise<string> {
  const query = stringValue(args['categoryPath']) ?? stringValue(args['keyword']);
  if (query) {
    const matches = await findWlhCategories(wlh, query, 1);
    if (matches[0]) return matches[0].id;
  }
  return '0';
}

function toMcpWlhSearch(response: unknown, query: unknown): Record<string, unknown> {
  const record = asRecord(response);
  const results = arrayValue(record['results']).map(toMcpWlhListing).filter((listing) => listing.id.length > 0);
  return {
    source: 'wlh',
    query: compactRecord(asRecord(query)),
    totalApprox: numberValue(record['rowsFound']),
    rowsReturned: numberValue(record['rowsReturned']) ?? results.length,
    filteredRowsReturned: numberValue(record['filteredRowsReturned']) ?? results.length,
    category: toMcpWlhCategory(record['category']),
    results,
    sourceUrl: stringValue(record['sourceUrl']),
    fetchedAt: stringValue(record['fetchedAt']),
  };
}

function toMcpWlhListing(value: unknown): { id: string; [key: string]: unknown } {
  const listing = asRecord(value);
  return {
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
  };
}

function toMcpWlhOffer(response: unknown, fallbackAdId: string, inputUrl: unknown): Record<string, unknown> {
  const offer = asRecord(response);
  return {
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
    seller: compactRecord(asRecord(offer['seller'])),
    paylivery: booleanValue(offer['paylivery']) ?? false,
    deliveryOptions: arrayValue(offer['deliveryOptions']).map((option) => compactRecord(asRecord(option))),
    images: dedupeWlhImages(offer['images']),
    publishedAt: stringValue(offer['publishedAt']),
    changedAt: stringValue(offer['changedAt']),
  };
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

function extractWlhAdId(args: { adId?: string; url?: string }): string | undefined {
  if (args.adId?.trim()) return args.adId.trim();
  if (!args.url) return undefined;
  try {
    const parsed = new URL(args.url);
    if (!/(^|\.)willhaben\.at$/i.test(parsed.hostname)) return undefined;
    const queryAdId = parsed.searchParams.get('adId');
    if (queryAdId?.trim()) return queryAdId.trim();
    const match = parsed.pathname.match(/(?:^|[-/])(\d{6,})(?:$|[/?#])/);
    return match?.[1];
  } catch {
    const match = args.url.match(/(?:^|[-/])(\d{6,})(?:$|[/?#])/);
    return match?.[1];
  }
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
  const haystack = `${label} ${path}`.trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
