import type { WlhSearchRequest } from './types.js';

export class WlhInputError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const conditions = new Set(['new', 'like_new', 'used', 'defect']);
const deliveries = new Set(['pickup', 'shipping']);

export function normalizeSearchRequest(
  v: unknown,
): Required<Pick<WlhSearchRequest, 'categoryId' | 'rows' | 'page'>> & WlhSearchRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new WlhInputError('Invalid request body.', 'categoryId');
  const b = v as WlhSearchRequest;
  if (typeof b.categoryId !== 'string' || !b.categoryId.trim())
    throw new WlhInputError('categoryId is required.', 'categoryId');
  const rows = integerField(b.rows ?? 30, 'rows', 1, 100);
  const page = integerField(b.page ?? 1, 'page', 1);
  if (b.condition && !conditions.has(b.condition)) throw new WlhInputError('condition is invalid.', 'condition');
  if (b.delivery && (!Array.isArray(b.delivery) || b.delivery.some((d) => !deliveries.has(d))))
    throw new WlhInputError('delivery is invalid.', 'delivery');
  return { ...b, categoryId: b.categoryId.trim(), rows, page };
}

function integerField(value: unknown, field: 'rows' | 'page', min: number, max = Number.MAX_SAFE_INTEGER): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new WlhInputError(`${field} is invalid.`, field);
  }
  return numberValue;
}
