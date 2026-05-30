import type { WlhConfig } from './types.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type WlhFetchErrorKind = 'rate_limit' | 'upstream' | 'fetch' | 'parse';

export class WlhFetchError extends Error {
  constructor(message: string, readonly status = 502, readonly kind: WlhFetchErrorKind = 'upstream') {
    super(message);
  }
}

export class WlhClient {
  constructor(private readonly config: WlhConfig, private readonly fetchImpl: FetchLike = fetch) {}

  resolveUrl(pathOrUrl: string): URL { return new URL(pathOrUrl, this.config.baseUrl); }

  async fetchNextData(pathOrUrl: string): Promise<{ url: string; data: any }> {
    const url = this.resolveUrl(pathOrUrl);
    let r: Response;
    try {
      r = await this.fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 wlh-api', 'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8', Accept: 'text/html,application/xhtml+xml' } });
    } catch {
      throw new WlhFetchError('upstream fetch failed', 502, 'fetch');
    }
    if (r.status === 429) throw new WlhFetchError('rate-limited', 429, 'rate_limit');
    if (!r.ok) throw new WlhFetchError('upstream failed', 502, 'upstream');
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new WlhFetchError('content parse failed', 502, 'parse');
    try {
      return { url: url.toString(), data: JSON.parse(m[1]) };
    } catch {
      throw new WlhFetchError('content parse failed', 502, 'parse');
    }
  }
}
