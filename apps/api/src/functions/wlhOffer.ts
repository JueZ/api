import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getTraceIdFromRequestOrContext } from '../shared/errors/diagnosticCapsule.js';
import { authorizeRequest } from '../shared/security/auth.js';
import { buildWlhProblem, WLH_OPERATION_IDS, type WlhOperationId, wlhProblemForError, wlhProblemResponse } from '../shared/wlh/problem.js';
import { WlhService } from '../shared/wlh/service.js';

let service: WlhService | null = null;
export function setWlhOfferServiceForTesting(s: WlhService | null) { service = s; }
function currentService(): WlhService { return service ??= new WlhService(); }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: cors };
  const auth = await authorizeRequest(request, context);
  if (!auth.ok) return { ...auth.response, headers: { ...cors, ...auth.response.headers } };
  const traceId = getTraceIdFromRequestOrContext(request, context);
  const operationId = operationForRequest(request);
  const adId = request.params['adId'];
  if (!validAdId(adId)) {
    return wlhProblemResponse(buildWlhProblem({ operationId, failureKind: 'input_validation', field: 'adId', traceId }), cors);
  }
  try {
    const body = operationId === WLH_OPERATION_IDS.getWlhOfferImages ? await currentService().offerImages(adId) : await currentService().offer(adId);
    return { status: 200, headers: cors, jsonBody: body };
  } catch (e) {
    const problem = wlhProblemForError({ operationId, error: e, traceId });
    if (problem.status >= 500) {
      context.warn('WLH offer request failed with a repairable error contract.', {
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

app.http('wlhOffer', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/wlh/offers/{adId}', handler });
app.http('wlhOfferImages', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/wlh/offers/{adId}/images', handler });

function operationForRequest(request: HttpRequest): WlhOperationId {
  const pathname = new URL(request.url).pathname;
  return pathname.endsWith('/images') ? WLH_OPERATION_IDS.getWlhOfferImages : WLH_OPERATION_IDS.getWlhOffer;
}

function validAdId(adId: unknown): adId is string {
  return typeof adId === 'string' && adId.trim().length > 0;
}
