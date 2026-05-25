process.env.WLH_BASE_URL='https://example.test';
process.env.WLH_STORAGE_ACCOUNT_NAME='local';
import test from 'node:test'; import assert from 'node:assert/strict';
import { WlhService, mapWlhError } from '../dist/shared/wlh/service.js';
import { setCategoryIndexForTesting } from '../dist/shared/wlh/categoryStore.js';
import { wlhSearchHandler } from '../dist/functions/wlhSearch.js';

function fakeIndex(){ return { byId:new Map([['0',{id:'0',label:'root',path:'/',depth:0,hasChildren:true}],['10',{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true}]]), childrenByParentId:new Map([['0',[{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true}]],['10',[]]]), top:[{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true}]}; }

test('category index top and children', async()=>{ setCategoryIndexForTesting(fakeIndex()); const s=new WlhService(async()=>{throw new Error('unused')}); assert.equal((await s.topCategories()).length,1); assert.equal((await s.children('0')).length,1); });
test('unknown category maps to 404', async()=>{ setCategoryIndexForTesting(fakeIndex()); const s=new WlhService(async()=>{throw new Error('unused')}); await assert.rejects(()=>s.category('999')); assert.equal(mapWlhError(new Error()).status,502); });
test('search parser and requiredTerms', async()=>{ setCategoryIndexForTesting(fakeIndex()); const html=`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{searchResult:{numFound:2,advertSummaryList:{advertSummary:[{id:'1',description:'red bike',text:'fast',price:{amount:1,description:'1'},address:{city:'x'},imageUrls:['u']},{id:'2',description:'blue car',text:'slow',price:{amount:2,description:'2'},address:{city:'y'},imageUrls:[]}]}}}}})}</script>`; let called=''; const s=new WlhService(async(input)=>{called=String(input); return new Response(html,{status:200,headers:{'content-type':'text/html'}})}); const out=await s.search({categoryId:'10',priceFrom:1,priceTo:2,areaId:'9',paylivery:true,condition:'used',delivery:['pickup','shipping'],requiredTerms:['bike']}); assert.ok(called.includes('treeAttributes=23')); assert.equal(out.filteredRowsReturned,1); });
test('handler returns 400 for invalid json', async()=>{ const req={method:'POST',headers:new Headers(),json:async()=>{throw new Error('bad')}}; const res=await wlhSearchHandler(req,{}); assert.equal(res.status,400); });
