import type { ParsedRedditPostInput, RedditSort } from './types.js';

const VALID_SORTS = new Set<RedditSort>(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);
const ARTICLE_ID_PATTERN = /^[a-z0-9][a-z0-9_]{1,12}$/i;
const COMMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_]{1,12}$/i;
const SUPPORTED_REDDIT_HOSTNAMES = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'redd.it',
]);
const REDDIT_WEB_HOSTNAMES = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
]);
export const MAX_MORE_CHILDREN_REQUESTS_PER_CALL = 10;

export interface NormalizedRedditPost {
  post_id: string;
  postId: string;
  fullname: string;
  subreddit?: string;
  comment_id?: string;
  commentId?: string;
  canonicalUrl?: string;
  finalUrl?: string;
  redirectChain: string[];
}

export interface RedditRedirectResolution {
  finalUrl: string;
  redirectChain?: string[];
}

export type RedditRedirectResolver = (inputUrl: string) => Promise<string | RedditRedirectResolution>;

export async function normalizeRedditPostInput(
  input: string,
  resolveRedirect?: RedditRedirectResolver,
): Promise<NormalizedRedditPost> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new RedditInputError('post must be a non-empty string.');
  }

  const trimmed = input.trim();
  const direct = parseDirectRedditPostInput(trimmed);
  if (direct) {
    return direct;
  }

  if (!isPotentialRedditUrl(trimmed)) {
    throw new RedditInputError('post must contain a valid Reddit article ID.');
  }

  if (isRedditShareUrl(trimmed)) {
    if (!resolveRedirect) {
      throw unresolvedRedditShareUrlError(trimmed);
    }
    const resolution = await resolveRedirect(trimmed);
    const finalUrl = typeof resolution === 'string' ? resolution : resolution.finalUrl;
    const redirectChain =
      typeof resolution === 'string'
        ? [trimmed, finalUrl]
        : [trimmed, ...(resolution.redirectChain ?? []), resolution.finalUrl];
    const normalized = parseDirectRedditPostInput(finalUrl);
    if (!normalized || isRedditShareUrl(finalUrl)) {
      throw unresolvedRedditShareUrlError(trimmed);
    }
    return {
      ...normalized,
      finalUrl,
      redirectChain: dedupeAdjacentRedirects(redirectChain),
    };
  }

  throw new RedditInputError('Reddit comments URL must include an article ID.');
}

export function parseRedditPostInput(input: unknown): ParsedRedditPostInput {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new RedditInputError('post must be a non-empty string.');
  }

  const post = input.trim();
  const normalized = parseDirectRedditPostInput(post);
  if (!normalized) {
    if (isRedditShareUrl(post)) {
      throw unresolvedRedditShareUrlError(post);
    }
    if (/^https?:\/\//i.test(post)) {
      throw new RedditInputError('post URL must be a supported Reddit comments URL.');
    }
    throw new RedditInputError('post must contain a valid Reddit article ID.');
  }

  return {
    articleId: normalized.post_id,
    fullname: normalized.fullname,
  };
}

export function normalizeRedditSort(input: unknown): RedditSort {
  if (input === undefined || input === null || input === '') {
    return 'confidence';
  }
  if (typeof input !== 'string' || !VALID_SORTS.has(input as RedditSort)) {
    throw new RedditInputError('sort must be one of confidence, top, new, controversial, old, or qa.');
  }
  return input as RedditSort;
}

export function normalizeMaxComments(input: unknown): number {
  if (input === undefined || input === null) {
    return 10000;
  }
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) {
    throw new RedditInputError('maxComments must be a positive integer.');
  }
  return Math.min(input, 10000);
}

export function normalizeMaxMoreChildrenRequests(input: unknown): number {
  if (input === undefined || input === null) {
    return 0;
  }
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    throw new RedditInputError('maxMoreChildrenRequests must be a non-negative integer.');
  }
  return Math.min(input, MAX_MORE_CHILDREN_REQUESTS_PER_CALL);
}

export class RedditInputError extends Error {
  constructor(
    message: string,
    readonly code = 'INVALID_REDDIT_INPUT',
    readonly input?: string,
  ) {
    super(message);
    this.name = 'RedditInputError';
  }
}

