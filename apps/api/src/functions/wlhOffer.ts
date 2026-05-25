import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authorizeRequest } from '../shared/security/auth.js';
import { WlhService, mapWlhError } from '../shared/wlh/service.js';
let service = new WlhService(); export function setWlhOfferServiceForTesting(s:WlhService|null){service=s??new WlhService();}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS'};
async function handler(request:HttpRequest, context:InvocationContext):Promise<HttpResponseInit>{ if(request.method==='OPTIONS') return {status:204,headers:cors}; const auth=await authorizeRequest(request,context); if(!auth.ok) return { ...auth.response, headers:{...cors,...auth.response.headers}}; try{ const adId=request.params['adId']; const body=request.url.endsWith('/images')?await service.offerImages(adId):await service.offer(adId); return {status:200,headers:cors,jsonBody:body}; } catch(e){ const m=mapWlhError(e); return {status:m.status,headers:cors,jsonBody:{error:m.message}}; } }
app.http('wlhOffer',{methods:['GET','OPTIONS'],authLevel:'anonymous',route:'api/wlh/offers/{adId}',handler});
app.http('wlhOfferImages',{methods:['GET','OPTIONS'],authLevel:'anonymous',route:'api/wlh/offers/{adId}/images',handler});
