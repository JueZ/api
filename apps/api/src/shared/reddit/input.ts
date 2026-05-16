import type { ParsedRedditPostInput, RedditSort } from './types.js';

const VALID_SORTS = new Set<RedditSort>(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);
const ARTICLE_ID_PATTERN = /^[a-z0-9][a-z0-9_]{1,12}$/i;
const REDDIT_HOSTNAMES = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com']);

export function parseRedditPostInput(input: unknown): ParsedRedditPostInput {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new RedditInputError('post must be a non-empty string.');
  }

  const post = input.trim();
  const articleId = extractArticleId(post);
  if (!ARTICLE_ID_PATTERN.test(articleId)) {
    throw new RedditInputError('post must contain a valid Reddit article ID.');
  }

  return {
    articleId: articleId.toLowerCase(),
    fullname: `t3_${articleId.toLowerCase()}`,
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
    return 1000;
  }
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    throw new RedditInputError('maxMoreChildrenRequests must be a non-negative integer.');
  }
  return Math.min(input, 5000);
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
  if (typeof input !== 'string' || !/^https?:\/\//i.test(input)) {
    return false;
  }

  try {
    const url = new URL(input.trim());
    if (!REDDIT_HOSTNAMES.has(url.hostname.toLowerCase())) {
      return false;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 4 && parts[0]?.toLowerCase() === 'r' && parts[2]?.toLowerCase() === 's';
  } catch {
    return false;
  }
}

export function unresolvedRedditShareUrlError(input: string): RedditInputError {
  return new RedditInputError(
    'Could not resolve Reddit /s/ share URL to canonical /comments/<id>/ URL.',
    'UNRESOLVED_REDDIT_SHARE_URL',
    input,
  );
}

function extractArticleId(input: string): string {
  const fullnameMatch = /^t3_([a-z0-9][a-z0-9_]{1,12})$/i.exec(input);
  if (fullnameMatch) {
    return fullnameMatch[1];
  }

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new RedditInputError('post URL is invalid.');
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname === 'redd.it') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id) {
        return id;
      }
      throw new RedditInputError('redd.it URL must include an article ID.');
    }

    if (REDDIT_HOSTNAMES.has(hostname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const commentsIndex = parts.findIndex((part) => part.toLowerCase() === 'comments');
      if (commentsIndex >= 0 && parts[commentsIndex + 1]) {
        return parts[commentsIndex + 1];
      }
      if (isRedditShareUrl(input)) {
        throw unresolvedRedditShareUrlError(input);
      }
      throw new RedditInputError('Reddit comments URL must include an article ID.');
    }

    throw new RedditInputError('post URL must be a supported Reddit URL.');
  }

  return input;
}
