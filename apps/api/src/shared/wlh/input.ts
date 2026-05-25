import type { WlhSearchRequest } from './types.js';
export class WlhInputError extends Error {}
const conditions = new Set(['new', 'like_new', 'used', 'defect']);
const deliveries = new Set(['pickup', 'shipping']);

export function normalizeSearchRequest(v: unknown): Required<Pick<WlhSearchRequest, 'categoryId' | 'rows' | 'page'>> & WlhSearchRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new WlhInputError('Invalid request body.');
  const b = v as WlhSearchRequest;
  if (typeof b.categoryId !== 'string' || !b.categoryId.trim()) throw new WlhInputError('categoryId is required.');
  if (b.keyword != null && typeof b.keyword !== 'string') throw new WlhInputError('keyword is invalid.');
  if (b.areaId != null && typeof b.areaId !== 'string') throw new WlhInputError('areaId is invalid.');
  if (b.paylivery != null && typeof b.paylivery !== 'boolean') throw new WlhInputError('paylivery is invalid.');

  const rows = parseFiniteInt(b.rows, 30, 1, 100, 'rows');
  const page = parseFiniteInt(b.page, 1, 1, Number.MAX_SAFE_INTEGER, 'page');
  const priceFrom = parseFiniteNumber(b.priceFrom, 'priceFrom');
  const priceTo = parseFiniteNumber(b.priceTo, 'priceTo');

  if (b.condition && !conditions.has(b.condition)) throw new WlhInputError('condition is invalid.');
  if (b.delivery && (!Array.isArray(b.delivery) || b.delivery.some((d) => !deliveries.has(d)))) throw new WlhInputError('delivery is invalid.');
  if (b.requiredTerms != null && (!Array.isArray(b.requiredTerms) || b.requiredTerms.some((t) => typeof t !== 'string'))) throw new WlhInputError('requiredTerms is invalid.');

  return { ...b, categoryId: b.categoryId.trim(), rows, page, ...(priceFrom != null ? { priceFrom } : {}), ...(priceTo != null ? { priceTo } : {}) };
}

function parseFiniteInt(v: unknown, fallback: number, min: number, max: number, field: string): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new WlhInputError(`${field} is invalid.`);
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function parseFiniteNumber(v: unknown, field: string): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new WlhInputError(`${field} is invalid.`);
  return n;
}
