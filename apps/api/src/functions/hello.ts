import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { logSmokeRunId } from '../shared/smokeCorrelation.js';
import { createHelloResponse } from '../shared/responses.js';
import { authorizeRequest } from '../shared/security/auth.js';

export async function helloHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  logSmokeRunId(request, context, 'hello');

  if (request.method === 'OPTIONS') {
    return {
      status: 204,
      headers: corsHeaders(),
    };
  }

  const authorization = await authorizeRequest(request, context);

  if (!authorization.ok) {
    return withCors(authorization.response);
  }

  return withCors({
    status: 200,
    jsonBody: createHelloResponse(authorization.user),
  });
}

app.http('hello', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/hello',
  handler: helloHandler,
});

function withCors(response: HttpResponseInit): HttpResponseInit {
  return {
    ...response,
    headers: {
      ...corsHeaders(),
      ...response.headers,
    },
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}
