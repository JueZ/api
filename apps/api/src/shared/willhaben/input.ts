import { willhabenConfig } from './config.js';
import type {
  WillhabenCondition,
  WillhabenFulfillment,
  WillhabenSearchRequest,
  WillhabenSort,
} from './types.js';

const validConditions = new Set<WillhabenCondition>(['new', 'like_new', 'used', 'broken', 'exhibition']);
const validFulfillment = new Set<WillhabenFulfillment>(['pickup', 'shipping', 'paylivery']);
const validSorts = new Set<WillhabenSort>(['relevance', 'newest', 'price_asc', 'price_desc']);

export class WillhabenInputError extends Error {
  constructor(
    message: string,
    readonly code = 'VALIDATION_ERROR',
  ) {
    super(message);
  }
}

export function normalizeSearchInput(input: unknown): WillhabenSearchRequest {
  if (!input || typeof input !== 'object') throw new WillhabenInputError('body must be object');
  const body = input as WillhabenSearchRequest;

  if ('naturalLanguageQuery' in body) throw new WillhabenInputError('naturalLanguageQuery is not supported');
  if ((!body.categoryPath || !Array.isArray(body.categoryPath) || body.categoryPath.length===0) && !body.categorySlug) throw new WillhabenInputError('categoryPath is required');

  if (!Array.isArray(body.keywords) || body.keywords.length === 0) {
    throw new WillhabenInputError('keywords must be a non-empty array');
  }
  if (body.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim())) {
    throw new WillhabenInputError('keywords must only contain non-empty strings');
  }

  if (body.condition?.some((condition) => !validConditions.has(condition))) {
    throw new WillhabenInputError('invalid condition');
  }
  if (body.fulfillment?.some((item) => !validFulfillment.has(item))) {
    throw new WillhabenInputError('invalid fulfillment');
  }
  if (body.sort && !validSorts.has(body.sort)) {
    throw new WillhabenInputError('invalid sort');
  }

  const limit = Math.min(Math.max(1, body.pagination?.limit ?? 30), willhabenConfig.maxResultsLimit);

  return {
    ...body,
    price: {
      ...body.price,
      currency: body.price?.currency ?? 'EUR',
    },
    pagination: {
      page: body.pagination?.page ?? 1,
      limit,
    },
  };
}
