import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { logSmokeRunId } from '../shared/smokeCorrelation.js';
import { createHelloResponse } from '../shared/responses.js';
import { authorizeRequest } from '../shared/security/auth.js';
import { createCorsHeaders, withCorsHeaders, type CorsOptions } from '../shared/http/cors.js';

export async function helloHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  logSmokeRunId(request, context, 'hello');

  if (request.method === 'OPTIONS') {
    return {
      status: 204,
      headers: corsHeaders(request),
    };
  }

  const authorization = await authorizeRequest(request, context);

  if (!authorization.ok) {
    return withCors(authorization.response, request);
  }

  return withCors({
    status: 200,
    jsonBody: createHelloResponse(authorization.user),
  }, request);
}

app.http('hello', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/hello',
  handler: helloHandler,
});

const corsOptions = { methods: ['GET', 'OPTIONS'] } satisfies CorsOptions;

function withCors(response: HttpResponseInit, request?: HttpRequest): HttpResponseInit {
  return withCorsHeaders(request, response, corsOptions);
}

function corsHeaders(request?: HttpRequest): Record<string, string> {
  return createCorsHeaders(request, corsOptions);
}
