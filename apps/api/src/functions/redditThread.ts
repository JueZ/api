import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authorizeRequest } from '../shared/security/auth.js';
import { mapRedditError, RedditThreadService } from '../shared/reddit/service.js';
import type { RedditThreadRequest } from '../shared/reddit/types.js';

const redditThreadService = new RedditThreadService();

export async function redditThreadHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
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

  let body: RedditThreadRequest;
  try {
    body = (await request.json()) as RedditThreadRequest;
  } catch {
    return withCors({
      status: 400,
      jsonBody: { error: 'Request body must be valid JSON.' },
    });
  }

  try {
    const response = await redditThreadService.fetchThread(body);
    return withCors({
      status: 200,
      jsonBody: response,
    });
  } catch (error) {
    const mapped = mapRedditError(error);
    if (mapped.status >= 500) {
      context.warn('Reddit thread fetch failed with a sanitized upstream error.');
    }
    return withCors({
      status: mapped.status,
      jsonBody: redditErrorBody(mapped),
    });
  }
}

app.http('redditThread', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/reddit/thread',
  handler: redditThreadHandler,
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function redditErrorBody(error: { message: string; code?: string; input?: string }): Record<string, string> {
  if (!error.code) {
    return { error: error.message };
  }

  return {
    error: error.code,
    message: error.message,
    ...(error.input ? { input: error.input } : {}),
  };
}
