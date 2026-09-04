import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { OPERATION_IDS } from '../application/operations/registry.js';
import { createYouTubeTranscriptService, youtubePrincipalPseudonym } from '../infrastructure/composition/youtube.js';
import { authorizeRequestForOperation } from '../shared/security/auth.js';
import {
  AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES,
  BodyTooLargeError,
  readRequestJsonWithLimit,
} from '../shared/http/boundedBody.js';
import { createCorsHeaders, withCorsHeaders } from '../shared/http/cors.js';
import { YouTubeError } from '../shared/youtube/types.js';

let service = createYouTubeTranscriptService();
export async function youtubeTranscriptHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS')
    return { status: 204, headers: createCorsHeaders(request, { methods: ['POST', 'OPTIONS'] }) };
  const auth = await authorizeRequestForOperation(request, context, OPERATION_IDS.youtubeTranscript);
  if (!auth.ok) return cors(auth.response, request);
  let body: unknown;
  try {
    body = await readRequestJsonWithLimit(request, AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES);
  } catch (e) {
    return problem(
      e instanceof BodyTooLargeError ? 413 : 400,
      e instanceof BodyTooLargeError ? 'request_body_too_large' : 'invalid_arguments',
      e instanceof BodyTooLargeError ? 'Request body exceeds the bounded limit.' : 'Request body must be valid JSON.',
      request,
    );
  }
  try {
    return cors(
      { status: 200, jsonBody: await service.getTranscript(body, youtubePrincipalPseudonym(auth.user)) },
      request,
    );
  } catch (e) {
    const error =
      e instanceof YouTubeError
        ? e
        : new YouTubeError('upstream_unavailable', 503, 'Transcript service is unavailable.');
    context.warn('YouTube transcript request failed.', {
      operation_id: OPERATION_IDS.youtubeTranscript,
      classification: error.code,
      status: error.status,
    });
    return problem(error.status, error.code, error.message, request);
  }
}
export function setYouTubeTranscriptServiceForTesting(value: typeof service | null) {
  service = value ?? createYouTubeTranscriptService();
}
function problem(status: number, code: string, detail: string, request: HttpRequest) {
  return cors(
    {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
      jsonBody: {
        type: `https://api.juez.at/problems/${code}`,
        title: 'YouTube transcript request failed',
        status,
        detail,
        code,
        retry_policy: { can_retry: status >= 500, same_request: status >= 500 },
      },
    },
    request,
  );
}
function cors(response: HttpResponseInit, request: HttpRequest) {
  return withCorsHeaders(request, response, { methods: ['POST', 'OPTIONS'] });
}
app.http('youtubeTranscript', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/youtube/transcript',
  handler: youtubeTranscriptHandler,
});
