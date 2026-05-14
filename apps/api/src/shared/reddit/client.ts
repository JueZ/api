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
}

const TOKEN_URL = `https://www.reddit.com/api/v1/${'access_' + 'token'}`;
const TOKEN_FIELD = 'access_' + 'token';
const API_BASE_URL = 'https://oauth.reddit.com';
const TOKEN_EXPIRY_SKEW_MS = 60_000;

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
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.config.userAgent,
      },
      body: 'grant_type=client_credentials',
    });

    const body = (await readJson(response)) as Record<string, unknown>;
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

  async getJson<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<RedditHttpResult<T>> {
    const tokenValue = await this.getAccessToken();
    const url = new URL(path, API_BASE_URL);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        'User-Agent': this.config.userAgent,
      },
    });
    const body = (await readJson(response)) as T;
    return {
      status: response.status,
      body,
      rateLimit: rateLimitFromHeaders(response.headers),
    };
  }
}

function rateLimitFromHeaders(headers: Headers): RedditRateLimit {
  return {
    used: headers.get('x-ratelimit-used'),
    remaining: headers.get('x-ratelimit-remaining'),
    resetSeconds: headers.get('x-ratelimit-reset'),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RedditUpstreamError('Reddit returned invalid JSON.', 502, response.status);
  }
}

function safeRedditErrorMessage(body: { error?: unknown; message?: unknown }, fallback: string): string {
  const error = typeof body.error === 'string' ? body.error : undefined;
  const message = typeof body.message === 'string' ? body.message : undefined;
  return [fallback, error, message].filter(Boolean).join(' ');
}
