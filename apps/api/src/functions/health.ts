import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { logSmokeRunId } from '../shared/smokeCorrelation.js';
import { createHealthResponse } from '../shared/responses.js';

export async function healthHandler(
  _request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  logSmokeRunId(_request, _context, 'health');

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
