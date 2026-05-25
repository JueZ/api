import { getCategoryIndex, type CategoryIndex } from './categoryStore.js';
import { WlhClient, WlhFetchError, type FetchLike } from './client.js';
import { readWlhConfig } from './config.js';
import { normalizeSearchRequest, WlhInputError } from './input.js';
import { htmlToText, normalizeText } from './normalize.js';
import type { WlhConfig } from './types.js';

const conditionMap: Record<string, string> = { new: '22', like_new: '2546', used: '23', defect: '24' };
const deliveryMap: Record<string, string> = { pickup: '2536', shipping: '2537' };
export class WlhNotFoundError extends Error {}

export class WlhService {
  private readonly client: WlhClient;
  constructor(private readonly deps: { fetchImpl?: FetchLike; config?: WlhConfig; getIndex?: () => Promise<CategoryIndex> } = {}) { this.client = new WlhClient(deps.config ?? readWlhConfig(), deps.fetchImpl); }
  private getIndex() { return this.deps.getIndex ? this.deps.getIndex() : getCategoryIndex(); }
  async topCategories() { return (await this.getIndex()).top; }
  async category(id: string) { const c = (await this.getIndex()).byId.get(id); if (!c) throw new WlhNotFoundError('not found'); return c; }
  async children(id: string) { const idx = await this.getIndex(); if (!idx.byId.has(id) && id !== '0') throw new WlhNotFoundError('not found'); return idx.childrenByParentId.get(id) ?? []; }

  async search(body: unknown) {
    const req = normalizeSearchRequest(body); const cat = await this.category(req.categoryId); const url = searchUrlForCategory(cat.url || cat.path || '/', this.client.resolveUrl('/').toString());
    if (req.keyword) url.searchParams.set('keyword', req.keyword); url.searchParams.set('rows', String(req.rows)); url.searchParams.set('page', String(req.page)); if (req.areaId) url.searchParams.set('areaId', req.areaId);
    if (req.priceFrom != null) url.searchParams.set('PRICE_FROM', String(req.priceFrom)); if (req.priceTo != null) url.searchParams.set('PRICE_TO', String(req.priceTo)); if (req.paylivery) url.searchParams.set('paylivery', 'true');
    if (req.condition) url.searchParams.append('treeAttributes', conditionMap[req.condition]); for (const d of req.delivery ?? []) url.searchParams.append('treeAttributes', deliveryMap[d]);
    const res = await this.client.fetchNextData(url.toString());
    const rows = (res.data?.props?.pageProps?.searchResult?.advertSummaryList?.advertSummary ?? []).map((x: any) => mapRow(x, this.client.resolveUrl('/').toString()));
    const terms = (req.requiredTerms ?? []).map(normalizeText).filter(Boolean); const filtered = terms.length ? rows.filter((r: any) => terms.every((t) => normalizeText(`${r.title} ${r._body}`).includes(t))) : rows;
    return { source: 'wlh', fetchedAt: new Date().toISOString(), sourceUrl: res.url, rowsFound: res.data?.props?.pageProps?.searchResult?.rowsFound ?? null, rowsReturned: rows.length, filteredRowsReturned: filtered.length, category: cat, results: filtered.map(({ _body, ...x }: any) => x) };
  }

