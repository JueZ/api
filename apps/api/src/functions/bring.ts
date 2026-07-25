import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getTraceIdFromRequestOrContext } from '../shared/errors/diagnosticCapsule.js';
import { createCorsHeaders, type CorsOptions } from '../shared/http/cors.js';
import { authorizeRequest } from '../shared/security/auth.js';
import { BRING_OPERATION_IDS, bringProblem, bringProblemResponse, type BringOperationId } from '../shared/bring/problem.js';
import { BringInputError, BringService } from '../shared/bring/service.js';

type BringApi = Pick<BringService, 'listLists' | 'getList' | 'addItems' | 'completeItems'>;
let service: BringApi | null = null;
export function setBringServiceForTesting(value: BringApi | null) { service = value; }
function currentService(): BringApi { return service ??= new BringService(); }
const corsOptions = { methods: ['GET', 'POST', 'OPTIONS'] } satisfies CorsOptions;

export async function bringHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const cors = createCorsHeaders(request, corsOptions);
  if (request.method === 'OPTIONS') return { status: 204, headers: cors };
  const auth = await authorizeRequest(request, context); if (!auth.ok) return { ...auth.response, headers: { ...cors, ...auth.response.headers } };
  const { operationId, listUuid } = routeInfo(request, context); const traceId = getTraceIdFromRequestOrContext(request, context);
  try {
    let body: unknown;
    if (operationId === BRING_OPERATION_IDS.listLists) body = await currentService().listLists();
    else if (operationId === BRING_OPERATION_IDS.getItems) body = await currentService().getList(listUuid);
    else { let input: any; try { input = await request.json(); } catch { throw new BringInputError('Request body must be valid JSON.', 'body'); } if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'items')) throw new BringInputError('Request body must contain only items.', 'body'); body = operationId === BRING_OPERATION_IDS.addItems ? await currentService().addItems(listUuid, input.items) : await currentService().completeItems(listUuid, input.items); }
    return { status: 200, headers: cors, jsonBody: body };
  } catch (error) { const problem = bringProblem(error, operationId, traceId); if (problem.status >= 500) context.warn('Bring request failed with a sanitized repairable error.', { operation_id: operationId, diagnostic_id: problem.diagnostic_id, classification: problem.classification, status: problem.status }); return bringProblemResponse(problem, cors); }
}
function routeInfo(request: HttpRequest, context: InvocationContext): { operationId: BringOperationId; listUuid?: string } { const listUuid = request.params['listUuid'] || undefined; const name = context.functionName; if (name === 'bringListLists') return { operationId: BRING_OPERATION_IDS.listLists }; if (name === 'bringGetItems') return { operationId: BRING_OPERATION_IDS.getItems, listUuid }; if (name === 'bringCompleteItems') return { operationId: BRING_OPERATION_IDS.completeItems, listUuid }; return { operationId: BRING_OPERATION_IDS.addItems, listUuid }; }
app.http('bringListLists', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/bring/lists', handler: bringHandler });
app.http('bringGetItems', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/bring/lists/{listUuid}/items', handler: bringHandler });
app.http('bringAddItems', { methods: ['POST', 'OPTIONS'], authLevel: 'anonymous', route: 'api/bring/lists/{listUuid}/items', handler: bringHandler });
app.http('bringCompleteItems', { methods: ['POST', 'OPTIONS'], authLevel: 'anonymous', route: 'api/bring/lists/{listUuid}/items/complete', handler: bringHandler });

