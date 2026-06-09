import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { buildMcpProtectedResourceMetadata } from '../mcp/auth.js';
import { createCorsHeaders, type CorsOptions } from '../shared/http/cors.js';

const corsOptions = { methods: ['GET', 'OPTIONS'] } satisfies CorsOptions;

export async function oauthProtectedResourceHandler(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: corsHeaders(request) };
  return { status: 200, headers: corsHeaders(request), jsonBody: buildMcpProtectedResourceMetadata(request) };
}

app.http('oauthProtectedResource', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '.well-known/oauth-protected-resource',
  handler: oauthProtectedResourceHandler,
});

function corsHeaders(request?: HttpRequest): Record<string, string> {
  return createCorsHeaders(request, corsOptions);
}
