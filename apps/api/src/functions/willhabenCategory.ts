import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authorizeRequest } from '../shared/security/auth.js';
import { mapWillhabenError, WillhabenService } from '../shared/willhaben/service.js';

const service = new WillhabenService();
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

export async function willhabenCategoryHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return { status: 204, headers: cors };
  const auth = await authorizeRequest(request, context);
  if (!auth.ok) return { ...auth.response, headers: { ...cors, ...auth.response.headers } };
  try {
    const codePath = (request.params['codePath'] ?? '').split('/').filter(Boolean);
    return { status: 200, headers: cors, jsonBody: service.getCategory(codePath) };
  } catch (error) {
    const mapped = mapWillhabenError(error);
    return { status: mapped.status, headers: { ...cors, 'Content-Type': 'application/problem+json' }, jsonBody: { title: mapped.code, detail: mapped.message, status: mapped.status } };
  }
}

app.http('willhabenCategory', { methods: ['GET', 'OPTIONS'], authLevel: 'anonymous', route: 'api/marketplaces/willhaben/categories/{*codePath}', handler: willhabenCategoryHandler });
