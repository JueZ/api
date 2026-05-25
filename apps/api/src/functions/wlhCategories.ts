import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authorizeRequest } from '../shared/security/auth.js';
import { WlhService, mapWlhError } from '../shared/wlh/service.js';
let service = new WlhService(); export function setWlhCategoryServiceForTesting(s:WlhService|null){service=s??new WlhService();}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS'};
async function handler(request:HttpRequest, context:InvocationContext):Promise<HttpResponseInit>{ if(request.method==='OPTIONS') return {status:204,headers:cors}; const auth=await authorizeRequest(request,context); if(!auth.ok) return { ...auth.response, headers:{...cors,...auth.response.headers}}; try { const id=request.params['categoryId']; let body; if(request.url.endsWith('/top')) body=await service.topCategories(); else if(request.url.endsWith('/children')) body=await service.children(id); else body=await service.category(id); return {status:200,headers:cors,jsonBody:body}; } catch(e){ const m=mapWlhError(e); return {status:m.status,headers:cors,jsonBody:{error:m.message}}; } }
app.http('wlhCategoriesTop',{methods:['GET','OPTIONS'],authLevel:'anonymous',route:'api/wlh/categories/top',handler});
app.http('wlhCategoryById',{methods:['GET','OPTIONS'],authLevel:'anonymous',route:'api/wlh/categories/{categoryId}',handler});
app.http('wlhCategoryChildren',{methods:['GET','OPTIONS'],authLevel:'anonymous',route:'api/wlh/categories/{categoryId}/children',handler});
