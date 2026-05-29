import { RedditConfigError, readRedditConfig } from './config.js';
import { RedditFetchError, RedditOAuthClient, RedditUpstreamError, type FetchLike } from './client.js';
import { isRedditShareUrl, normalizeMaxComments, normalizeMaxMoreChildrenRequests, normalizeRedditPostInput, normalizeRedditSort, parseRedditPostInput, RedditInputError, type NormalizedRedditPost } from './input.js';
import { resolveRedditShareUrl, type RedditShareResolution } from './shareResolver.js';
import { attachMoreChildren, commentsPath, commentsQuery, createCommentTreeResponse, createThreadResponse, focusedCommentsQuery, normalizeCommentBlockFromThings, normalizeFocusedCommentBlock, normalizeInitialThread, RedditContentError, type MorePlaceholder, type NormalizedCommentBlock } from './normalize.js';
import type { RedditCommentTreeRequest, RedditCommentTreeResponse, RedditRateLimit, RedditThreadRequest, RedditThreadResponse, RedditSort } from './types.js';

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



  async fetchCommentTree(request: RedditCommentTreeRequest): Promise<RedditCommentTreeResponse> {
    const originalInput = normalizeRequestPostInput(request);
    const normalizedPost = await this.normalizePostInput(originalInput);
    let input = parseRedditPostInput(normalizedPost.post_id);
    const sort = normalizeRedditSort(request.sort);
    const depth = normalizeCommentTreeDepth(request.depth);
    const limit = normalizeCommentTreeLimit(request.limit);
    const maxMoreChildrenRequests = normalizeMaxMoreChildrenRequests(request.maxMoreChildrenRequests ?? 0);
    const commentId = normalizeOptionalCommentId(request.commentId);
    const children = normalizeContinuationChildren(request.children);
    const parentId = normalizeOptionalParentId(request.parentId);
    if ((commentId ? 1 : 0) + (children.length > 0 ? 1 : 0) !== 1) {
      throw new RedditInputError('Exactly one of commentId or children must be provided.');
    }

    const startedAt = this.now();
    let rateLimit: RedditRateLimit;
    let postTree = await this.client.getJson<unknown>(commentsPath(input.articleId), commentId ? focusedCommentsQuery(sort, commentId, depth, limit) : commentsQuery(sort, 1), { input: originalInput, normalizedPostId: input.articleId });
    logRedditFetch({
      originalInput,
      normalizedPostId: input.articleId,
      normalizedCommentId: commentId ?? normalizedPost.comment_id,
      requestUrl: postTree.requestUrl,
      finalUrl: postTree.finalUrl,
      status: postTree.status,
      contentType: postTree.contentType,
      redirectCount: 0,
      retryCount: postTree.retryCount,
      startedAt,
    });
    if (postTree.status === 404) {
      const fallbackArticleId = await this.resolveRawCommentIdToArticleId(input.articleId);
      if (fallbackArticleId) {
        input = parseRedditPostInput(fallbackArticleId);
        postTree = await this.client.getJson<unknown>(commentsPath(input.articleId), commentId ? focusedCommentsQuery(sort, commentId, depth, limit) : commentsQuery(sort, 1), { input: originalInput, normalizedPostId: input.articleId });
      }
    }
    assertRedditStatus(postTree.status);
    rateLimit = postTree.rateLimit;

    if (commentId) {
      const { post, block } = normalizeFocusedCommentBlock(postTree.body, { maxComments: limit });
      const expansion = await this.expandCommentBlock(input.fullname, block, sort, limit, maxMoreChildrenRequests, startedAt);
      rateLimit = expansion.rateLimit ?? rateLimit;
      return createCommentTreeResponse(originalInput, post, block, {
        moreChildrenRequests: expansion.moreChildrenRequests,
        truncated: block.truncated,
        warnings: expansion.warnings,
      }, rateLimit, { mode: 'comment', rootCommentId: commentId });
    }

    const postOnlyTree = normalizeInitialThread(originalInput, postTree.body, { maxComments: 1 });
    const block = normalizeCommentBlockFromThings({ json: { data: { things: [] } } }, parentId, depth, { maxComments: limit });
    let moreChildrenRequests = 0;
    const warnings: string[] = [];
    for (const batch of chunk(children, MORE_CHILDREN_BATCH_SIZE)) {
      if (block.commentsReturned >= limit) {
        block.truncated = true;
        warnings.push('limit reached before all requested children were returned.');
        break;
      }
      const response = await this.fetchMoreChildren(input.fullname, batch, sort, { parentId, depth, children: batch });
      rateLimit = response.rateLimit;
      moreChildrenRequests += 1;
      attachMoreChildren(block, response.body, parentId, depth, limit);
    }
    const expansion = await this.expandCommentBlock(input.fullname, block, sort, limit, maxMoreChildrenRequests, startedAt, moreChildrenRequests);
    rateLimit = expansion.rateLimit ?? rateLimit;
    return createCommentTreeResponse(originalInput, postOnlyTree.post, block, {
      moreChildrenRequests: expansion.moreChildrenRequests,
      truncated: block.truncated,
      warnings: [...warnings, ...expansion.warnings],
    }, rateLimit, { mode: 'children', parentId, requestedChildren: children });
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




  private async expandCommentBlock(
    linkId: string,
    block: NormalizedCommentBlock,
    sort: RedditSort,
    maxComments: number,
    maxMoreChildrenRequests: number,
    startedAt: number,
    existingRequests = 0,
  ): Promise<{ moreChildrenRequests: number; warnings: string[]; rateLimit?: RedditRateLimit }> {
    let moreChildrenRequests = existingRequests;
    let rateLimit: RedditRateLimit | undefined;
    const warnings: string[] = [];
    while (block.more.length > 0) {
      if (block.commentsReturned >= maxComments) {
        block.truncated = true;
        warnings.push('limit reached before all omitted comments were expanded.');
        break;
      }
      if (moreChildrenRequests >= maxMoreChildrenRequests) {
        block.truncated = true;
        warnings.push('maxMoreChildrenRequests limit reached before all omitted comments were expanded.');
        break;
      }
      if (this.now() - startedAt > TIMEOUT_BUDGET_MS) {
        block.truncated = true;
        warnings.push('timeout budget reached before all omitted comments were expanded.');
        break;
      }

      const more = block.more.shift();
      if (!more) break;
      for (const children of chunk(more.children, MORE_CHILDREN_BATCH_SIZE)) {
        if (moreChildrenRequests >= maxMoreChildrenRequests || block.commentsReturned >= maxComments) {
          block.truncated = true;
          break;
        }
        const response = await this.fetchMoreChildren(linkId, children, sort, more);
        rateLimit = response.rateLimit;
        moreChildrenRequests += 1;
        attachMoreChildren(block, response.body, more.parentId, more.depth, maxComments);
      }
    }
    return { moreChildrenRequests, warnings, rateLimit };
  }

  private async normalizePostInput(post: string): Promise<NormalizedRedditPost> {
    if (isRedditShareUrl(post)) {
      const resolution = await resolveRedditShareUrl(post, {
        resolveRedirect: (url) => this.client.resolveRedditUrl(url),
      });
      logShareResolution(resolution);
      if (resolution.status === 'resolved') {
        return normalizeRedditPostInput(resolution.cleanCanonicalUrl);
      }
      throw new RedditShareResolutionError(resolution);
    }

    return normalizeRedditPostInput(post);
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


export class RedditShareResolutionError extends RedditInputError {
  readonly resolution: Exclude<RedditShareResolution, { status: 'resolved' }>;

  constructor(resolution: Exclude<RedditShareResolution, { status: 'resolved' }>) {
    const code = resolution.status === 'blocked_by_reddit_web' ? 'REDDIT_SHARE_RESOLUTION_BLOCKED' : 'UNRESOLVED_REDDIT_SHARE_URL';
    super(
      'Could not resolve Reddit /s/ share URL server-side because Reddit did not expose a canonical /comments/<id> redirect to this server. Use canonical /comments/<id> URL, redd.it URL, t3 fullname, or raw post ID.',
      code,
      resolution.originalUrl,
    );
    this.name = 'RedditShareResolutionError';
    this.resolution = resolution;
  }
}

export type MappedRedditErrorKind = 'input' | 'content' | 'upstream' | 'fetch' | 'config' | 'internal';

export function mapRedditError(error: unknown): {
  status: number;
  message: string;
  code?: string;
  input?: string;
  redditFetchError?: ReturnType<RedditFetchError['toJSON']>;
  kind: MappedRedditErrorKind;
} {
  if (error instanceof RedditInputError) {
    return { status: 400, message: error.message, code: error.code, input: error.input, kind: 'input' };
  }
  if (error instanceof RedditConfigError) {
    return { status: 502, message: 'The Reddit integration is not configured correctly.', code: 'REDDIT_CONFIG_ERROR', kind: 'config' };
  }
  if (error instanceof RedditContentError) {
    return { status: error.status, message: error.message, kind: 'content' };
  }
  if (error instanceof RedditFetchError) {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    return { status, message: safeRedditFetchMessage(error), code: 'REDDIT_FETCH_ERROR', redditFetchError: error.toJSON(), kind: 'fetch' };
  }
  if (error instanceof RedditUpstreamError) {
    return { status: error.status, message: error.message, kind: 'upstream' };
  }
  return { status: 502, message: 'Unexpected internal service failure.', code: 'INTERNAL_SERVICE_ERROR', kind: 'internal' };
}

function safeRedditFetchMessage(error: RedditFetchError): string {
  if (error.status === 429) return 'Reddit rate-limited the request.';
  if (error.status && error.status >= 500) return 'Reddit upstream request failed with a retryable status.';
  return 'Reddit fetch failed before a valid JSON response was available.';
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

function normalizeRequestPostInput(request: RedditThreadRequest | RedditCommentTreeRequest): string {
  if (!request || typeof request !== 'object') {
    throw new RedditInputError('post must be a non-empty string.');
  }

  const post = request.post ?? request.url ?? request.redditUrl ?? request.reddit_url ?? request.threadUrl ?? request.thread_url;
  if (typeof post !== 'string') {
    throw new RedditInputError('post must be a non-empty string.');
  }
  return post;
}



function normalizeCommentTreeDepth(input: unknown): number {
  if (input === undefined || input === null) return 3;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    throw new RedditInputError('depth must be a non-negative integer.');
  }
  return Math.min(input, 10);
}

function normalizeCommentTreeLimit(input: unknown): number {
  if (input === undefined || input === null) return 100;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) {
    throw new RedditInputError('limit must be a positive integer.');
  }
  return Math.min(input, 500);
}

function normalizeOptionalCommentId(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string') {
    throw new RedditInputError('commentId must be a Reddit comment ID string.');
  }
  const trimmed = input.trim().replace(/^t1_/i, '');
  if (!/^[a-z0-9][a-z0-9_]{1,12}$/i.test(trimmed)) {
    throw new RedditInputError('commentId must be a valid Reddit comment ID.');
  }
  return trimmed.toLowerCase();
}