  async offer(adId: string) {
    const detailUrl = new URL('/iad/object', this.client.resolveUrl('/')); detailUrl.searchParams.set('adId', adId);
    const d = (await this.client.fetchNextData(detailUrl.toString())).data?.props?.pageProps?.advertDetails ?? {};
    const attrs = normalizeAttributes(d?.attributes ?? d?.attribute ?? []);
    const locationBlock = d.advertAddressDetails ?? {}; const contact = flattenContactFields(d?.advertContactDetails);
    const p2p = d?.p2ppOptions; const paylivery = (parseBool(firstAttr(attrs, 'PAYLIVERY') ?? firstAttr(attrs, 'p2penabled')) === true) || Boolean((p2p?.deliveryOptions?.length ?? 0) || (p2p?.paymentOptions?.length ?? 0));
    const images = normalizeImages(d);
    return { id: String(firstAttr(attrs, 'ADID') ?? d.id ?? adId), title: String(firstAttr(attrs, 'HEADING') ?? d.title ?? ''), description: htmlToText(String(firstAttr(attrs, 'DESCRIPTION') ?? firstAttr(attrs, 'BODY_DYN') ?? d.description ?? '')),
      priceAmount: parsePrice(firstAttr(attrs, 'PRICE/AMOUNT') ?? firstAttr(attrs, 'PRICE')), priceDisplay: String(firstAttr(attrs, 'PRICE_FOR_DISPLAY') ?? d?.price?.description ?? ''), location: String(firstAttr(attrs, 'LOCATION') ?? firstAttr(attrs, 'DISTRICT') ?? locationBlock.postalName ?? locationBlock.district ?? contact.postalName ?? contact.district ?? ''), postcode: String(firstAttr(attrs, 'POSTCODE') ?? locationBlock.postCode ?? contact.postCode ?? ''), state: String(firstAttr(attrs, 'STATE') ?? locationBlock.province ?? contact.province ?? ''),
      publishedAt: parseDate(firstAttr(attrs, 'PUBLISHED') ?? firstAttr(attrs, 'PUBLISHED_String')), changedAt: parseDate(firstAttr(attrs, 'CHANGED') ?? firstAttr(attrs, 'CHANGED_String')), status: d?.advertStatus?.id ?? d.status,
      seller: { id: String(firstAttr(attrs, 'SELLER_ID') ?? firstAttr(attrs, 'ORGID') ?? firstAttr(attrs, 'ORG_UUID') ?? d?.seller?.id ?? ''), name: String(d?.seller?.name ?? '') },
      paylivery, deliveryOptions: (p2p?.deliveryOptions ?? []).map((o: any) => ({ carrier: o?.carrier?.description ?? o?.carrierName, parcelSize: o?.parcelSize?.size ?? o?.parcelSize?.longName, price: o?.price, originalPrice: o?.originalPrice, description: o?.description, deliveryDays: o?.deliveryDays, parcelInsurance: o?.parcelInsurance })), images };
  }
  async offerImages(adId: string) { return { source: 'wlh', adId, images: (await this.offer(adId)).images }; }
}

