import type { WlhConfig } from './types.js';
import { BodyTooLargeError, readResponseTextWithLimit } from '../http/boundedBody.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type WlhFetchErrorKind = 'rate_limit' | 'upstream' | 'fetch' | 'parse' | 'timeout' | 'body_too_large';

export const WLH_REQUEST_TIMEOUT_MS = 15_000;
export const WLH_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

export class WlhFetchError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly kind: WlhFetchErrorKind = 'upstream',
  ) {
    super(message);
  }
}

export class WlhClient {
  constructor(
    private readonly config: WlhConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  resolveUrl(pathOrUrl: string): URL {
    return new URL(pathOrUrl, this.config.baseUrl);
  }

  async fetchNextData(pathOrUrl: string): Promise<{ url: string; data: any }> {
    const url = this.resolveUrl(pathOrUrl);
    let r: Response;
    try {
      r = await this.fetchImpl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 wlh-api',
          'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(WLH_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isAbortError(error)) throw new WlhFetchError('upstream request timed out', 504, 'timeout');
      throw new WlhFetchError('upstream fetch failed', 502, 'fetch');
    }
    if (r.status === 429) throw new WlhFetchError('rate-limited', 429, 'rate_limit');
    if (!r.ok) throw new WlhFetchError('upstream failed', 502, 'upstream');
    let html: string;
    try {
      html = await readResponseTextWithLimit(r, WLH_RESPONSE_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new WlhFetchError('upstream response exceeded the safe size limit', 502, 'body_too_large');
      }
      throw new WlhFetchError('upstream response could not be read', 502, 'fetch');
    }
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new WlhFetchError('content parse failed', 502, 'parse');
    try {
      return { url: url.toString(), data: JSON.parse(m[1]) };
    } catch {
      throw new WlhFetchError('content parse failed', 502, 'parse');
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}
