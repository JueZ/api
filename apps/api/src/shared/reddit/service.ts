import { RedditConfigError, readRedditConfig } from './config.js';
import { RedditFetchError, RedditOAuthClient, RedditUpstreamError, type FetchLike } from './client.js';
import { isRedditShareUrl, normalizeMaxComments, normalizeMaxMoreChildrenRequests, normalizeRedditPostInput, normalizeRedditSort, parseRedditPostInput, RedditInputError, unresolvedRedditShareUrlError, type NormalizedRedditPost } from './input.js';
import { attachMoreChildren, commentsPath, commentsQuery, createThreadResponse, normalizeInitialThread, RedditContentError, type MorePlaceholder } from './normalize.js';
import type { RedditRateLimit, RedditThreadRequest, RedditThreadResponse } from './types.js';

const TIMEOUT_BUDGET_MS = 110_000;
const MORE_CHILDREN_BATCH_SIZE = 100;

export interface RedditThreadServiceOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class RedditThreadService {
  private readonly client: RedditOAuthClient;
  private readonly now: () => number;

  constructor(options: RedditThreadServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.client = new RedditOAuthClient(readRedditConfig(), options.fetchImpl, this.now);
  }

  async fetchThread(request: RedditThreadRequest): Promise<RedditThreadResponse> {
    const originalInput = normalizeRequestPostInput(request);
    const normalizedPost = await this.normalizePostInput(originalInput);
    let input = parseRedditPostInput(normalizedPost.post_id);
    const sort = normalizeRedditSort(request.sort);
    const maxComments = normalizeMaxComments(request.maxComments);
    const maxMoreChildrenRequests = normalizeMaxMoreChildrenRequests(request.maxMoreChildrenRequests);
    const startedAt = this.now();

    let initial = await this.client.getJson<unknown>(commentsPath(input.articleId), commentsQuery(sort, maxComments), { input: originalInput, normalizedPostId: input.articleId });
    logRedditFetch({
      originalInput,
      normalizedPostId: input.articleId,
      normalizedCommentId: normalizedPost.comment_id,
      requestUrl: initial.requestUrl,
      finalUrl: initial.finalUrl,
      status: initial.status,
      contentType: initial.contentType,
      redirectCount: 0,
      retryCount: initial.retryCount,
      startedAt,
    });
    if (initial.status === 404) {
      const fallbackArticleId = await this.resolveRawCommentIdToArticleId(input.articleId);
      if (fallbackArticleId) {
        input = parseRedditPostInput(fallbackArticleId);
        initial = await this.client.getJson<unknown>(commentsPath(input.articleId), commentsQuery(sort, maxComments), { input: originalInput, normalizedPostId: input.articleId });
        logRedditFetch({
          originalInput,
          normalizedPostId: input.articleId,
          normalizedCommentId: normalizedPost.comment_id,
          requestUrl: initial.requestUrl,
          finalUrl: initial.finalUrl,
          status: initial.status,
          contentType: initial.contentType,
          redirectCount: 0,
          retryCount: initial.retryCount,
          startedAt,
        });
      }
    }
    assertRedditStatus(initial.status);
    const tree = normalizeInitialThread(originalInput, initial.body, { maxComments });
    let rateLimit: RedditRateLimit = initial.rateLimit;
    let moreChildrenRequests = 0;
    const warnings: string[] = [];

    while (tree.more.length > 0) {
      if (tree.commentsReturned >= maxComments) {
        tree.truncated = true;
        warnings.push('maxComments limit reached before all omitted comments were expanded.');
        break;
      }
      if (moreChildrenRequests >= maxMoreChildrenRequests) {
        tree.truncated = true;
        warnings.push('maxMoreChildrenRequests limit reached before all omitted comments were expanded.');
        break;
      }
      if (this.now() - startedAt > TIMEOUT_BUDGET_MS) {
        tree.truncated = true;
        warnings.push('timeout budget reached before all omitted comments were expanded.');
        break;
      }

      const more = tree.more.shift();
      if (!more) {
        break;
      }
      for (const children of chunk(more.children, MORE_CHILDREN_BATCH_SIZE)) {
        if (moreChildrenRequests >= maxMoreChildrenRequests || tree.commentsReturned >= maxComments) {
          tree.truncated = true;
          break;
        }
        const response = await this.fetchMoreChildren(input.fullname, children, sort, more);
        rateLimit = response.rateLimit;
        moreChildrenRequests += 1;
        attachMoreChildren(tree, response.body, more.parentId, more.depth, maxComments);
      }
    }

    return createThreadResponse(
      originalInput,
      tree,
      {
        moreChildrenRequests,
        truncated: tree.truncated,
        warnings,
      },
      rateLimit,
    );
  }


