import { isSupportedRedditHost } from './input.js';
import { validateRedditConfig, type RedditConfig } from './config.js';
import type { RedditRateLimit } from './types.js';
import { BodyTooLargeError, readResponseTextWithLimit } from '../http/boundedBody.js';

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

export type RedditRedirectStatus = 'completed' | 'invalid_redirect' | 'unsafe_redirect' | 'max_redirects_exceeded';

export interface RedditRedirectResult {
  status: RedditRedirectStatus;
  finalUrl: string;
  redirectChain: string[];
  httpStatus?: number;
  contentType: string | null;
  safeReason: string;
  retryable: boolean;
  bodyText?: string;
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
const MAX_REDIRECT_BODY_BYTES = 256 * 1024;
export const REDDIT_JSON_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const REDIRECT_BODY_CONTENT_TYPES = ['text/html', 'text/plain'];
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

export class RedditRequestDeadlineError extends Error {
  constructor() {
    super('The Reddit request exceeded its server-owned deadline.');
    this.name = 'RedditRequestDeadlineError';
  }
}

export class RedditOAuthClient {
  private cachedToken: CachedToken | null = null;

  constructor(
    private readonly config: RedditConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getAccessToken(deadlineMs?: number): Promise<string> {
    validateRedditConfig(this.config);

    if (this.cachedToken && this.cachedToken.expiresAtMs > this.now()) {
      return this.cachedToken.token;
    }

    const credentials = Buffer.from(`${this.config.clientId}:${this.config.secret}`, 'utf8').toString('base64');
    const { response, text } = await this.fetchTextWithTimeout(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.config.userAgent,
        },
        body: 'grant_type=client_credentials',
      },
      deadlineMs,
    );

