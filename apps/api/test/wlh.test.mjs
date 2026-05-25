process.env.WLH_BASE_URL='https://example.test';
process.env.WLH_STORAGE_ACCOUNT_NAME='local';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WlhService, searchUrlForCategory, wlhPathFromStoredUrl, mapWlhError } from '../dist/shared/wlh/service.js';
import { normalizeSearchRequest } from '../dist/shared/wlh/input.js';

const cfg = { baseUrl: 'https://example.test', storageAccountName: 'x', categoryBlobContainer: 'wlh-reference', categoryBlobName: 'categories-marketplace.v1.json.gz', categoryFile: '', categoryVersion: 'v1' };
const idx = { byId: new Map([['0',{id:'0',label:'root',path:'/',depth:0,hasChildren:true}],['10',{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true,url:'https://evil.example/cars?x=1'}],['11',{id:'11',label:'SUV',path:'/cars/suv',depth:2,parentId:'10',hasChildren:false}]]), childrenByParentId: new Map([['0',[{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true}]],['10',[{id:'11',label:'SUV',path:'/cars/suv',depth:2,parentId:'10',hasChildren:false}]]]), top:[{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true}] };

test('stored category url origin is discarded',()=>{ assert.equal(wlhPathFromStoredUrl('https://evil.example/a/b?x=1'),'/a/b'); assert.equal(searchUrlForCategory('https://evil.example/a/b?x=1',cfg.baseUrl).toString(),'https://example.test/a/b'); });

test('invalid requiredTerms and prices are input errors',()=>{ assert.throws(()=>normalizeSearchRequest({categoryId:'10',requiredTerms:'x'})); assert.throws(()=>normalizeSearchRequest({categoryId:'10',priceFrom:'x'})); assert.throws(()=>normalizeSearchRequest({categoryId:'10',priceTo:'x'})); });

test('search payload rowsFound and date-string attributes', async()=>{ const html=`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{searchResult:{rowsFound:2,rowsRequested:30,rowsReturned:2,pageRequested:1,advertSummaryList:{advertSummary:[{id:'1',attributes:[{name:'HEADING',values:['red bike']},{name:'BODY_DYN',values:['fast']},{name:'SEO_URL',values:['/ad/1']},{name:'PUBLISHED_String',values:['2026-05-20T10:00:00Z']},{name:'CHANGED_String',values:['2026-05-21T10:00:00Z']}]},{id:'2',attributes:[{name:'HEADING',values:['blue car']},{name:'BODY_DYN',values:['slow']}]}]}}}}})}</script>`; const s=new WlhService({config:cfg,getIndex:async()=>idx,fetchImpl:async()=>new Response(html,{status:200})}); const out=await s.search({categoryId:'10',requiredTerms:['bike']}); assert.equal(out.rowsFound,2); assert.equal(out.filteredRowsReturned,1); });

test('detail paylivery false without p2p stays false', async()=>{ const html=`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{advertDetails:{attributes:[{name:'ADID',values:['abc']},{name:'PAYLIVERY',values:['false']},{name:'PRICE',values:['74,99']}]}}}})}</script>`; const s=new WlhService({config:cfg,getIndex:async()=>idx,fetchImpl:async()=>new Response(html,{status:200})}); const d=await s.offer('abc'); assert.equal(d.paylivery,false); assert.equal(d.priceAmount,74.99); });

test('handler returns invalid json 400', async()=>{ const { wlhSearchHandler } = await import('../dist/functions/wlhSearch.js'); const req={method:'POST',headers:new Headers(),json:async()=>{throw new Error('bad');}}; const res=await wlhSearchHandler(req,{}); assert.equal(res.status,400); });

test('map error keeps invalid input as 400', ()=>{ const e=(()=>{try{normalizeSearchRequest({categoryId:'10',requiredTerms:3});}catch(err){return err;}})(); assert.equal(mapWlhError(e).status,400); });
