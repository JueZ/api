import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { handleMcpHttpRequest } from '../mcp/server.js';

export async function mcpHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return handleMcpHttpRequest(request, context);
}

app.http('mcp', {
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'mcp',
  handler: mcpHandler,
});