function normalizeContinuationChildren(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return [];
  const values = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : null;
  if (!values) {
    throw new RedditInputError('children must be an array of Reddit comment IDs or a comma-separated string.');
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string') {
      throw new RedditInputError('children must contain only Reddit comment ID strings.');
    }
    const id = value.trim().replace(/^t1_/i, '');
    if (!/^[a-z0-9][a-z0-9_]{1,12}$/i.test(id)) {
      throw new RedditInputError('children must contain valid Reddit comment IDs.');
    }
    return id.toLowerCase();
  }).filter(Boolean);
  return [...new Set(normalized)].slice(0, 500);
}

function normalizeOptionalParentId(input: unknown): string {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string') {
    throw new RedditInputError('parentId must be a Reddit fullname string.');
  }
  const trimmed = input.trim();
  if (!/^(t1|t3)_[a-z0-9][a-z0-9_]{1,12}$/i.test(trimmed)) {
    throw new RedditInputError('parentId must be a valid Reddit parent fullname.');
  }
  return trimmed.toLowerCase();
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


function logShareResolution(resolution: RedditShareResolution): void {
  const originalHost = hostFromUrl(resolution.originalUrl);
  const finalUrl = stripLogUrl(resolution.finalUrl);
  console.info('reddit_share_resolution', {
    share_resolution_status: resolution.status,
    share_resolution_source: resolution.status === 'resolved' ? resolution.source : undefined,
    original_host: originalHost,
    final_host: hostFromUrl(resolution.finalUrl),
    http_status: resolution.httpStatus,
    content_type: resolution.contentType,
    redirect_count: Math.max(0, resolution.redirectChain.length - 1),
    final_url: finalUrl,
    extracted_post_id: resolution.status === 'resolved' ? resolution.postId : undefined,
    redirect_chain: resolution.redirectChain.map((url) => stripLogUrl(url) ?? url),
  });
}

function stripLogUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split('?')[0]?.split('#')[0] ?? value;
  }
}

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
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
