import type { RedditRedirectResult } from './client.js';
import { isRedditShareUrl, parseDirectRedditPostInput, RedditInputError } from './input.js';

export type RedditShareResolution =
  | {
      status: 'resolved';
      originalUrl: string;
      finalUrl: string;
      cleanCanonicalUrl: string;
      postId: string;
      subreddit?: string;
      commentId?: string;
      redirectChain: string[];
      source: 'web_redirect';
    }
  | {
      status: 'blocked_by_reddit_web' | 'unresolved' | 'invalid_redirect' | 'unsafe_redirect' | 'max_redirects_exceeded';
      originalUrl: string;
      finalUrl?: string;
      redirectChain: string[];
      httpStatus?: number;
      contentType?: string | null;
      safeReason: string;
      retryable: boolean;
    };

export interface ResolveRedditShareUrlOptions {
  resolveRedirect: (inputUrl: string) => Promise<RedditRedirectResult>;
}

const BLOCKED_STATUSES = new Set([403, 429]);

export async function resolveRedditShareUrl(inputUrl: string, options: ResolveRedditShareUrlOptions): Promise<RedditShareResolution> {
  const originalUrl = inputUrl.trim();
  if (!isRedditShareUrl(originalUrl)) {
    throw new RedditInputError('post URL must be a supported Reddit /s/ share URL.', 'INVALID_REDDIT_INPUT', inputUrl);
  }

  const redirect = await options.resolveRedirect(originalUrl);
  const redirectChain = stripQueriesFromUrls(redirect.redirectChain.length > 0 ? redirect.redirectChain : [originalUrl]);

  if (redirect.status === 'unsafe_redirect' || redirect.status === 'invalid_redirect' || redirect.status === 'max_redirects_exceeded') {
    return {
      status: redirect.status,
      originalUrl,
      finalUrl: stripQueryFromUrl(redirect.finalUrl),
      redirectChain,
      httpStatus: redirect.httpStatus,
      contentType: redirect.contentType,
      safeReason: redirect.safeReason,
      retryable: redirect.retryable,
    };
  }

  const finalUrl = redirect.finalUrl;
  const normalized = parseDirectRedditPostInput(finalUrl);
  if (normalized && !isRedditShareUrl(finalUrl) && normalized.canonicalUrl) {
    return {
      status: 'resolved',
      originalUrl,
      finalUrl,
      cleanCanonicalUrl: normalized.canonicalUrl,
      postId: normalized.post_id,
      subreddit: normalized.subreddit,
      commentId: normalized.comment_id,
      redirectChain,
      source: 'web_redirect',
    };
  }

  const blocked = BLOCKED_STATUSES.has(redirect.httpStatus ?? 0);
  return {
    status: blocked ? 'blocked_by_reddit_web' : 'unresolved',
    originalUrl,
    finalUrl: stripQueryFromUrl(finalUrl),
    redirectChain,
    httpStatus: redirect.httpStatus,
    contentType: redirect.contentType,
    safeReason: blocked
      ? `Reddit web returned HTTP ${redirect.httpStatus} without exposing a canonical /comments/<id> redirect.`
      : 'Reddit web did not expose a canonical /comments/<id> redirect for this /s/ share URL.',
    retryable: redirect.retryable,
  };
}

export function stripQueryFromUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split('?')[0]?.split('#')[0] ?? value;
  }
}

function stripQueriesFromUrls(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const clean = stripQueryFromUrl(value);
    if (clean && result[result.length - 1] !== clean) {
      result.push(clean);
    }
  }
  return result;
}
