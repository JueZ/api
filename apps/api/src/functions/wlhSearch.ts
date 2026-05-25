import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authorizeRequest } from '../shared/security/auth.js';
import { WlhService, mapWlhError } from '../shared/wlh/service.js';
let service = new WlhService(); export function setWlhSearchServiceForTesting(s:WlhService|null){service=s??new WlhService();}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS'};
export async function wlhSearchHandler(request:HttpRequest, context:InvocationContext):Promise<HttpResponseInit>{ if(request.method==='OPTIONS') return {status:204,headers:cors}; const auth=await authorizeRequest(request,context); if(!auth.ok) return { ...auth.response, headers:{...cors,...auth.response.headers}}; let body; try{body=await request.json();}catch{return {status:400,headers:cors,jsonBody:{error:'Request body must be valid JSON.'}};} try{return {status:200,headers:cors,jsonBody:await service.search(body)};}catch(e){const m=mapWlhError(e); return {status:m.status,headers:cors,jsonBody:{error:m.message}};} }
app.http('wlhSearch',{methods:['POST','OPTIONS'],authLevel:'anonymous',route:'api/wlh/search',handler:wlhSearchHandler});
