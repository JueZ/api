import { isSupportedRedditHost } from './input.js';
import { validateRedditConfig, type RedditConfig } from './config.js';
import type { RedditRateLimit } from './types.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export interface RedditHttpResult<T> {
  status: number;
  body: T;
  rateLimit: RedditRateLimit;
  requestUrl: string;
  finalUrl: string;
  contentType: string | null;
  retryCount: number;
}

export interface RedditRedirectResult {
  finalUrl: string;
  redirectChain: string[];
  status: number;
  contentType: string | null;
}

export interface RedditFetchErrorDetails {
  input?: string;
  normalized_post_id?: string;
  request_url?: string;
  final_url?: string;
  status?: number;
  reason?: string;
  content_type?: string | null;
  response_preview?: string;
  redirect_chain?: string[];
  retryable: boolean;
}

const TOKEN_URL = `https://www.reddit.com/api/v1/${'access_' + 'token'}`;
const TOKEN_FIELD = 'access_' + 'token';
const API_BASE_URL = 'https://oauth.reddit.com';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class RedditUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'RedditUpstreamError';
  }
}

export class RedditFetchError extends Error {
  readonly input?: string;
  readonly normalized_post_id?: string;
  readonly request_url?: string;
  readonly final_url?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly content_type?: string | null;
  readonly response_preview?: string;
  readonly redirect_chain: string[];
  readonly retryable: boolean;

  constructor(message: string, details: RedditFetchErrorDetails) {
    super(message);
    this.name = 'RedditFetchError';
    this.input = details.input;
    this.normalized_post_id = details.normalized_post_id;
    this.request_url = details.request_url;
    this.final_url = details.final_url;
    this.status = details.status;
    this.reason = details.reason;
    this.content_type = details.content_type;
    this.response_preview = details.response_preview;
    this.redirect_chain = details.redirect_chain ?? [];
    this.retryable = details.retryable;
  }

  toJSON(): RedditFetchErrorDetails {
    return {
      input: this.input,
      normalized_post_id: this.normalized_post_id,
      request_url: this.request_url,
      final_url: this.final_url,
      status: this.status,
      reason: this.reason,
      content_type: this.content_type,
      response_preview: this.response_preview,
      redirect_chain: this.redirect_chain,
      retryable: this.retryable,
    };
  }
}

export class RedditOAuthClient {
  private cachedToken: CachedToken | null = null;

