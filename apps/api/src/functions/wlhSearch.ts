import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getTraceIdFromRequestOrContext } from '../shared/errors/diagnosticCapsule.js';
import { authorizeRequestForOperation } from '../shared/security/auth.js';
import { OPERATION_IDS } from '../application/operations/registry.js';
import { createCorsHeaders, type CorsOptions } from '../shared/http/cors.js';
import {
  buildWlhProblem,
  resolveWlhProblemForError,
  WLH_OPERATION_IDS,
  wlhProblemResponse,
} from '../shared/wlh/problem.js';
import { WlhService } from '../shared/wlh/service.js';

let service: WlhService | null = null;
export function setWlhSearchServiceForTesting(s: WlhService | null) {
  service = s;
}
function currentService(): WlhService {
  return (service ??= new WlhService());
}

const corsOptions = { methods: ['POST', 'OPTIONS'] } satisfies CorsOptions;

export async function wlhSearchHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: corsHeaders(request) };
  const auth = await authorizeRequestForOperation(request, context, OPERATION_IDS.wlhSearch);
  if (!auth.ok) return { ...auth.response, headers: { ...corsHeaders(request), ...auth.response.headers } };
  const traceId = getTraceIdFromRequestOrContext(request, context);
  let body;
  try {
    body = await request.json();
  } catch {
    return wlhProblemResponse(
      buildWlhProblem({ operationId: WLH_OPERATION_IDS.postWlhSearch, failureKind: 'invalid_json', traceId }),
      corsHeaders(request),
    );
  }
  try {
    return { status: 200, headers: corsHeaders(request), jsonBody: await currentService().search(body) };
  } catch (e) {
    const problem = await resolveWlhProblemForError({
      operationId: WLH_OPERATION_IDS.postWlhSearch,
      error: e,
      traceId,
      body,
    });
    if (problem.status >= 500) {
      context.warn('WLH search failed with a repairable error contract.', {
        operation_id: problem.operation_id,
        diagnostic_id: problem.diagnostic_id,
        classification: problem.classification,
        status: problem.status,
        safe_debug_summary: problem.safe_debug_summary,
      });
    }
    return wlhProblemResponse(problem, corsHeaders(request));
  }
}

app.http('wlhSearch', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/wlh/search',
  handler: wlhSearchHandler,
});

function corsHeaders(request?: HttpRequest): Record<string, string> {
  return createCorsHeaders(request, corsOptions);
}
