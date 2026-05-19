import { willhabenConfig } from './config.js';
import { getFilterSchema } from './filterSchema.js';
import { normalizeSearchInput } from './input.js';
import { SnapshotWillhabenCategoryProvider } from './categoryProvider.js';
import { buildSearchUrl } from './urlBuilder.js';

const cache = new Map<string, { value: unknown; expiresAt: number }>();
const provider = new SnapshotWillhabenCategoryProvider();

export class WillhabenService {
  listCategories(options: { tree?: boolean; q?: string } = {}) {
    const all = options.q ? provider.searchCategories(options.q) : provider.getFlatCategories();
    return {
      marketplace: 'willhaben',
      provider: 'snapshot',
      adTypeId: 67,
      fetchedAt: provider.getCategoryTree().fetchedAt,
      categories: all,
      tree: options.tree ? provider.getCategoryTree().categoryNode : undefined,
      diagnostics: { source: 'willhaben', provider: 'snapshot', cacheHit: true },
    };
  }

  getCategory(path: string[]) {
    const category = provider.findCategoryByCodePath(path);
    if (!category) throw Object.assign(new Error('unknown category'), { code: 'UNKNOWN_CATEGORY' });
    return { marketplace: 'willhaben', category };
  }

  getFilterSchema(categoryPath: string[]) {
    const category = provider.findCategoryByCodePath(categoryPath);
    if (!category) throw Object.assign(new Error('unknown category'), { code: 'UNKNOWN_CATEGORY' });
    const base = getFilterSchema(categoryPath.join('/'));
    return { ...base, categoryPath, filters: { ...base.filters, categoryAttributes: category.attributeReferences ?? [] } };
  }

  searchListings(input: unknown) {
    if (!willhabenConfig.enabled) throw Object.assign(new Error('disabled'), { code: 'WILLHABEN_DISABLED' });
    const request = normalizeSearchInput(input);
    const key = JSON.stringify(request);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return { ...(hit.value as any), diagnostics: { ...(hit.value as any).diagnostics, cacheHit: true } };
    const response = { marketplace: 'willhaben', query: request, results: [{ listingId: 'mock-1', title: request.keywords.join(' '), canonicalUrl: buildSearchUrl(request), price: { amount: request.price?.max ?? 22, currency: 'EUR', negotiable: null }, location: { label: '1080 Wien', city: 'Wien', postalCode: '1080', province: 'Wien' }, condition: 'used', fulfillment: { pickup: true, shipping: true, paylivery: true }, sellerType: 'private', thumbnailUrl: null, listedAt: null, fetchedAt: new Date().toISOString(), qualitySignals: { hasImage: false, hasPrice: true, priceWithinRequestedRange: true, missingCondition: false } }], pagination: { page: request.pagination?.page ?? 1, limit: request.pagination?.limit ?? 30, hasMore: false }, diagnostics: { source: 'willhaben', adapter: 'mock', cacheHit: false } };
    cache.set(key, { value: response, expiresAt: Date.now() + willhabenConfig.searchTtlSeconds * 1000 });
    return response;
  }

  getListing(listingId: string) {
    if (!willhabenConfig.enabled) throw Object.assign(new Error('disabled'), { code: 'WILLHABEN_DISABLED' });
    return { marketplace: 'willhaben', listingId, title: 'Mock listing', description: 'Mock description', price: { amount: 22, currency: 'EUR', negotiable: null }, condition: 'used', location: { label: '1080 Wien', city: 'Wien', postalCode: '1080', province: 'Wien' }, fulfillment: { pickup: true, shipping: true, paylivery: true }, seller: { sellerId: '1', type: 'private', displayName: 'Mock', rating: null, isVerified: null }, images: [], attributes: { raw: {} }, canonicalUrl: `https://www.willhaben.at/mock/${listingId}`, fetchedAt: new Date().toISOString(), qualitySignals: { hasImages: false, imageCount: 0, hasDescription: true, descriptionLength: 16, hasPaylivery: true, suspiciouslyLowPrice: false } };
  }
}

export function mapWillhabenError(error: unknown) {
  const code = (error as any)?.code ?? 'INTERNAL_SERVICE_ERROR';
  const status = code === 'WILLHABEN_DISABLED' ? 503 : code === 'UNKNOWN_CATEGORY' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500;
  return { code, status, message: (error as any)?.message ?? 'error' };
}
