import type { WlhSearchRequest } from './types.js';
export class WlhInputError extends Error {}
const conditions = new Set(['new','like_new','used','defect']);
const deliveries = new Set(['pickup','shipping']);
export function normalizeSearchRequest(v: unknown): Required<Pick<WlhSearchRequest,'categoryId'|'rows'|'page'>> & WlhSearchRequest {
  if(!v||typeof v!=='object') throw new WlhInputError('Invalid request body.');
  const b=v as WlhSearchRequest;
  if(typeof b.categoryId!=='string'||!b.categoryId.trim()) throw new WlhInputError('categoryId is required.');
  const rawRows = b.rows ?? 30; const rowsNum = typeof rawRows==='number'?rawRows:Number(rawRows);
  const rows = Number.isFinite(rowsNum)?Math.max(1,Math.min(100,Math.trunc(rowsNum))):30;
  const rawPage = b.page ?? 1; const pageNum = typeof rawPage==='number'?rawPage:Number(rawPage);
  const page = Number.isFinite(pageNum)?Math.max(1,Math.trunc(pageNum)):1;
  if(b.condition && !conditions.has(b.condition)) throw new WlhInputError('condition is invalid.');
  if(b.delivery && (!Array.isArray(b.delivery) || b.delivery.some((d)=>!deliveries.has(d)))) throw new WlhInputError('delivery is invalid.');
  return {...b,categoryId:b.categoryId.trim(),rows,page};
}
