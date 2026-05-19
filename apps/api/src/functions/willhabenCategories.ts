import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authorizeRequest } from '../shared/security/auth.js';
import { WillhabenService } from '../shared/willhaben/service.js';
const service=new WillhabenService(); const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS'};
export async function willhabenCategoriesHandler(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{if(request.method==='OPTIONS')return {status:204,headers:cors}; const auth=await authorizeRequest(request,context); if(!auth.ok) return {...auth.response,headers:{...cors,...auth.response.headers}}; return {status:200,headers:cors,jsonBody:service.listCategories()};}
app.http('willhabenCategories',{methods:['GET','OPTIONS'],authLevel:'anonymous',route:'api/marketplaces/willhaben/categories',handler:willhabenCategoriesHandler});
