import { WILLHABEN_CATEGORIES } from './categories.js';
import { willhabenConfig } from './config.js';
import { getFilterSchema } from './filterSchema.js';
import { normalizeSearchInput } from './input.js';
import { buildSearchUrl } from './urlBuilder.js';

const cache = new Map<string, { value: unknown; expiresAt: number }>();
const now = (): number => Date.now();

export class WillhabenService {
  listCategories(): { marketplace: 'willhaben'; categories: typeof WILLHABEN_CATEGORIES } {
    return { marketplace: 'willhaben', categories: [...WILLHABEN_CATEGORIES] };
  }

  getFilterSchema(categorySlug: string) {
    if (!WILLHABEN_CATEGORIES.some((category) => category.slug === categorySlug)) {
      throw Object.assign(new Error('unknown category'), { code: 'UNKNOWN_CATEGORY' });
    }
    return getFilterSchema(categorySlug);
  }

  searchListings(input: unknown) {
    if (!willhabenConfig.enabled) throw Object.assign(new Error('disabled'), { code: 'WILLHABEN_DISABLED' });

    const request = normalizeSearchInput(input);
    const cacheKey = `s:${JSON.stringify(request)}`;
    const cacheEntry = cache.get(cacheKey);

    if (cacheEntry && cacheEntry.expiresAt > now()) {
      const payload = cacheEntry.value as Record<string, unknown>;
      return {
        ...payload,
        diagnostics: {
          ...(payload['diagnostics'] as Record<string, unknown>),
          cacheHit: true,
        },
      };
    }

    const response = {
      marketplace: 'willhaben',
      query: request,
      results: [
        {
          listingId: 'mock-1',
          title: request.keywords.join(' '),
          price: { amount: request.price?.max ?? 22, currency: 'EUR', negotiable: null },
          location: { label: '1080 Wien', city: 'Wien', postalCode: '1080', province: 'Wien' },
          condition: request.condition?.[0] ?? 'used',
          fulfillment: { pickup: true, shipping: true, paylivery: true },
          sellerType: 'private',
          thumbnailUrl: null,
          canonicalUrl: buildSearchUrl(request),
          listedAt: null,
          fetchedAt: new Date().toISOString(),
          qualitySignals: {
            hasImage: false,
            hasPrice: true,
            priceWithinRequestedRange: true,
            missingCondition: false,
          },
        },
      ],
      pagination: { page: request.pagination?.page ?? 1, limit: request.pagination?.limit ?? 30, hasMore: false },
      diagnostics: { source: 'willhaben', adapter: 'mock', cacheHit: false },
    };

    cache.set(cacheKey, { value: response, expiresAt: now() + willhabenConfig.searchTtlSeconds * 1000 });
    return response;
  }

  getListing(listingId: string) {
    if (!willhabenConfig.enabled) throw Object.assign(new Error('disabled'), { code: 'WILLHABEN_DISABLED' });
    return {
      marketplace: 'willhaben',
      listingId,
      title: 'Mock listing',
      description: 'Mock description',
      price: { amount: 22, currency: 'EUR', negotiable: null },
      condition: 'used',
      location: { label: '1080 Wien', city: 'Wien', postalCode: '1080', province: 'Wien' },
      fulfillment: { pickup: true, shipping: true, paylivery: true },
      seller: { sellerId: '1', type: 'private', displayName: 'Mock', rating: null, isVerified: null },
      images: [],
      attributes: { raw: {} },
      canonicalUrl: `https://www.willhaben.at/mock/${listingId}`,
      fetchedAt: new Date().toISOString(),
      qualitySignals: {
        hasImages: false,
        imageCount: 0,
        hasDescription: true,
        descriptionLength: 16,
        hasPaylivery: true,
        suspiciouslyLowPrice: false,
      },
    };
  }
}

export function mapWillhabenError(error: unknown): { code: string; status: number; message: string } {
  const code = (error as { code?: string })?.code ?? 'INTERNAL_SERVICE_ERROR';
  const status = code === 'WILLHABEN_DISABLED' ? 503 : code === 'UNKNOWN_CATEGORY' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500;
  const message = (error as { message?: string })?.message ?? 'error';
  return { code, status, message };
}