  constructor(
    private readonly config: RedditConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getAccessToken(): Promise<string> {
    validateRedditConfig(this.config);

    if (this.cachedToken && this.cachedToken.expiresAtMs > this.now()) {
      return this.cachedToken.token;
    }

    const credentials = Buffer.from(`${this.config.clientId}:${this.config.secret}`, 'utf8').toString('base64');
    const response = await this.fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.config.userAgent,
      },
      body: 'grant_type=client_credentials',
    });

    const body = (await readJson(response, { requestUrl: TOKEN_URL })) as Record<string, unknown>;
    if (!response.ok || typeof body[TOKEN_FIELD] !== 'string') {
      throw new RedditUpstreamError(safeRedditErrorMessage(body, 'Reddit token request failed.'), 502, response.status);
    }

    const expiresInSeconds = typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600;
    this.cachedToken = {
      token: body[TOKEN_FIELD] as string,
      expiresAtMs: this.now() + expiresInSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS,
    };

    return body[TOKEN_FIELD] as string;
  }

  async resolveRedditUrl(inputUrl: string): Promise<RedditRedirectResult> {
    validateRedditConfig(this.config);

    let url = validateRedirectUrl(inputUrl);
    const redirectChain = [url.toString()];
    let lastResponse: Response | null = null;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': this.config.userAgent,
        },
      });
      lastResponse = response;

      if (!isRedirectStatus(response.status)) {
        const finalUrl = response.url || url.toString();
        validateRedirectUrl(finalUrl);
        if (redirectChain[redirectChain.length - 1] !== finalUrl) {
          redirectChain.push(finalUrl);
        }
        return {
          finalUrl,
          redirectChain,
          status: response.status,
          contentType: response.headers.get('content-type'),
        };
      }

      const location = response.headers.get('location');
      if (!location) {
        return {
          finalUrl: url.toString(),
          redirectChain,
          status: response.status,
          contentType: response.headers.get('content-type'),
        };
      }
      url = validateRedirectUrl(new URL(location, url).toString());
      redirectChain.push(url.toString());
    }

    throw new RedditFetchError('Reddit redirect resolution exceeded the maximum redirect count.', {
      request_url: inputUrl,
      final_url: url.toString(),
      status: lastResponse?.status,
      reason: lastResponse?.statusText,
      content_type: lastResponse?.headers.get('content-type'),
      redirect_chain: redirectChain,
      retryable: false,
    });
  }

  async getJson<T>(path: string, query: Record<string, string | number | undefined> = {}, context: { input?: string; normalizedPostId?: string } = {}): Promise<RedditHttpResult<T>> {
    const tokenValue = await this.getAccessToken();
    const url = new URL(path, API_BASE_URL);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let retryCount = 0;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          'User-Agent': this.config.userAgent,
        },
      });
      const requestUrl = url.toString();
      const finalUrl = response.url || requestUrl;
      const contentType = response.headers.get('content-type');
      const text = await response.text();

      if (RETRYABLE_STATUSES.has(response.status) && attempt < 2) {
        retryCount += 1;
        await delay(50 * 2 ** attempt);
        continue;
      }

      const body = parseJsonText<T>(text, {
        input: context.input,
        normalized_post_id: context.normalizedPostId,
        request_url: requestUrl,
        final_url: finalUrl,
        status: response.status,
        reason: response.statusText,
        content_type: contentType,
        retryable: RETRYABLE_STATUSES.has(response.status),
      });

      return {
        status: response.status,
        body,
        rateLimit: rateLimitFromHeaders(response.headers),
        requestUrl,
        finalUrl,
        contentType,
        retryCount,
      };
    }
  }

  private async fetchWithTimeout(input: string | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function rateLimitFromHeaders(headers: Headers): RedditRateLimit {
  return {
    used: headers.get('x-ratelimit-used'),
    remaining: headers.get('x-ratelimit-remaining'),
    resetSeconds: headers.get('x-ratelimit-reset'),
  };
}

async function readJson(response: Response, context: { requestUrl: string }): Promise<unknown> {
  const text = await response.text();
  return parseJsonText(text, {
    request_url: context.requestUrl,
    final_url: response.url || context.requestUrl,
    status: response.status,
    reason: response.statusText,
    content_type: response.headers.get('content-type'),
    retryable: RETRYABLE_STATUSES.has(response.status),
  });
}

function parseJsonText<T>(text: string, details: Omit<RedditFetchErrorDetails, 'response_preview'>): T {
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = details.content_type ?? '';
    const message = contentType.toLowerCase().includes('text/html')
      ? 'Expected Reddit JSON but received text/html. This often means `.json` was appended before resolving a Reddit share URL or Reddit redirected to a subreddit/feed page.'
      : 'Expected Reddit JSON but received a non-JSON response.';
    throw new RedditFetchError(message, {
      ...details,
      response_preview: redactPreview(text),
    });
  }
}

function safeRedditErrorMessage(body: { error?: unknown; message?: unknown }, fallback: string): string {
  const error = typeof body.error === 'string' ? body.error : undefined;
  const message = typeof body.message === 'string' ? body.message : undefined;
  return [fallback, error, message].filter(Boolean).join(' ');
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function validateRedirectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RedditFetchError('Reddit redirect target is not a valid URL.', {
      final_url: value,
      retryable: false,
    });
  }
  if (url.protocol !== 'https:') {
    throw new RedditFetchError('Reddit redirect target must use HTTPS.', {
      final_url: url.toString(),
      retryable: false,
    });
  }
  if (!isSupportedRedditHost(url.hostname)) {
    throw new RedditFetchError('Reddit redirect target host is not supported.', {
      final_url: url.toString(),
      retryable: false,
    });
  }
  return url;
}

function redactPreview(text: string): string {
  return text
    .slice(0, 500)
    .replace(/(access_token|refresh_token|id_token|authorization|cookie|set-cookie)(["'\s:=]+)([^"'\s&<>]+)/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [REDACTED]');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