  private async normalizePostInput(post: string): Promise<NormalizedRedditPost> {
    if (isRedditShareUrl(post)) {
      const articleId = await this.resolveRedditUrlToArticleId(post.trim());
      if (articleId) {
        return normalizeRedditPostInput(articleId);
      }
    }

    return normalizeRedditPostInput(post, async (url) => {
      const resolved = await this.client.resolveRedditUrl(url);
      return { finalUrl: resolved.finalUrl, redirectChain: resolved.redirectChain };
    });
  }

  private async resolveRedditUrlToArticleId(url: string): Promise<string | null> {
    const response = await this.client.getJson<unknown>('/api/info', { url, raw_json: 1 });
    if (response.status === 403 || response.status === 404) {
      return null;
    }
    assertRedditStatus(response.status, 'url info');
    return articleIdFromInfoListing(response.body);
  }

  private async resolveRawCommentIdToArticleId(id: string): Promise<string | null> {
    const response = await this.client.getJson<unknown>('/api/info', { id: `t1_${id}`, raw_json: 1 });
    if (response.status === 404) {
      return null;
    }
    assertRedditStatus(response.status, 'comment info');
    return articleIdFromInfoListing(response.body);
  }

  private async fetchMoreChildren(linkId: string, children: string[], sort: string, more: MorePlaceholder) {
    const response = await this.client.getJson<unknown>('/api/morechildren', {
      api_type: 'json',
      link_id: linkId,
      children: children.join(','),
      raw_json: 1,
      sort,
    });
    assertRedditStatus(response.status, more.parentId);
    return response;
  }
}

export function mapRedditError(error: unknown): { status: number; message: string; code?: string; input?: string; redditFetchError?: ReturnType<RedditFetchError['toJSON']> } {
  if (error instanceof RedditInputError) {
    return { status: 400, message: error.message, code: error.code, input: error.input };
  }
  if (error instanceof RedditConfigError) {
    return { status: 502, message: error.message };
  }
  if (error instanceof RedditContentError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof RedditFetchError) {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    return { status, message: error.message, code: 'REDDIT_FETCH_ERROR', redditFetchError: error.toJSON() };
  }
  if (error instanceof RedditUpstreamError) {
    return { status: error.status, message: error.message };
  }
  return { status: 502, message: 'Unexpected Reddit upstream error.' };
}

function assertRedditStatus(status: number, context = 'thread'): void {
  if (status >= 200 && status < 300) {
    return;
  }
  if (status === 403) {
    throw new RedditContentError(`Reddit content is inaccessible for ${context}.`, 403);
  }
  if (status === 404) {
    throw new RedditContentError(`Reddit content was not found for ${context}.`, 404);
  }
  if (status === 429) {
    throw new RedditUpstreamError('Reddit rate-limited the request.', 429, status);
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    throw new RedditUpstreamError('Reddit upstream request failed with a retryable status.', 502, status);
  }
  throw new RedditUpstreamError('Reddit upstream request failed.', 502, status);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeRequestPostInput(request: RedditThreadRequest): string {
  if (!request || typeof request !== 'object') {
    throw new RedditInputError('post must be a non-empty string.');
  }

  const post = request.post ?? request.url ?? request.redditUrl ?? request.reddit_url ?? request.threadUrl ?? request.thread_url;
  if (typeof post !== 'string') {
    throw new RedditInputError('post must be a non-empty string.');
  }
  return post;
}


function logRedditFetch(args: {
  originalInput: string;
  normalizedPostId: string;
  normalizedCommentId?: string;
  requestUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  redirectCount: number;
  retryCount: number;
  startedAt: number;
  errorClass?: string;
}): void {
  console.info('reddit_thread_fetch', {
    request_id: undefined,
    original_input: args.originalInput,
    normalized_post_id: args.normalizedPostId,
    normalized_comment_id: args.normalizedCommentId,
    request_url: args.requestUrl,
    final_url: args.finalUrl,
    status: args.status,
    content_type: args.contentType,
    redirect_count: args.redirectCount,
    elapsed_ms: Date.now() - args.startedAt,
    retry_count: args.retryCount,
    error_class: args.errorClass,
  });
}

function articleIdFromInfoListing(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const children = (value as { data?: { children?: unknown[] } }).data?.children;
  if (!Array.isArray(children)) {
    return null;
  }

  for (const child of children) {
    const thing = child as { kind?: unknown; data?: Record<string, unknown> };
    const data = thing.data;
    if (!data || typeof data !== 'object') {
      continue;
    }
    if (thing.kind === 't3' && typeof data['id'] === 'string') {
      return data['id'];
    }
    if (thing.kind === 't1' && typeof data['link_id'] === 'string') {
      return data['link_id'].replace(/^t3_/i, '');
    }
  }

  return null;
}
