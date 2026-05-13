import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { createHelloResponse } from '../shared/responses.js';

export async function helloHandler(
  _request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: createHelloResponse(),
  };
}

app.http('hello', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'api/hello',
  handler: helloHandler,
});
