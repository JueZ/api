import type { WlhSearchRequest } from './types.js';
export class WlhInputError extends Error {}
export function normalizeSearchRequest(v: unknown): Required<Pick<WlhSearchRequest,'categoryId'|'rows'|'page'>> & WlhSearchRequest { if(!v||typeof v!=='object') throw new WlhInputError('Invalid request body.'); const b=v as WlhSearchRequest; if(typeof b.categoryId!=='string'||!b.categoryId.trim()) throw new WlhInputError('categoryId is required.'); return {...b,categoryId:b.categoryId.trim(),rows:Math.max(1,Math.min(100,Number(b.rows??30))),page:Math.max(1,Number(b.page??1))}; }
