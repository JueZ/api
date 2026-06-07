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

const redditSortSchema = z.enum(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);
const noauthSecuritySchemes = [{ type: 'noauth' }];
const readOnlyAnnotations = { readOnlyHint: true };
const healthToolSecurity = { securitySchemes: noauthSecuritySchemes, _meta: { securitySchemes: noauthSecuritySchemes } };

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
const redditThreadOutputSchema = z.object({
  source: z.literal('reddit'),
  post: z.object({ id: z.string() }).passthrough(),
  stats: z.object({ commentsReturned: z.number() }).passthrough(),
}).passthrough();
const redditOverviewOutputSchema = z.object({
  source: z.literal('reddit'),
  post: z.object({ id: z.string() }).passthrough(),
  stats: z.object({ loadedSnapshotCommentCount: z.number() }).passthrough(),
}).passthrough();
const wlhSearchOutputSchema = z.object({
  source: z.literal('wlh').optional(),
  rowsReturned: z.number().optional(),
  filteredRowsReturned: z.number().optional(),
  results: z.array(z.unknown()).optional(),
}).passthrough();
const wlhOfferOutputSchema = z.object({ id: z.string() }).passthrough();
const wlhCategoriesOutputSchema = z.object({
  source: z.literal('wlh'),
  categories: z.array(z.unknown()),
}).passthrough();
const wlhCategoryChildrenOutputSchema = z.object({
  source: z.literal('wlh'),
  categoryId: z.string(),
  categories: z.array(z.unknown()),
}).passthrough();

export function createPrivateMcpServer(options: McpRequestOptions): McpServer {
  const server = new McpServer({ name: 'api-catalogue-private-mcp', version: MCP_VERSION });
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
      description: 'Check whether the private MCP gateway and API catalogue are reachable. Returns public health/build metadata only.',
      inputSchema: {},
      outputSchema: healthOutputSchema,
      annotations: readOnlyAnnotations,
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
      description: 'Verify OAuth linking by calling the same safe user response shape as GET /api/hello.',
      inputSchema: {},
      outputSchema: helloOutputSchema,
      annotations: readOnlyAnnotations,
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
      description: 'Fetch a read-only Reddit thread snapshot using the protected Reddit API service.',
      inputSchema: {
        post: z.string().optional(),
        url: z.string().optional(),
        redditUrl: z.string().optional(),
        reddit_url: z.string().optional(),
        threadUrl: z.string().optional(),
        thread_url: z.string().optional(),
        sort: redditSortSchema.optional(),
        maxComments: z.number().int().positive().optional(),
        maxMoreChildrenRequests: z.number().int().min(0).optional(),
      },
      outputSchema: redditThreadOutputSchema,
      annotations: readOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const response = await services.reddit.fetchThread(args as RedditThreadRequest);
      return textResult(response, `Fetched Reddit thread ${response.post.id} with ${response.stats.commentsReturned} comments.`);
    },
  );

  server.registerTool(
    'reddit_get_thread_overview',
    {
      title: 'Reddit thread overview',
      description: 'Fetch a compact read-only overview of a Reddit thread using the protected Reddit API service.',
      inputSchema: {
        post: z.string().optional(),
        url: z.string().optional(),
        redditUrl: z.string().optional(),
        reddit_url: z.string().optional(),
        threadUrl: z.string().optional(),
        thread_url: z.string().optional(),
        sort: redditSortSchema.optional(),
        maxComments: z.number().int().positive().optional(),
      },
      outputSchema: redditOverviewOutputSchema,
      annotations: readOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const response = await services.reddit.fetchThreadOverview(args as RedditThreadOverviewRequest);
      return textResult(response, `Fetched Reddit thread overview ${response.post.id}: ${response.stats.loadedSnapshotCommentCount} loaded comments.`);
    },
  );

  server.registerTool(
    'wlh_search',
    {
      title: 'WLH search',
      description: 'Search Willhaben/WLH offers using the protected WLH service.',
      inputSchema: {
        keyword: z.string().optional(),
        categoryId: z.string(),
        priceFrom: z.number().optional(),
        priceTo: z.number().optional(),
        areaId: z.string().optional(),
        paylivery: z.boolean().optional(),
        rows: z.number().int().positive().optional(),
        page: z.number().int().positive().optional(),
        condition: z.enum(['new', 'like_new', 'used', 'defect']).optional(),
        delivery: z.array(z.enum(['pickup', 'shipping'])).optional(),
        requiredTerms: z.array(z.string()).optional(),
      },
      outputSchema: wlhSearchOutputSchema,
      annotations: readOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async (args) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const response = await services.wlh.search(args);
      const summary = summarizeWlhSearch(response);
      return textResult(response, summary);
    },
  );

  server.registerTool(
    'wlh_get_offer',
    {
      title: 'WLH offer detail',
      description: 'Fetch one Willhaben/WLH offer detail using the protected WLH service.',
      inputSchema: { adId: z.string() },
      outputSchema: wlhOfferOutputSchema,
      annotations: readOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async ({ adId }) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const response = await services.wlh.offer(adId);
      return textResult(response, `Fetched WLH offer ${adId}.`);
    },
  );

  server.registerTool(
    'wlh_categories_top',
    {
      title: 'WLH top categories',
      description: 'List top-level Willhaben/WLH categories.',
      inputSchema: {},
      outputSchema: wlhCategoriesOutputSchema,
      annotations: readOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async () => {
      const authError = await requireAuth();
      if (authError) return authError;
      const categories = await services.wlh.topCategories();
      const structuredContent = { source: 'wlh', categories };
      return textResult(structuredContent, `Fetched ${categories.length} top WLH categories.`);
    },
  );

  server.registerTool(
    'wlh_category_children',
    {
      title: 'WLH category children',
      description: 'List child categories for a Willhaben/WLH category.',
      inputSchema: { categoryId: z.string() },
      outputSchema: wlhCategoryChildrenOutputSchema,
      annotations: readOnlyAnnotations,
      ...protectedToolSecurity,
    },
    async ({ categoryId }) => {
      const authError = await requireAuth();
      if (authError) return authError;
      const categories = await services.wlh.children(categoryId);
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

function summarizeWlhSearch(response: unknown): string {
  if (isRecord(response)) {
    const filtered = typeof response['filteredRowsReturned'] === 'number' ? response['filteredRowsReturned'] : undefined;
    const returned = typeof response['rowsReturned'] === 'number' ? response['rowsReturned'] : undefined;
    return `Fetched WLH search results (${filtered ?? returned ?? 'unknown'} returned).`;
  }
  return 'Fetched WLH search results.';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