    const body = parseJsonText<Record<string, unknown>>(text, {
      request_url: TOKEN_URL,
      final_url: response.url || TOKEN_URL,
      status: response.status,
      reason: response.statusText,
      content_type: response.headers.get('content-type'),
      retryable: RETRYABLE_STATUSES.has(response.status),
    });
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
    const tokenValue = await this.getAccessToken();
    let url = validateRedirectUrl(inputUrl);
    const redirectChain = [url.toString()];
    let lastResponse: Response | null = null;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Authorization: `Bearer ${tokenValue}`,
          'User-Agent': this.config.userAgent,
        },
      });
      lastResponse = response;

      if (!isRedirectStatus(response.status)) {
        const finalUrl = response.url || url.toString();
        const finalValidation = safeValidateRedirectUrl(finalUrl);
        const contentType = response.headers.get('content-type');
        const bodyText = shouldReadRedirectBody(contentType)
          ? await readBoundedText(response, MAX_REDIRECT_BODY_BYTES)
          : undefined;
        if (!finalValidation.ok) {
          return {
            status: finalValidation.status,
            finalUrl,
            redirectChain,
            httpStatus: response.status,
            contentType,
            safeReason: finalValidation.safeReason,
            retryable: false,
            bodyText,
          };
        }
        if (redirectChain[redirectChain.length - 1] !== finalUrl) {
          redirectChain.push(finalUrl);
        }
        return {
          status: 'completed',
          finalUrl,
          redirectChain,
          httpStatus: response.status,
          contentType,
          safeReason:
            response.status >= 400
              ? `Reddit web returned HTTP ${response.status}.`
              : 'Reddit web redirect resolution completed.',
          retryable: response.status === 429 || response.status >= 500,
          bodyText,
        };
      }

      const location = response.headers.get('location');
      if (!location) {
        const contentType = response.headers.get('content-type');
        const bodyText = shouldReadRedirectBody(contentType)
          ? await readBoundedText(response, MAX_REDIRECT_BODY_BYTES)
          : undefined;
        return {
          status: 'completed',
          finalUrl: url.toString(),
          redirectChain,
          httpStatus: response.status,
          contentType,
          safeReason: `Reddit web returned redirect HTTP ${response.status} without a Location header.`,
          retryable: false,
          bodyText,
        };
      }
      const nextUrl = new URL(location, url).toString();
      const nextValidation = safeValidateRedirectUrl(nextUrl);
      if (!nextValidation.ok) {
        return {
          status: nextValidation.status,
          finalUrl: nextUrl,
          redirectChain: [...redirectChain, nextUrl],
          httpStatus: response.status,
          contentType: response.headers.get('content-type'),
          safeReason: nextValidation.safeReason,
          retryable: false,
        };
      }
      url = nextValidation.url;
      redirectChain.push(url.toString());
    }

    return {
      status: 'max_redirects_exceeded',
      finalUrl: url.toString(),
      redirectChain,
      httpStatus: lastResponse?.status,
      contentType: lastResponse?.headers.get('content-type') ?? null,
      safeReason: 'Reddit web redirect resolution exceeded the maximum redirect count.',
      retryable: false,
    };
  }

  async getJson<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    context: { input?: string; normalizedPostId?: string; deadlineMs?: number } = {},
  ): Promise<RedditHttpResult<T>> {
    const tokenValue = await this.getAccessToken(context.deadlineMs);
    const url = new URL(path, API_BASE_URL);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let retryCount = 0;
    for (let attempt = 0; ; attempt += 1) {
      const { response, text } = await this.fetchTextWithTimeout(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${tokenValue}`,
            'User-Agent': this.config.userAgent,
          },
        },
        context.deadlineMs,
      );
      const requestUrl = url.toString();
      const finalUrl = response.url || requestUrl;
      const contentType = response.headers.get('content-type');

      if (RETRYABLE_STATUSES.has(response.status) && attempt < 2) {
        retryCount += 1;
        const retryDelay = 50 * 2 ** attempt;
        if (context.deadlineMs !== undefined && this.now() + retryDelay >= context.deadlineMs) {
          throw new RedditRequestDeadlineError();
        }
        await delay(retryDelay);
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

  private async fetchTextWithTimeout(
    input: string | URL,
    init: RequestInit,
    deadlineMs?: number,
  ): Promise<{ response: Response; text: string }> {
    const remainingMs = deadlineMs === undefined ? REQUEST_TIMEOUT_MS : deadlineMs - this.now();
    if (remainingMs <= 0) throw new RedditRequestDeadlineError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));
    try {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
      let text: string;
      try {
        text = await readResponseTextWithLimit(response, REDDIT_JSON_RESPONSE_MAX_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw new RedditUpstreamError('Reddit response exceeded the safe size limit.', 502, response.status);
        }
        throw error;
      }
      return { response, text };
    } catch (error) {
      if (controller.signal.aborted && deadlineMs !== undefined) throw new RedditRequestDeadlineError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function shouldReadRedirectBody(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? '';
  return REDIRECT_BODY_CONTENT_TYPES.some((allowed) => normalized.includes(allowed));
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (totalBytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = maxBytes - totalBytes;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
    if (value.byteLength > remaining) break;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks, totalBytes));
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function rateLimitFromHeaders(headers: Headers): RedditRateLimit {
  return {
    used: headers.get('x-ratelimit-used'),
    remaining: headers.get('x-ratelimit-remaining'),
    resetSeconds: headers.get('x-ratelimit-reset'),
  };
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

function safeValidateRedirectUrl(
  value: string,
): { ok: true; url: URL } | { ok: false; status: 'invalid_redirect' | 'unsafe_redirect'; safeReason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, status: 'invalid_redirect', safeReason: 'Reddit redirect target is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, status: 'unsafe_redirect', safeReason: 'Reddit redirect target must use HTTPS.' };
  }
  if (!isSupportedRedditHost(url.hostname)) {
    return {
      ok: false,
      status: 'unsafe_redirect',
      safeReason: 'Reddit redirect target host is not an allowed Reddit host.',
    };
  }
  return { ok: true, url };
}

function redactPreview(text: string): string {
  return text
    .slice(0, 500)
    .replace(
      /(access_token|refresh_token|id_token|authorization|cookie|set-cookie)(["'\s:=]+)([^"'\s&<>]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [REDACTED]');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
