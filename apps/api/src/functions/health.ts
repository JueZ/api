import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { createHealthResponse } from '../shared/responses.js';

export async function healthHandler(
  _request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: createHealthResponse(),
  };
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: healthHandler,
});
