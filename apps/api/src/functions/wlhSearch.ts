import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getTraceIdFromRequestOrContext } from '../shared/errors/diagnosticCapsule.js';
import { authorizeRequest } from '../shared/security/auth.js';
import { buildWlhProblem, WLH_OPERATION_IDS, wlhProblemForError, wlhProblemResponse } from '../shared/wlh/problem.js';
import { WlhService } from '../shared/wlh/service.js';

let service: WlhService | null = null;
export function setWlhSearchServiceForTesting(s: WlhService | null) { service = s; }
function currentService(): WlhService { return service ??= new WlhService(); }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

export async function wlhSearchHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: cors };
  const auth = await authorizeRequest(request, context);
  if (!auth.ok) return { ...auth.response, headers: { ...cors, ...auth.response.headers } };
  const traceId = getTraceIdFromRequestOrContext(request, context);
  let body;
  try {
    body = await request.json();
  } catch {
    return wlhProblemResponse(buildWlhProblem({ operationId: WLH_OPERATION_IDS.postWlhSearch, failureKind: 'invalid_json', traceId }), cors);
  }
  try {
    return { status: 200, headers: cors, jsonBody: await currentService().search(body) };
  } catch (e) {
    const problem = wlhProblemForError({ operationId: WLH_OPERATION_IDS.postWlhSearch, error: e, traceId });
    if (problem.status >= 500) {
      context.warn('WLH search failed with a repairable error contract.', {
        operation_id: problem.operation_id,
        diagnostic_id: problem.diagnostic_id,
        classification: problem.classification,
        status: problem.status,
        safe_debug_summary: problem.safe_debug_summary,
      });
    }
    return wlhProblemResponse(problem, cors);
  }
}

app.http('wlhSearch', { methods: ['POST', 'OPTIONS'], authLevel: 'anonymous', route: 'api/wlh/search', handler: wlhSearchHandler });