function mapRow(x: any, baseUrl: string) { const attrs = normalizeAttributes(x?.attributes ?? x?.attribute ?? []); const id = String(firstAttr(attrs, 'ADID') ?? x.id ?? x.advertId ?? ''); const seo = firstAttr(attrs, 'SEO_URL') ?? x?.seoUrl; const fall = `/iad/object?adId=${encodeURIComponent(id)}`; const listingPath = normalizeListingPath(typeof seo === 'string' && seo ? seo : fall); const url = new URL(listingPath, baseUrl); return { id, title: String(firstAttr(attrs, 'HEADING') ?? x.description ?? x.title ?? ''), priceAmount: parsePrice(firstAttr(attrs, 'PRICE/AMOUNT') ?? x?.price?.amount), priceDisplay: String(firstAttr(attrs, 'PRICE_FOR_DISPLAY') ?? x?.price?.description ?? ''), location: String(firstAttr(attrs, 'LOCATION') ?? x?.address?.city ?? ''), postcode: firstAttr(attrs, 'POSTCODE') ?? x?.address?.postcode, state: firstAttr(attrs, 'STATE') ?? x?.address?.state, publishedAt: parseDate(firstAttr(attrs, 'PUBLISHED_String') ?? firstAttr(attrs, 'PUBLISHED') ?? x?.published), changedAt: parseDate(firstAttr(attrs, 'CHANGED_String') ?? firstAttr(attrs, 'CHANGED') ?? x?.modified), paylivery: parseBool(firstAttr(attrs, 'PAYLIVERY') ?? firstAttr(attrs, 'p2penabled') ?? x?.areP2POptionsEnabled), sellerId: String(firstAttr(attrs, 'SELLER_ID') ?? x?.seller?.id ?? ''), url: url.toString(), imageCount: normalizeImages(x).length, thumbnailUrl: normalizeImages(x)[0]?.url, _body: String(firstAttr(attrs, 'BODY_DYN') ?? firstAttr(attrs, 'DESCRIPTION') ?? x?.text ?? '') }; }
function normalizeListingPath(value: string): string {
  const u = new URL(value, 'https://placeholder.invalid');
  if (u.pathname.startsWith('/iad/') || u.pathname === '/iad') return `${u.pathname}${u.search}`;
  if (u.pathname.startsWith('/kaufen-und-verkaufen/')) return `/iad${u.pathname}${u.search}`;
  return `${u.pathname}${u.search}`;
}
function mapRow(x: any, baseUrl: string) { const attrs = normalizeAttributes(x?.attributes ?? x?.attribute ?? []); const id = String(firstAttr(attrs, 'ADID') ?? x.id ?? x.advertId ?? ''); const seo = firstAttr(attrs, 'SEO_URL') ?? x?.seoUrl; const fall = `/iad/object?adId=${encodeURIComponent(id)}`; const url = new URL(typeof seo === 'string' && seo ? seo : fall, baseUrl); return { id, title: String(firstAttr(attrs, 'HEADING') ?? x.description ?? x.title ?? ''), priceAmount: parsePrice(firstAttr(attrs, 'PRICE/AMOUNT') ?? x?.price?.amount), priceDisplay: String(firstAttr(attrs, 'PRICE_FOR_DISPLAY') ?? x?.price?.description ?? ''), location: String(firstAttr(attrs, 'LOCATION') ?? x?.address?.city ?? ''), postcode: firstAttr(attrs, 'POSTCODE') ?? x?.address?.postcode, state: firstAttr(attrs, 'STATE') ?? x?.address?.state, publishedAt: parseDate(firstAttr(attrs, 'PUBLISHED_String') ?? firstAttr(attrs, 'PUBLISHED') ?? x?.published), changedAt: parseDate(firstAttr(attrs, 'CHANGED_String') ?? firstAttr(attrs, 'CHANGED') ?? x?.modified), paylivery: parseBool(firstAttr(attrs, 'PAYLIVERY') ?? firstAttr(attrs, 'p2penabled') ?? x?.areP2POptionsEnabled), sellerId: String(firstAttr(attrs, 'SELLER_ID') ?? x?.seller?.id ?? ''), url: url.toString(), imageCount: normalizeImages(x).length, thumbnailUrl: normalizeImages(x)[0]?.url, _body: String(firstAttr(attrs, 'BODY_DYN') ?? firstAttr(attrs, 'DESCRIPTION') ?? x?.text ?? '') }; }
export function wlhPathFromStoredUrl(value: string): string { return new URL(value, 'https://placeholder.invalid').pathname; }
export function searchUrlForCategory(categoryUrl: string, baseUrl: string): URL { return new URL(wlhPathFromStoredUrl(categoryUrl), baseUrl); }
function normalizeAttributes(input: any): Record<string, unknown[]> { const list = Array.isArray(input) ? input : (Array.isArray(input?.attributes) ? input.attributes : Array.isArray(input?.attribute) ? input.attribute : []); const out: Record<string, unknown[]> = {}; for (const a of list) { const k = String(a?.name ?? '').trim(); if (!k) continue; out[k] = Array.isArray(a?.values) ? a.values : []; } return out; }
function firstAttr(attrs: Record<string, unknown[]>, key: string) { return attrs[key]?.[0]; }
function parsePrice(v: unknown): number | null { if (typeof v === 'number') return Number.isFinite(v) ? v : null; if (typeof v !== 'string') return null; const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? n : null; }
function parseDate(v: unknown): string | undefined { if (typeof v === 'number' || (typeof v === 'string' && /^\d{12,14}$/.test(v))) { const ms = Number(v); if (Number.isFinite(ms)) return new Date(ms).toISOString(); } if (typeof v === 'string' && v.trim()) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d.toISOString(); return v; } return undefined; }
function parseBool(v: unknown): boolean | null { if (typeof v === 'boolean') return v; if (typeof v === 'string') return ['1', 'true', 'yes'].includes(v.toLowerCase()) ? true : ['0', 'false', 'no'].includes(v.toLowerCase()) ? false : null; return null; }
function normalizeImages(d: any) { const arr = [ ...(d?.advertImageList?.advertImage ?? []), ...(d?.advertImageList?.images ?? []), ...(d?.images ?? []) ]; const urls = new Set<string>(); const out: any[] = []; for (const i of arr) for (const u of [i?.referenceImageUrl, i?.mainImageUrl, i?.thumbnailImageUrl, i?.url, i?.baseUrl, i?.smallUrl]) if (typeof u === 'string' && u && !urls.has(u)) { urls.add(u); out.push({ id: String(i?.id ?? u), url: u }); } return out; }
export function mapWlhError(error: unknown) { if (error instanceof WlhInputError) return { status: 400, message: error.message }; if (error instanceof WlhNotFoundError) return { status: 404, message: error.message }; if (error instanceof WlhFetchError) return { status: error.status, message: error.message }; return { status: 502, message: 'wlh failure' }; }

function flattenContactFields(c:any){ const out:any={}; for(const cd of c?.contactDetail ?? []) for(const f of cd?.contactDetailField ?? []){ const key=String(f?.name??''); const val=f?.value; if(key && val!=null && out[key]==null) out[key]=val; } return out; }
