import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { buildMcpProtectedResourceMetadata } from '../mcp/auth.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function oauthProtectedResourceHandler(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: cors };
  return { status: 200, headers: cors, jsonBody: buildMcpProtectedResourceMetadata(request) };
}

app.http('oauthProtectedResource', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '.well-known/oauth-protected-resource',
  handler: oauthProtectedResourceHandler,
});
