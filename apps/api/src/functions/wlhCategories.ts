import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getTraceIdFromRequestOrContext } from '../shared/errors/diagnosticCapsule.js';
import { authorizeRequest } from '../shared/security/auth.js';
import { buildWlhProblem, WLH_OPERATION_IDS, type WlhOperationId, wlhProblemForError, wlhProblemResponse } from '../shared/wlh/problem.js';
import { WlhService } from '../shared/wlh/service.js';

let service: WlhService | null = null;
export function setWlhCategoryServiceForTesting(s: WlhService | null) { service = s; }
function currentService(): WlhService { return service ??= new WlhService(); }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: cors };
  const auth = await authorizeRequest(request, context);
  if (!auth.ok) return { ...auth.response, headers: { ...cors, ...auth.response.headers } };
  const traceId = getTraceIdFromRequestOrContext(request, context);
  const { operationId, categoryId } = routeInfo(request);
  if ((operationId === WLH_OPERATION_IDS.getWlhCategory || operationId === WLH_OPERATION_IDS.getWlhCategoryChildren) && !validCategoryId(categoryId)) {
    return wlhProblemResponse(buildWlhProblem({ operationId, failureKind: 'input_validation', field: 'categoryId', traceId }), cors);
  }
  try {
    let body;
    if (operationId === WLH_OPERATION_IDS.getWlhCategoriesTop) body = await currentService().topCategories();
    else if (operationId === WLH_OPERATION_IDS.getWlhCategoryChildren) body = await currentService().children(categoryId);
    else body = await currentService().category(categoryId);
    return { status: 200, headers: cors, jsonBody: body };
  } catch (e) {
    const problem = wlhProblemForError({ operationId, error: e, traceId });
    if (problem.status >= 500) {
      context.warn('WLH category request failed with a repairable error contract.', {
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

app.http('wlhCategoriesTop', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/wlh/categories/top', handler });
app.http('wlhCategoryById', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/wlh/categories/{categoryId}', handler });
app.http('wlhCategoryChildren', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/wlh/categories/{categoryId}/children', handler });

function routeInfo(request: HttpRequest): { operationId: WlhOperationId; categoryId: string } {
  const categoryId = request.params['categoryId'];
  if (request.url.endsWith('/top')) return { operationId: WLH_OPERATION_IDS.getWlhCategoriesTop, categoryId: '' };
  if (request.url.endsWith('/children')) return { operationId: WLH_OPERATION_IDS.getWlhCategoryChildren, categoryId };
  return { operationId: WLH_OPERATION_IDS.getWlhCategory, categoryId };
}

function validCategoryId(categoryId: unknown): categoryId is string {
  return typeof categoryId === 'string' && categoryId.trim().length > 0;
}
