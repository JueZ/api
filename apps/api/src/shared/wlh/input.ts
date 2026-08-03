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
const REQUIRED_TERMS_MAX_COUNT = 20;
const REQUIRED_TERM_MAX_LENGTH = 100;

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
  const delivery = normalizeDelivery(b.delivery);
  const requiredTerms = normalizeRequiredTerms(b.requiredTerms);
  return {
    ...b,
    categoryId: b.categoryId.trim(),
    rows,
    page,
    ...(delivery ? { delivery } : {}),
    ...(requiredTerms ? { requiredTerms } : {}),
  };
}

function normalizeDelivery(value: WlhSearchRequest['delivery']): WlhSearchRequest['delivery'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > deliveries.size || value.some((item) => !deliveries.has(item))) {
    throw new WlhInputError('delivery is invalid.', 'delivery');
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new WlhInputError('delivery must not contain duplicates.', 'delivery');
  return unique;
}

function normalizeRequiredTerms(value: WlhSearchRequest['requiredTerms']): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REQUIRED_TERMS_MAX_COUNT) {
    throw new WlhInputError('requiredTerms is invalid.', 'requiredTerms');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const term of value) {
    if (typeof term !== 'string') throw new WlhInputError('requiredTerms is invalid.', 'requiredTerms');
    const clean = term.trim();
    if (!clean || clean.length > REQUIRED_TERM_MAX_LENGTH) {
      throw new WlhInputError('requiredTerms is invalid.', 'requiredTerms');
    }
    const key = clean.toLocaleLowerCase('de-AT');
    if (seen.has(key)) throw new WlhInputError('requiredTerms must not contain duplicates.', 'requiredTerms');
    seen.add(key);
    normalized.push(clean);
  }
  return normalized;
}

function integerField(value: unknown, field: 'rows' | 'page', min: number, max = Number.MAX_SAFE_INTEGER): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new WlhInputError(`${field} is invalid.`, field);
  }
  return numberValue;
}
