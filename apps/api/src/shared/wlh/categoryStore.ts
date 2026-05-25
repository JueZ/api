import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { readWlhConfig } from './config.js';
import type { WlhCategory } from './types.js';

export interface CategoryIndex { byId: Map<string,WlhCategory>; childrenByParentId: Map<string,WlhCategory[]>; top: WlhCategory[] }
let cached: CategoryIndex | null = null;
export async function getCategoryIndex(): Promise<CategoryIndex> { if (cached) return cached; const raw = await loadRaw(); cached = buildIndex(raw); return cached; }
export function resetCategoryStoreForTesting(){ cached=null; }
export function setCategoryIndexForTesting(index: CategoryIndex | null){ cached=index; }

async function loadRaw(): Promise<any[]> { const cfg = readWlhConfig(); let text=''; if(cfg.categoryFile){text=await readFile(cfg.categoryFile,'utf8');} else {const url=`https://${cfg.storageAccountName}.blob.core.windows.net`; const bc = new BlobServiceClient(url,new DefaultAzureCredential()).getContainerClient(cfg.categoryBlobContainer).getBlobClient(cfg.categoryBlobName); const dl=await bc.download(); const chunks:Buffer[]=[]; for await (const ch of dl.readableStreamBody!) chunks.push(Buffer.from(ch)); const buf=Buffer.concat(chunks); text = cfg.categoryBlobName.endsWith('.gz')?gunzipSync(buf).toString('utf8'):buf.toString('utf8');} const parsed=JSON.parse(text); return Array.isArray(parsed.categories)?parsed.categories:[]; }
function buildIndex(rows:any[]):CategoryIndex{ const byId=new Map<string,WlhCategory>(); const childrenByParentId=new Map<string,WlhCategory[]>(); for(const row of rows){ const c:WlhCategory={id:String(row.id),label:String(row.label??''),path:String(row.path??''),depth:Number(row.depth??0),parentId:row.parent_id!=null?String(row.parent_id):undefined,hitCount:typeof row.hits==='number'?row.hits:undefined,hasChildren:Array.isArray(row.children)&&row.children.length>0,url:typeof row.url==='string'?row.url:undefined}; byId.set(c.id,c); const pid=c.parentId??'0'; if(!childrenByParentId.has(pid)) childrenByParentId.set(pid,[]); childrenByParentId.get(pid)!.push(c);} return {byId,childrenByParentId,top:childrenByParentId.get('0')??[]}; }