export function isRedditShareUrl(input: unknown): input is string {
  if (typeof input !== 'string' || !/^https:\/\//i.test(input)) {
    return false;
  }

  try {
    const url = new URL(input.trim());
    if (!REDDIT_WEB_HOSTNAMES.has(url.hostname.toLowerCase())) {
      return false;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 4 && parts[0]?.toLowerCase() === 'r' && parts[2]?.toLowerCase() === 's';
  } catch {
    return false;
  }
}

export function isSupportedRedditHost(hostname: string): boolean {
  return SUPPORTED_REDDIT_HOSTNAMES.has(hostname.toLowerCase());
}

export function unresolvedRedditShareUrlError(input: string): RedditInputError {
  return new RedditInputError(
    'Could not resolve Reddit /s/ share URL server-side because Reddit did not expose a canonical /comments/<id> redirect to this server. Use canonical /comments/<id> URL, redd.it URL, t3 fullname, or raw post ID.',
    'UNRESOLVED_REDDIT_SHARE_URL',
    input,
  );
}

export function parseDirectRedditPostInput(input: string): NormalizedRedditPost | null {
  const fullnameMatch = /^t3_([a-z0-9][a-z0-9_]{1,12})$/i.exec(input);
  if (fullnameMatch) {
    return normalizedFromIds(fullnameMatch[1]);
  }

  if (ARTICLE_ID_PATTERN.test(input)) {
    return normalizedFromIds(input);
  }

  if (!/^https?:\/\//i.test(input)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RedditInputError('post URL is invalid.');
  }

  if (url.protocol !== 'https:') {
    throw new RedditInputError('Reddit URL must use HTTPS.');
  }

  const hostname = url.hostname.toLowerCase();
  if (!isSupportedRedditHost(hostname)) {
    throw new RedditInputError('post URL must be a supported Reddit URL.');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (hostname === 'redd.it') {
    const id = parts[0];
    if (id && ARTICLE_ID_PATTERN.test(id)) {
      return normalizedFromIds(id, { canonicalUrl: `https://www.reddit.com/comments/${id.toLowerCase()}` });
    }
    throw new RedditInputError('redd.it URL must include an article ID.');
  }

  const commentsIndex = parts.findIndex((part) => part.toLowerCase() === 'comments');
  if (commentsIndex < 0 || !parts[commentsIndex + 1]) {
    return null;
  }

  const postId = parts[commentsIndex + 1];
  if (!ARTICLE_ID_PATTERN.test(postId)) {
    throw new RedditInputError('post URL must contain a valid Reddit article ID.');
  }

  const subreddit =
    commentsIndex >= 2 && parts[commentsIndex - 2]?.toLowerCase() === 'r' ? parts[commentsIndex - 1] : undefined;
  const possibleCommentId = parts[commentsIndex + 3];
  const commentId = possibleCommentId && COMMENT_ID_PATTERN.test(possibleCommentId) ? possibleCommentId : undefined;

  return normalizedFromIds(postId, {
    subreddit,
    commentId,
    canonicalUrl: subreddit
      ? `https://www.reddit.com/r/${subreddit}/comments/${postId.toLowerCase()}/`
      : `https://www.reddit.com/comments/${postId.toLowerCase()}`,
  });
}

function normalizedFromIds(
  postId: string,
  options: { subreddit?: string; commentId?: string; canonicalUrl?: string } = {},
): NormalizedRedditPost {
  const normalizedPostId = postId.toLowerCase();
  const normalizedCommentId = options.commentId?.toLowerCase();
  return {
    post_id: normalizedPostId,
    postId: normalizedPostId,
    fullname: `t3_${normalizedPostId}`,
    subreddit: options.subreddit?.toLowerCase(),
    comment_id: normalizedCommentId,
    commentId: normalizedCommentId,
    canonicalUrl: options.canonicalUrl,
    redirectChain: [],
  };
}

function isPotentialRedditUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function dedupeAdjacentRedirects(urls: string[]): string[] {
  const result: string[] = [];
  for (const url of urls) {
    if (url && result[result.length - 1] !== url) {
      result.push(url);
    }
  }
  return result;
}
