import { RedditConfigError, readRedditConfig, type RedditConfig } from './config.js';
import { randomUUID } from 'node:crypto';
import {
  RedditFetchError,
  RedditOAuthClient,
  RedditRequestDeadlineError,
  RedditUpstreamError,
  sanitizeRedditTelemetryUrl,
  type FetchLike,
} from './client.js';
import {
  isRedditShareUrl,
  MAX_MORE_CHILDREN_REQUESTS_PER_CALL,
  normalizeMaxComments,
  normalizeMaxMoreChildrenRequests,
  normalizeRedditPostInput,
  normalizeRedditSort,
  parseRedditPostInput,
  RedditInputError,
  type NormalizedRedditPost,
} from './input.js';
import { resolveRedditShareUrl, type RedditShareResolution } from './shareResolver.js';
import {
  attachMoreChildren,
  commentsPath,
  commentsQuery,
  createCommentTreeResponse,
  createThreadResponse,
  focusedCommentsQuery,
  normalizeCommentBlockFromThings,
  normalizeFocusedCommentBlock,
  normalizeInitialThread,
  RedditContentError,
  type MorePlaceholder,
  type NormalizedCommentBlock,
} from './normalize.js';
import type {
  RedditCommentDto,
  RedditCommentQueryRequest,
  RedditCommentQueryResponse,
  RedditCommentSkeletonDto,
  RedditCommentsBatchRequest,
  RedditCommentsBatchResponse,
  RedditCoverageDto,
  RedditRateLimit,
  RedditSort,
  RedditThreadOverviewRequest,
  RedditThreadOverviewResponse,
  RedditCommentTreeRequest,
  RedditCommentTreeResponse,
  RedditThreadRequest,
  RedditThreadResponse,
} from './types.js';
import { RedditPrincipalConcurrencyError } from './concurrency.js';
import {
  createRedditThreadSnapshot,
  decodeRedditSnapshotCursor,
  encodeRedditSnapshotCursor,
  InMemoryRedditThreadSnapshotStore,
  RedditCursorError,
  RedditSnapshotConflictError,
  RedditSnapshotExpiredError,
  RedditSnapshotNotFoundError,
  REDDIT_THREAD_SNAPSHOT_VERSION,
  verifyRedditSnapshotCursor,
  type RedditSnapshotQuery,
  type RedditThreadSnapshot,
  type RedditThreadSnapshotStore,
  type RedditTraversalWork,
  type StoredRedditThreadSnapshot,
} from './snapshot.js';

export const REDDIT_EXPANSION_TIMEOUT_BUDGET_MS = 20_000;
export const REDDIT_RATE_LIMIT_RESERVE = 10;
const MORE_CHILDREN_BATCH_SIZE = 100;

export interface RedditThreadServiceOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  expansionTimeoutBudgetMs?: number;
  config?: RedditConfig;
  snapshotStore?: RedditThreadSnapshotStore;
}

export class RedditThreadService {
  private readonly client: RedditOAuthClient;
  private readonly now: () => number;
  private readonly expansionTimeoutBudgetMs: number;
  private readonly snapshotStore: RedditThreadSnapshotStore;
  private readonly snapshotTtlMs: number;
  private readonly snapshotMaxComments: number;
  private readonly snapshotMaxBytes: number;

  constructor(options: RedditThreadServiceOptions = {}) {
    const config = options.config ?? readRedditConfig();
    this.now = options.now ?? (() => Date.now());
    this.expansionTimeoutBudgetMs = options.expansionTimeoutBudgetMs ?? REDDIT_EXPANSION_TIMEOUT_BUDGET_MS;
    this.snapshotStore = options.snapshotStore ?? new InMemoryRedditThreadSnapshotStore();
    this.snapshotTtlMs = config.snapshotTtlMs;
    this.snapshotMaxComments = config.snapshotMaxComments;
    this.snapshotMaxBytes = config.snapshotMaxBytes;
    this.client = new RedditOAuthClient(config, options.fetchImpl, this.now);
  }

  async fetchThreadOverview(request: RedditThreadOverviewRequest): Promise<RedditThreadOverviewResponse> {
    const originalInput = normalizeRequestPostInput(request);
    const normalizedPost = await this.normalizePostInput(originalInput);
    let input = parseRedditPostInput(normalizedPost.post_id);
    const sort = normalizeRedditSort(request.sort);
    const maxComments = normalizeQuerySnapshotMaxComments(request.maxComments ?? 500);
    const startedAt = this.now();

    let initial = await this.client.getJson<unknown>(commentsPath(input.articleId), commentsQuery(sort, maxComments), {
      input: originalInput,
      normalizedPostId: input.articleId,
    });
    logRedditFetch({
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
        initial = await this.client.getJson<unknown>(commentsPath(input.articleId), commentsQuery(sort, maxComments), {
          input: originalInput,
          normalizedPostId: input.articleId,
        });
      }
    }
    assertRedditStatus(initial.status);
    const tree = normalizeInitialThread(originalInput, initial.body, { maxComments });
    const rows = flattenComments(tree.comments, { includeBody: false, bodyPreviewChars: 0 });
    return {
      source: 'reddit',
      fetchedAt: new Date().toISOString(),
      input: originalInput,
      post: tree.post,
      stats: {
        topLevelComments: tree.comments.length,
        maxDepth: rows.reduce((max, row) => Math.max(max, row.depth), 0),
        deletedCount: rows.filter((row) => row.isDeleted).length,
        loadedSnapshotCommentCount: rows.length,
      },
      availableSorts: ['confidence', 'top', 'new', 'controversial', 'old', 'qa'],
      coverage: coverageFor(tree.post.numComments, rows, tree.more, sort, rows.length, false),
      redditRateLimit: initial.rateLimit,
    };
  }

  async fetchThreadComments(request: RedditCommentQueryRequest): Promise<RedditCommentQueryResponse> {
    const limit = normalizeQueryLimit(request.limit);
    const includeBody = request.includeBody === true;
    const bodyPreviewChars = normalizeBodyPreviewChars(request.bodyPreviewChars);
    const maxBytes = normalizeMaxBytes(request.maxBytes);
    const maxMoreChildrenRequests = normalizeMaxMoreChildrenRequests(request.maxMoreChildrenRequests ?? 5);
    const startedAt = this.now();
    const expansionDeadlineMs = startedAt + this.expansionTimeoutBudgetMs;
    const cursorInput =
      typeof request.cursor === 'string' && request.cursor.trim().length > 0 ? request.cursor : undefined;

    let stored: StoredRedditThreadSnapshot;
    let offset = 0;
    if (cursorInput) {
      assertCursorOnlyRequest(request);
      const cursor = decodeRedditSnapshotCursor(cursorInput);
      const loaded = await this.snapshotStore.load(cursor.snapshotId);
      if (!loaded) throw new RedditSnapshotNotFoundError();
      assertSnapshotAvailable(loaded.snapshot, this.now);
      verifyRedditSnapshotCursor(cursor, loaded.snapshot);
      assertCompatibleSnapshotQuery(request, loaded.snapshot.query);
      stored = loaded;
      offset = cursor.offset;
    } else {
      stored = await this.createInitialSnapshot(request, startedAt);
    }

    let leaseId: string | undefined;
    if (cursorInput && maxMoreChildrenRequests > 0 && stored.snapshot.frontier.length > 0) {
      const activeLease = stored.snapshot.crawlLease;
      if (activeLease && Date.parse(activeLease.expiresAt) > this.now()) throw new RedditSnapshotConflictError();
      leaseId = randomUUID();
      stored.snapshot.crawlLease = {
        id: leaseId,
        expiresAt: new Date(expansionDeadlineMs + 5_000).toISOString(),
      };
      stored.snapshot.updatedAt = new Date(this.now()).toISOString();
      stored = await this.snapshotStore.replace(stored.snapshot, stored.etag);
    }

    let crawl: Awaited<ReturnType<RedditThreadService['advanceThreadSnapshot']>>;
    let crawlError: unknown;
    try {
      crawl = await this.advanceThreadSnapshot(stored.snapshot, maxMoreChildrenRequests, expansionDeadlineMs);
    } catch (error) {
      crawlError = error;
      crawl = { changed: true, requests: 0, stoppedReason: 'upstream_retryable' };
    }
    if (leaseId && stored.snapshot.crawlLease?.id === leaseId) {
      delete stored.snapshot.crawlLease;
      crawl.changed = true;
    }
    if (crawl.changed) {
      stored.snapshot.updatedAt = new Date(this.now()).toISOString();
      stored = await this.snapshotStore.replace(stored.snapshot, stored.etag);
    }
    if (crawlError) throw crawlError;

    let rows = snapshotCommentRows(stored.snapshot.comments, { includeBody, bodyPreviewChars });
    rows = applySnapshotFilters(rows, stored.snapshot.query);
    if (offset > rows.length)
      throw new RedditCursorError('cursor offset is outside the persisted snapshot page range.');
    const page = pageRows(rows, offset, limit, maxBytes);
    const comments = page.rows;
    const sourceComplete = stored.snapshot.sourceExhausted && !stored.snapshot.resourceLimitReached;
    const hasMore = page.nextOffset < rows.length || !sourceComplete;
    const nextCursor = hasMore ? encodeRedditSnapshotCursor(stored.snapshot, page.nextOffset) : null;
    const coverage = coverageForSnapshot(stored.snapshot, Boolean(nextCursor), crawl.stoppedReason);
    logRedditSnapshotProgress(stored.snapshot, crawl.requests, coverage.complete, startedAt, crawl.stoppedReason);
    return {
      source: 'reddit',
      fetchedAt: new Date().toISOString(),
      input: stored.snapshot.input,
      post: stored.snapshot.post,
      comments,
      snapshot: {
        version: stored.snapshot.version,
        id: stored.snapshot.snapshotId,
        postId: stored.snapshot.postId,
        sort: stored.snapshot.sort,
        startedAt: stored.snapshot.startedAt,
        updatedAt: stored.snapshot.updatedAt,
        expiresAt: stored.snapshot.expiresAt,
        sourceExhausted: stored.snapshot.sourceExhausted,
      },
      page: {
        nextCursor,
        hasMore,
        returned: comments.length,
        truncatedBy: page.truncatedBy,
      },
      coverage,
      warnings: stored.snapshot.warnings,
      redditRateLimit: stored.snapshot.redditRateLimit,
    };
  }

  async fetchCommentsBatch(request: RedditCommentsBatchRequest): Promise<RedditCommentsBatchResponse> {
    const ids = normalizeBatchIds(request.ids);
    const fields = normalizeBatchFields(request.fields);
    const maxBytes = normalizeMaxBytes(request.maxBytes);
    const response = await this.client.getJson<unknown>('/api/info', {
      id: ids.map((id) => `t1_${id}`).join(','),
      raw_json: 1,
    });
    assertRedditStatus(response.status, 'comment batch');
    const rows = commentRowsFromInfoListing(response.body);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const comments: Record<string, unknown>[] = [];
    const found: string[] = [];
    const missing: string[] = [];
    const unavailable: string[] = [];
    let truncatedBy: 'maxBytes' | null = null;
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      if (row.isDeleted) unavailable.push(id);
      const projected = projectCommentFields(row, fields);
      if (JSON.stringify([...comments, projected]).length > maxBytes) {
        truncatedBy = 'maxBytes';
        break;
      }
      comments.push(projected);
      found.push(id);
    }
    return {
      source: 'reddit',
      fetchedAt: new Date().toISOString(),
      ...(typeof request.post === 'string' ? { input: request.post } : {}),
      comments,
      found,
      missing,
      unavailable,
      truncatedBy,
      redditRateLimit: response.rateLimit,
    };
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
    const expansionDeadlineMs = startedAt + this.expansionTimeoutBudgetMs;
    let rateLimit: RedditRateLimit;
    let postTree = await this.client.getJson<unknown>(
      commentsPath(input.articleId),
      commentId ? focusedCommentsQuery(sort, commentId, depth, limit) : commentsQuery(sort, 1),
      { input: originalInput, normalizedPostId: input.articleId },
    );
    logRedditFetch({
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
        postTree = await this.client.getJson<unknown>(
          commentsPath(input.articleId),
          commentId ? focusedCommentsQuery(sort, commentId, depth, limit) : commentsQuery(sort, 1),
          { input: originalInput, normalizedPostId: input.articleId },
        );
      }
    }
    assertRedditStatus(postTree.status);
    rateLimit = postTree.rateLimit;

    if (commentId) {
      const { post, block } = normalizeFocusedCommentBlock(postTree.body, { maxComments: limit });
      const expansion = await this.expandCommentBlock(
        input.fullname,
        block,
        sort,
        limit,
        maxMoreChildrenRequests,
        expansionDeadlineMs,
        rateLimit,
      );
      rateLimit = expansion.rateLimit ?? rateLimit;
      return createCommentTreeResponse(
        originalInput,
        post,
        block,
        {
          moreChildrenRequests: expansion.moreChildrenRequests,
          truncated: block.truncated,
          warnings: expansion.warnings,
        },
        rateLimit,
        { mode: 'comment', rootCommentId: commentId },
      );
    }

    const postOnlyTree = normalizeInitialThread(originalInput, postTree.body, { maxComments: 1 });
    const block = normalizeCommentBlockFromThings({ json: { data: { things: [] } } }, parentId, depth, {
      maxComments: limit,
    });
    let moreChildrenRequests = 0;
    const warnings: string[] = [];
    const requestedBatches = chunk(children, MORE_CHILDREN_BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < requestedBatches.length; batchIndex += 1) {
      const batch = requestedBatches[batchIndex] ?? [];
      if (block.commentsReturned >= limit) {
        block.truncated = true;
        warnings.push('limit reached before all requested children were returned.');
        prependUnprocessedMore(block.more, { parentId, depth }, requestedBatches, batchIndex);
        break;
      }
      if (moreChildrenRequests >= MAX_MORE_CHILDREN_REQUESTS_PER_CALL) {
        block.truncated = true;
        warnings.push('server expansion request budget reached before all requested children were returned.');
        prependUnprocessedMore(block.more, { parentId, depth }, requestedBatches, batchIndex);
        break;
      }
      if (isProviderExpansionBudgetExhausted(rateLimit)) {
        block.truncated = true;
        warnings.push('Reddit provider rate-limit reserve reached before all requested children were returned.');
        prependUnprocessedMore(block.more, { parentId, depth }, requestedBatches, batchIndex);
        break;
      }
      if (this.now() >= expansionDeadlineMs) {
        block.truncated = true;
        warnings.push('server expansion time budget reached before all requested children were returned.');
        prependUnprocessedMore(block.more, { parentId, depth }, requestedBatches, batchIndex);
        break;
      }
      const response = await this.fetchMoreChildrenWithinDeadline(
        input.fullname,
        batch,
        sort,
        { parentId, depth, children: batch, count: batch.length, id: batch[0] ?? '' },
        expansionDeadlineMs,
      );
      if (!response) {
        block.truncated = true;
        warnings.push('server expansion time budget reached before all requested children were returned.');
        prependUnprocessedMore(block.more, { parentId, depth }, requestedBatches, batchIndex);
        break;
      }
      rateLimit = response.rateLimit;
      moreChildrenRequests += 1;
      attachMoreChildren(block, response.body, parentId, depth, limit);
    }
    const expansion = await this.expandCommentBlock(
      input.fullname,
      block,
      sort,
      limit,
      maxMoreChildrenRequests,
      expansionDeadlineMs,
      rateLimit,
      moreChildrenRequests,
    );
    rateLimit = expansion.rateLimit ?? rateLimit;
    return createCommentTreeResponse(
      originalInput,
      postOnlyTree.post,
      block,
      {
        moreChildrenRequests: expansion.moreChildrenRequests,
        truncated: block.truncated,
        warnings: [...warnings, ...expansion.warnings],
      },
      rateLimit,
      { mode: 'children', parentId, requestedChildren: children },
    );
  }

  async fetchThread(request: RedditThreadRequest): Promise<RedditThreadResponse> {
    const originalInput = normalizeRequestPostInput(request);
    const normalizedPost = await this.normalizePostInput(originalInput);
    let input = parseRedditPostInput(normalizedPost.post_id);
    const sort = normalizeRedditSort(request.sort);
    const maxComments = normalizeMaxComments(request.maxComments);
    const maxMoreChildrenRequests = normalizeMaxMoreChildrenRequests(request.maxMoreChildrenRequests);
    const startedAt = this.now();
    const expansionDeadlineMs = startedAt + this.expansionTimeoutBudgetMs;

    let initial = await this.client.getJson<unknown>(commentsPath(input.articleId), commentsQuery(sort, maxComments), {
      input: originalInput,
      normalizedPostId: input.articleId,
    });
    logRedditFetch({
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
        initial = await this.client.getJson<unknown>(commentsPath(input.articleId), commentsQuery(sort, maxComments), {
          input: originalInput,
          normalizedPostId: input.articleId,
        });
        logRedditFetch({
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
      if (isProviderExpansionBudgetExhausted(rateLimit)) {
        tree.truncated = true;
        warnings.push('Reddit provider rate-limit reserve reached before all omitted comments were expanded.');
        break;
      }
      if (this.now() >= expansionDeadlineMs) {
        tree.truncated = true;
        warnings.push('server expansion time budget reached before all omitted comments were expanded.');
        break;
      }

      const more = tree.more.shift();
      if (!more) {
        break;
      }
      if (more.children.length === 0) {
        tree.more.unshift(more);
        tree.truncated = true;
        warnings.push('continue-thread traversal is available through the resumable thread-comments page endpoint.');
        break;
      }
      const childBatches = chunk(more.children, MORE_CHILDREN_BATCH_SIZE);
      for (let batchIndex = 0; batchIndex < childBatches.length; batchIndex += 1) {
        const children = childBatches[batchIndex] ?? [];
        if (
          moreChildrenRequests >= maxMoreChildrenRequests ||
          tree.commentsReturned >= maxComments ||
          isProviderExpansionBudgetExhausted(rateLimit) ||
          this.now() >= expansionDeadlineMs
        ) {
          tree.truncated = true;
          prependUnprocessedMore(tree.more, more, childBatches, batchIndex);
          break;
        }
        const response = await this.fetchMoreChildrenWithinDeadline(
          input.fullname,
          children,
          sort,
          more,
          expansionDeadlineMs,
        );
        if (!response) {
          tree.truncated = true;
          warnings.push('server expansion time budget reached before all omitted comments were expanded.');
          prependUnprocessedMore(tree.more, more, childBatches, batchIndex);
          break;
        }
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

  private async createInitialSnapshot(
    request: RedditCommentQueryRequest,
    startedAt: number,
  ): Promise<StoredRedditThreadSnapshot> {
    const originalInput = normalizeInitialSnapshotPostInput(request);
    const normalizedPost = await this.normalizePostInput(originalInput);
    let input = parseRedditPostInput(normalizedPost.post_id);
    const sort = normalizeRedditSort(request.sort);
    const initialListingLimit = normalizeQuerySnapshotMaxComments(request.maxComments);
    let initial = await this.client.getJson<unknown>(
      commentsPath(input.articleId),
      commentsQuery(sort, initialListingLimit),
      { input: originalInput, normalizedPostId: input.articleId },
    );
    logRedditFetch({
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
        initial = await this.client.getJson<unknown>(
          commentsPath(input.articleId),
          commentsQuery(sort, initialListingLimit),
          { input: originalInput, normalizedPostId: input.articleId },
        );
        logRedditFetch({
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
    const tree = normalizeInitialThread(originalInput, initial.body, { maxComments: this.snapshotMaxComments });
    const comments = dedupeNormalizedComments(flattenNormalizedComments(tree.comments));
    const frontier = traversalWorkFromMore(tree.more, {
      postId: input.articleId,
      seenCommentIds: new Set(comments.map((comment) => comment.id.toLowerCase())),
    });
    const snapshot = createRedditThreadSnapshot({
      input: originalInput,
      postId: input.articleId,
      sort,
      post: tree.post,
      comments,
      frontier,
      query: normalizeSnapshotQuery(request),
      rateLimit: initial.rateLimit,
      nowMs: startedAt,
      ttlMs: this.snapshotTtlMs,
    });
    snapshot.warnings = [...new Set(tree.warnings)];
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > this.snapshotMaxBytes) {
      snapshot.resourceLimitReached = true;
      snapshot.sourceExhausted = false;
      addSnapshotWarning(
        snapshot,
        `Snapshot byte resource limit of ${this.snapshotMaxBytes} reached; traversal is incomplete.`,
      );
    }
    if (tree.truncated || comments.length >= this.snapshotMaxComments) {
      snapshot.resourceLimitReached = true;
      snapshot.sourceExhausted = false;
      addSnapshotWarning(
        snapshot,
        `Snapshot resource limit of ${this.snapshotMaxComments} comments reached; traversal is incomplete.`,
      );
    }
    return this.snapshotStore.create(snapshot);
  }

  private async advanceThreadSnapshot(
    snapshot: RedditThreadSnapshot,
    maxRequests: number,
    deadlineMs: number,
  ): Promise<{
    changed: boolean;
    requests: number;
    stoppedReason?: NonNullable<RedditCoverageDto['stoppedReason']>;
  }> {
    let changed = false;
    let requests = 0;
    let stoppedReason: NonNullable<RedditCoverageDto['stoppedReason']> | undefined;

    if (snapshot.resourceLimitReached) {
      return { changed, requests, stoppedReason: 'snapshot_resource_limit' };
    }

    while (snapshot.frontier.length > 0) {
      if (snapshot.resourceLimitReached || snapshot.comments.length >= this.snapshotMaxComments) {
        snapshot.resourceLimitReached = true;
        snapshot.sourceExhausted = false;
        changed =
          addSnapshotWarning(
            snapshot,
            `Snapshot resource limit of ${this.snapshotMaxComments} comments reached; traversal is incomplete.`,
          ) || changed;
        stoppedReason = 'snapshot_resource_limit';
        break;
      }
      if (requests >= maxRequests) {
        changed =
          addSnapshotWarning(snapshot, 'Per-call Reddit expansion request budget reached; resume with nextCursor.') ||
          changed;
        stoppedReason = 'execution_budget';
        break;
      }
      if (isProviderExpansionBudgetExhausted(snapshot.redditRateLimit)) {
        snapshot.retryAfterSeconds = rateLimitResetSeconds(snapshot.redditRateLimit);
        changed =
          addSnapshotWarning(snapshot, 'Reddit provider rate-limit reserve reached; progress was checkpointed.') ||
          changed;
        stoppedReason = 'rate_limit';
        break;
      }
      if (this.now() >= deadlineMs) {
        changed =
          addSnapshotWarning(snapshot, 'Server execution budget reached; progress was checkpointed.') || changed;
        stoppedReason = 'execution_budget';
        break;
      }

      const work = snapshot.frontier[0];
      if (!work) break;
      if (work.kind === 'continue_thread' && !/^t1_[a-z0-9_]+$/i.test(work.parentId)) {
        finishTraversalWork(snapshot, work);
        snapshot.unavailableBranches += 1;
        changed = true;
        changed =
          addSnapshotWarning(snapshot, 'A Reddit continue-thread branch had no usable comment parent ID.') || changed;
        continue;
      }

      let response;
      try {
        response =
          work.kind === 'more_children'
            ? await this.client.getJson<unknown>(
                '/api/morechildren',
                {
                  api_type: 'json',
                  link_id: `t3_${snapshot.postId}`,
                  children: work.children.join(','),
                  limit_children: 1,
                  raw_json: 1,
                  sort: snapshot.sort,
                },
                { deadlineMs },
              )
            : await this.client.getJson<unknown>(
                commentsPath(snapshot.postId),
                focusedCommentsQuery(snapshot.sort, work.parentId.replace(/^t1_/i, ''), 10, 500),
                { deadlineMs, normalizedPostId: snapshot.postId },
              );
      } catch (error) {
        if (error instanceof RedditRequestDeadlineError) {
          changed =
            addSnapshotWarning(snapshot, 'Server execution budget reached; progress was checkpointed.') || changed;
          stoppedReason = 'execution_budget';
          break;
        }
        if (error instanceof RedditFetchError || error instanceof RedditUpstreamError) {
          changed =
            addSnapshotWarning(snapshot, 'Reddit expansion failed transiently; progress was checkpointed for retry.') ||
            changed;
          stoppedReason = 'upstream_retryable';
          break;
        }
        throw error;
      }

      requests += 1;
      snapshot.redditRateLimit = response.rateLimit;
      snapshot.retryAfterSeconds = undefined;
      changed = true;
      if (response.status === 429) {
        snapshot.retryAfterSeconds = rateLimitResetSeconds(response.rateLimit);
        addSnapshotWarning(snapshot, 'Reddit rate-limited expansion; progress was checkpointed for retry.');
        stoppedReason = 'rate_limit';
        break;
      }
      if (response.status === 400 || response.status === 403 || response.status === 404) {
        markTraversalUnavailable(snapshot, work);
        finishTraversalWork(snapshot, work);
        addSnapshotWarning(
          snapshot,
          'Reddit no longer returned one requested comment branch; it was marked unavailable.',
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        addSnapshotWarning(snapshot, 'Reddit expansion failed transiently; progress was checkpointed for retry.');
        stoppedReason = 'upstream_retryable';
        break;
      }

      const beforeComments = snapshot.comments.length;
      const beforeFrontier = snapshot.frontier.length;
      if (work.kind === 'more_children') {
        const block = normalizeCommentBlockFromThings(response.body, work.parentId, work.depth, {
          maxComments: this.snapshotMaxComments,
        });
        const returned = flattenNormalizedComments(block.comments);
        const returnedIds = new Set(returned.map((comment) => comment.id.toLowerCase()));
        const deferredIds = new Set(
          block.more.flatMap((placeholder) => placeholder.children.map((child) => child.toLowerCase())),
        );
        ingestSnapshotComments(snapshot, returned, this.snapshotMaxComments, this.snapshotMaxBytes);
        for (const childId of work.children) {
          const normalizedChildId = childId.toLowerCase();
          if (!returnedIds.has(normalizedChildId) && !deferredIds.has(normalizedChildId)) {
            addUnavailableComment(snapshot, childId);
          }
        }
        finishTraversalWork(snapshot, work, deferredIds);
        enqueueTraversalWork(snapshot, block.more);
        const pendingChildren = new Set(
          snapshot.frontier.flatMap((pending) => (pending.kind === 'more_children' ? pending.children : [])),
        );
        const seenCommentIds = new Set(snapshot.seenCommentIds);
        for (const deferredId of deferredIds) {
          if (!returnedIds.has(deferredId) && !pendingChildren.has(deferredId) && !seenCommentIds.has(deferredId)) {
            addUnavailableComment(snapshot, deferredId);
          }
        }
        if (block.truncated) snapshot.resourceLimitReached = true;
      } else {
        const tree = normalizeInitialThread(snapshot.input, response.body, { maxComments: this.snapshotMaxComments });
        ingestSnapshotComments(
          snapshot,
          flattenNormalizedComments(tree.comments),
          this.snapshotMaxComments,
          this.snapshotMaxBytes,
        );
        finishTraversalWork(snapshot, work);
        enqueueTraversalWork(snapshot, tree.more);
        if (tree.truncated) snapshot.resourceLimitReached = true;
        if (snapshot.comments.length === beforeComments && snapshot.frontier.length <= beforeFrontier - 1) {
          snapshot.unavailableBranches += 1;
          addSnapshotWarning(snapshot, 'A Reddit continue-thread branch returned no additional retrievable comments.');
        }
      }
    }

    const exhausted = snapshot.frontier.length === 0 && !snapshot.resourceLimitReached;
    if (snapshot.sourceExhausted !== exhausted) {
      snapshot.sourceExhausted = exhausted;
      changed = true;
    }
    return { changed, requests, ...(stoppedReason ? { stoppedReason } : {}) };
  }

  private async expandCommentBlock(
    linkId: string,
    block: NormalizedCommentBlock,
    sort: RedditSort,
    maxComments: number,
    maxMoreChildrenRequests: number,
    expansionDeadlineMs: number,
    initialRateLimit: RedditRateLimit,
    existingRequests = 0,
  ): Promise<{ moreChildrenRequests: number; warnings: string[]; rateLimit?: RedditRateLimit }> {
    let moreChildrenRequests = existingRequests;
    let rateLimit: RedditRateLimit | undefined = initialRateLimit;
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
      if (isProviderExpansionBudgetExhausted(rateLimit)) {
        block.truncated = true;
        warnings.push('Reddit provider rate-limit reserve reached before all omitted comments were expanded.');
        break;
      }
      if (this.now() >= expansionDeadlineMs) {
        block.truncated = true;
        warnings.push('server expansion time budget reached before all omitted comments were expanded.');
        break;
      }

      const more = block.more.shift();
      if (!more) break;
      if (more.children.length === 0) {
        block.more.unshift(more);
        block.truncated = true;
        warnings.push('continue-thread traversal requires the resumable thread-comments page endpoint.');
        break;
      }
      const childBatches = chunk(more.children, MORE_CHILDREN_BATCH_SIZE);
      for (let batchIndex = 0; batchIndex < childBatches.length; batchIndex += 1) {
        const children = childBatches[batchIndex] ?? [];
        if (
          moreChildrenRequests >= maxMoreChildrenRequests ||
          block.commentsReturned >= maxComments ||
          isProviderExpansionBudgetExhausted(rateLimit) ||
          this.now() >= expansionDeadlineMs
        ) {
          block.truncated = true;
          prependUnprocessedMore(block.more, more, childBatches, batchIndex);
          break;
        }
        const response = await this.fetchMoreChildrenWithinDeadline(linkId, children, sort, more, expansionDeadlineMs);
        if (!response) {
          block.truncated = true;
          warnings.push('server expansion time budget reached before all omitted comments were expanded.');
          prependUnprocessedMore(block.more, more, childBatches, batchIndex);
          break;
        }
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

  private async fetchMoreChildrenWithinDeadline(
    linkId: string,
    children: string[],
    sort: string,
    more: MorePlaceholder,
    deadlineMs: number,
  ) {
    try {
      return await this.fetchMoreChildren(linkId, children, sort, more, deadlineMs);
    } catch (error) {
      if (error instanceof RedditRequestDeadlineError) return null;
      throw error;
    }
  }

  private async fetchMoreChildren(
    linkId: string,
    children: string[],
    sort: string,
    more: MorePlaceholder,
    deadlineMs: number,
  ) {
    const response = await this.client.getJson<unknown>(
      '/api/morechildren',
      {
        api_type: 'json',
        link_id: linkId,
        children: children.join(','),
        raw_json: 1,
        sort,
      },
      { deadlineMs },
    );
    assertRedditStatus(response.status, more.parentId);
    return response;
  }
}

function normalizeSnapshotQuery(request: RedditCommentQueryRequest): RedditSnapshotQuery {
  const maxDepth = normalizeOptionalInteger(request.maxDepth, 'maxDepth', 0, 50);
  const minScore = normalizeOptionalInteger(request.minScore, 'minScore', -1000000, 1000000);
  const minBodyLength = normalizeOptionalInteger(request.minBodyLength, 'minBodyLength', 0, 1000000);
  const parentId =
    typeof request.parentId === 'string' && request.parentId.trim() ? request.parentId.trim().toLowerCase() : undefined;
  return {
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(parentId ? { parentId } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
    ...(minBodyLength !== undefined ? { minBodyLength } : {}),
    includeDeleted: request.includeDeleted === true,
  };
}

function assertCompatibleSnapshotQuery(request: RedditCommentQueryRequest, query: RedditSnapshotQuery): void {
  const supplied = normalizeSnapshotQuery(request);
  for (const field of ['maxDepth', 'parentId', 'minScore', 'minBodyLength'] as const) {
    if (request[field] !== undefined && supplied[field] !== query[field]) {
      throw new RedditCursorError(`${field} is incompatible with the persisted snapshot cursor.`);
    }
  }
  if (request.includeDeleted !== undefined && supplied.includeDeleted !== query.includeDeleted) {
    throw new RedditCursorError('includeDeleted is incompatible with the persisted snapshot cursor.');
  }
}

function assertCursorOnlyRequest(request: RedditCommentQueryRequest): void {
  const incompatible = [
    request.post,
    request.url,
    request.redditUrl,
    request.reddit_url,
    request.threadUrl,
    request.thread_url,
    request.sort,
    request.maxComments,
  ].some((value) => value !== undefined && value !== null && value !== '');
  if (incompatible) {
    throw new RedditCursorError('Provide cursor without post/url, sort, or maxComments when resuming a snapshot.');
  }
}

function normalizeInitialSnapshotPostInput(request: RedditCommentQueryRequest): string {
  const selectors = [
    request.post,
    request.url,
    request.redditUrl,
    request.reddit_url,
    request.threadUrl,
    request.thread_url,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (selectors.length !== 1) {
    throw new RedditInputError('Provide exactly one Reddit post or URL selector when starting a snapshot.');
  }
  return selectors[0].trim();
}

function assertSnapshotAvailable(snapshot: RedditThreadSnapshot, now: () => number): void {
  if (snapshot.version !== REDDIT_THREAD_SNAPSHOT_VERSION) {
    throw new RedditCursorError(
      'snapshot version is not supported. Start a new exhaustive crawl.',
      'REDDIT_CURSOR_VERSION_MISMATCH',
    );
  }
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new RedditSnapshotExpiredError();
}

function traversalWorkFromMore(
  more: MorePlaceholder[],
  options: {
    postId: string;
    seenCommentIds: Set<string>;
    processedChildIds?: Set<string>;
    processedFrontierKeys?: Set<string>;
    pending?: RedditTraversalWork[];
  },
): RedditTraversalWork[] {
  const processedChildIds = options.processedChildIds ?? new Set<string>();
  const processedFrontierKeys = options.processedFrontierKeys ?? new Set<string>();
  const pending = options.pending ?? [];
  const pendingKeys = new Set(pending.map((work) => work.key));
  const claimedChildren = new Set<string>([
    ...options.seenCommentIds,
    ...processedChildIds,
    ...pending.flatMap((work) => (work.kind === 'more_children' ? work.children : [])),
  ]);
  const created: RedditTraversalWork[] = [];

  for (const placeholder of more) {
    const parentId = (placeholder.parentId || `t3_${options.postId}`).toLowerCase();
    if (placeholder.children.length === 0) {
      const key = `continue:${parentId}`;
      if (!processedFrontierKeys.has(key) && !pendingKeys.has(key)) {
        const work: RedditTraversalWork = {
          kind: 'continue_thread',
          key,
          parentId,
          depth: placeholder.depth,
          count: Math.max(0, placeholder.count),
        };
        created.push(work);
        pendingKeys.add(key);
      }
      continue;
    }

    const children = [...new Set(placeholder.children.map((child) => child.trim().toLowerCase()))].filter(
      (child) => /^[a-z0-9][a-z0-9_]{1,12}$/i.test(child) && !claimedChildren.has(child),
    );
    for (const batch of chunk(children, MORE_CHILDREN_BATCH_SIZE)) {
      const key = `more:${parentId}:${batch.join(',')}`;
      if (batch.length === 0 || processedFrontierKeys.has(key) || pendingKeys.has(key)) continue;
      const work: RedditTraversalWork = {
        kind: 'more_children',
        key,
        parentId,
        depth: placeholder.depth,
        children: batch,
        count: Math.max(batch.length, placeholder.count),
      };
      created.push(work);
      pendingKeys.add(key);
      for (const child of batch) claimedChildren.add(child);
    }
  }
  return created;
}

function enqueueTraversalWork(snapshot: RedditThreadSnapshot, more: MorePlaceholder[]): void {
  snapshot.frontier.push(
    ...traversalWorkFromMore(more, {
      postId: snapshot.postId,
      seenCommentIds: new Set(snapshot.seenCommentIds),
      processedChildIds: new Set(snapshot.processedChildIds),
      processedFrontierKeys: new Set(snapshot.processedFrontierKeys),
      pending: snapshot.frontier,
    }),
  );
}

function finishTraversalWork(
  snapshot: RedditThreadSnapshot,
  work: RedditTraversalWork,
  deferredChildIds: ReadonlySet<string> = new Set(),
): void {
  if (snapshot.frontier[0]?.key === work.key) snapshot.frontier.shift();
  if (!snapshot.processedFrontierKeys.includes(work.key)) snapshot.processedFrontierKeys.push(work.key);
  if (work.kind === 'more_children') {
    const processed = new Set(snapshot.processedChildIds);
    for (const child of work.children) {
      const normalized = child.toLowerCase();
      if (!deferredChildIds.has(normalized)) processed.add(normalized);
    }
    snapshot.processedChildIds = [...processed];
  }
}

function markTraversalUnavailable(snapshot: RedditThreadSnapshot, work: RedditTraversalWork): void {
  if (work.kind === 'more_children') {
    for (const child of work.children) addUnavailableComment(snapshot, child);
  } else {
    snapshot.unavailableBranches += Math.max(1, work.count);
  }
}

function addUnavailableComment(snapshot: RedditThreadSnapshot, commentId: string): void {
  const normalized = commentId.toLowerCase();
  if (snapshot.seenCommentIds.includes(normalized)) return;
  if (!snapshot.unavailableCommentIds.includes(normalized)) snapshot.unavailableCommentIds.push(normalized);
  if (!snapshot.processedChildIds.includes(normalized)) snapshot.processedChildIds.push(normalized);
}

function ingestSnapshotComments(
  snapshot: RedditThreadSnapshot,
  comments: RedditCommentDto[],
  maxComments: number,
  maxBytes: number,
): void {
  const seen = new Set(snapshot.seenCommentIds);
  let approximateBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  const usableByteLimit = Math.max(1, maxBytes - 8 * 1024 * 1024);
  for (const comment of comments) {
    const id = comment.id.toLowerCase();
    if (!id) continue;
    snapshot.unavailableCommentIds = snapshot.unavailableCommentIds.filter((unavailableId) => unavailableId !== id);
    if (seen.has(id)) continue;
    if (snapshot.comments.length >= maxComments) {
      snapshot.resourceLimitReached = true;
      snapshot.sourceExhausted = false;
      addSnapshotWarning(
        snapshot,
        `Snapshot resource limit of ${maxComments} comments reached; traversal is incomplete.`,
      );
      break;
    }
    const storedComment = { ...comment, id, replies: [] };
    const incrementalBytes = Buffer.byteLength(JSON.stringify(storedComment), 'utf8') + Buffer.byteLength(id) + 64;
    if (approximateBytes + incrementalBytes > usableByteLimit) {
      snapshot.resourceLimitReached = true;
      snapshot.sourceExhausted = false;
      addSnapshotWarning(snapshot, `Snapshot byte resource limit of ${maxBytes} reached; traversal is incomplete.`);
      break;
    }
    snapshot.comments.push(storedComment);
    snapshot.seenCommentIds.push(id);
    seen.add(id);
    approximateBytes += incrementalBytes;
  }
}

function flattenNormalizedComments(comments: RedditCommentDto[]): RedditCommentDto[] {
  const flattened: RedditCommentDto[] = [];
  const visit = (comment: RedditCommentDto): void => {
    flattened.push({ ...comment, id: comment.id.toLowerCase(), replies: [] });
    for (const reply of comment.replies) visit(reply);
  };
  for (const comment of comments) visit(comment);
  return flattened;
}

function dedupeNormalizedComments(comments: RedditCommentDto[]): RedditCommentDto[] {
  const seen = new Set<string>();
  return comments.filter((comment) => {
    const id = comment.id.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function snapshotCommentRows(
  comments: RedditCommentDto[],
  options: { includeBody: boolean; bodyPreviewChars: number },
): RedditCommentSkeletonDto[] {
  const replyCounts = new Map<string, number>();
  for (const comment of comments) {
    const parentId = comment.parentId.toLowerCase();
    replyCounts.set(parentId, (replyCounts.get(parentId) ?? 0) + 1);
  }
  return comments.map((comment) => {
    const isDeleted = comment.author === '[deleted]' || comment.body === '[deleted]' || comment.body === '[removed]';
    return {
      id: comment.id,
      fullname: comment.fullname,
      parentId: comment.parentId,
      author: comment.author,
      depth: comment.depth,
      score: comment.score,
      replyCount: replyCounts.get(comment.fullname.toLowerCase()) ?? 0,
      bodyLength: comment.body.length,
      bodyPreview: options.bodyPreviewChars > 0 ? comment.body.slice(0, options.bodyPreviewChars) : '',
      createdUtc: comment.createdUtc,
      isDeleted,
      ...(options.includeBody ? { body: comment.body } : {}),
    };
  });
}

function applySnapshotFilters(
  rows: RedditCommentSkeletonDto[],
  query: RedditSnapshotQuery,
): RedditCommentSkeletonDto[] {
  return rows.filter((row) => {
    if (query.maxDepth !== undefined && row.depth > query.maxDepth) return false;
    if (query.minScore !== undefined && row.score < query.minScore) return false;
    if (query.minBodyLength !== undefined && row.bodyLength < query.minBodyLength) return false;
    if (query.parentId && row.parentId.toLowerCase() !== query.parentId) return false;
    if (!query.includeDeleted && row.isDeleted) return false;
    return true;
  });
}

function coverageForSnapshot(
  snapshot: RedditThreadSnapshot,
  cursorsRemaining: boolean,
  stoppedReason?: NonNullable<RedditCoverageDto['stoppedReason']>,
): RedditCoverageDto {
  const retrievedUnique = new Set(snapshot.seenCommentIds).size;
  const deleted = snapshot.comments.filter(
    (comment) => comment.author === '[deleted]' || comment.body === '[deleted]' || comment.body === '[removed]',
  ).length;
  const unavailable = snapshot.unavailableCommentIds.length + snapshot.unavailableBranches;
  const complete = snapshot.sourceExhausted && !snapshot.resourceLimitReached;
  return {
    reportedTotal: snapshot.reportedTotal,
    retrievedUnique,
    uniqueReturned: retrievedUnique,
    deleted,
    unavailable,
    unavailableBranches: snapshot.unavailableBranches,
    knownRemaining: Math.max(0, snapshot.reportedTotal - retrievedUnique - unavailable),
    cursorsRemaining,
    continuationsRemaining: snapshot.frontier.length,
    frontierRemaining: snapshot.frontier.length,
    sortsSampled: [snapshot.sort],
    complete,
    snapshotComplete: complete,
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(snapshot.retryAfterSeconds !== undefined ? { retryAfterSeconds: snapshot.retryAfterSeconds } : {}),
  };
}

function rateLimitResetSeconds(rateLimit: RedditRateLimit): number | undefined {
  if (rateLimit.resetSeconds === null || rateLimit.resetSeconds === undefined || rateLimit.resetSeconds === '') {
    return undefined;
  }
  const value = Number(rateLimit.resetSeconds);
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}

function addSnapshotWarning(snapshot: RedditThreadSnapshot, warning: string): boolean {
  if (snapshot.warnings.includes(warning)) return false;
  snapshot.warnings.push(warning);
  return true;
}

function logRedditSnapshotProgress(
  snapshot: RedditThreadSnapshot,
  upstreamRequests: number,
  complete: boolean,
  startedAt: number,
  stoppedReason?: RedditCoverageDto['stoppedReason'],
): void {
  console.info('reddit_thread_snapshot_progress', {
    snapshot_id: snapshot.snapshotId,
    post_id: snapshot.postId,
    retrieved_unique: snapshot.seenCommentIds.length,
    frontier_size: snapshot.frontier.length,
    upstream_requests: upstreamRequests,
    complete,
    stopped_reason: stoppedReason,
    elapsed_ms: Date.now() - startedAt,
  });
}

function isProviderExpansionBudgetExhausted(rateLimit: RedditRateLimit | undefined): boolean {
  const remaining = rateLimit?.remaining?.trim();
  if (!remaining) return false;
  const parsed = Number(remaining);
  return Number.isFinite(parsed) && parsed <= REDDIT_RATE_LIMIT_RESERVE;
}

function prependUnprocessedMore(
  target: MorePlaceholder[],
  source: Pick<MorePlaceholder, 'parentId' | 'depth'>,
  batches: string[][],
  batchIndex: number,
): void {
  const children = batches.slice(batchIndex).flat();
  if (children.length > 0)
    target.unshift({
      parentId: source.parentId,
      depth: source.depth,
      children,
      count: children.length,
      id: children[0] ?? '',
    });
}

export class RedditShareResolutionError extends RedditInputError {
  readonly resolution: Exclude<RedditShareResolution, { status: 'resolved' }>;

  constructor(resolution: Exclude<RedditShareResolution, { status: 'resolved' }>) {
    const code =
      resolution.status === 'blocked_by_reddit_web' ? 'REDDIT_SHARE_RESOLUTION_BLOCKED' : 'UNRESOLVED_REDDIT_SHARE_URL';
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
  if (error instanceof RedditCursorError) {
    return { status: error.status, message: error.message, code: error.code, kind: 'input' };
  }
  if (error instanceof RedditSnapshotNotFoundError || error instanceof RedditSnapshotExpiredError) {
    return { status: error.status, message: error.message, code: error.code, kind: 'content' };
  }
  if (error instanceof RedditSnapshotConflictError) {
    return {
      status: 409,
      message: 'The Reddit snapshot changed concurrently. Retry with the same cursor.',
      code: 'REDDIT_SNAPSHOT_CONFLICT',
      kind: 'input',
    };
  }
  if (error instanceof RedditPrincipalConcurrencyError) {
    return {
      status: 429,
      message: error.message,
      code: 'REDDIT_PRINCIPAL_CONCURRENCY_LIMIT',
      kind: 'input',
    };
  }
  if (error instanceof RedditInputError) {
    return { status: 400, message: error.message, code: error.code, input: error.input, kind: 'input' };
  }
  if (error instanceof RedditConfigError) {
    return {
      status: 502,
      message: 'The Reddit integration is not configured correctly.',
      code: 'REDDIT_CONFIG_ERROR',
      kind: 'config',
    };
  }
  if (error instanceof RedditContentError) {
    return { status: error.status, message: error.message, kind: 'content' };
  }
  if (error instanceof RedditFetchError) {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    return {
      status,
      message: safeRedditFetchMessage(error),
      code: 'REDDIT_FETCH_ERROR',
      redditFetchError: error.toJSON(),
      kind: 'fetch',
    };
  }
  if (error instanceof RedditUpstreamError) {
    return { status: error.status, message: safeRedditUpstreamMessage(error), kind: 'upstream' };
  }
  return {
    status: 502,
    message: 'Unexpected internal service failure.',
    code: 'INTERNAL_SERVICE_ERROR',
    kind: 'internal',
  };
}

function safeRedditFetchMessage(error: RedditFetchError): string {
  if (error.status === 429) return 'Reddit rate-limited the request.';
  if (error.status && error.status >= 500) return 'Reddit upstream request failed with a retryable status.';
  return 'Reddit fetch failed before a valid JSON response was available.';
}

function safeRedditUpstreamMessage(error: RedditUpstreamError): string {
  if (error.status === 429 || error.upstreamStatus === 429) return 'Reddit rate-limited the request.';
  if (error.upstreamStatus && error.upstreamStatus >= 500)
    return 'Reddit upstream request failed with a retryable status.';
  return 'Reddit upstream request failed.';
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

function normalizeRequestPostInput(
  request: RedditThreadRequest | RedditCommentTreeRequest | RedditThreadOverviewRequest | RedditCommentQueryRequest,
): string {
  if (!request || typeof request !== 'object') {
    throw new RedditInputError('post must be a non-empty string.');
  }

  const post =
    request.post ?? request.url ?? request.redditUrl ?? request.reddit_url ?? request.threadUrl ?? request.thread_url;
  if (typeof post !== 'string') {
    throw new RedditInputError('post must be a non-empty string.');
  }
  return post;
}

function flattenComments(
  comments: RedditCommentDto[],
  options: { includeBody: boolean; bodyPreviewChars: number },
): RedditCommentSkeletonDto[] {
  const rows: RedditCommentSkeletonDto[] = [];
  const visit = (comment: RedditCommentDto): void => {
    const isDeleted = comment.author === '[deleted]' || comment.body === '[deleted]' || comment.body === '[removed]';
    const row: RedditCommentSkeletonDto = {
      id: comment.id,
      fullname: comment.fullname,
      parentId: comment.parentId,
      author: comment.author,
      depth: comment.depth,
      score: comment.score,
      replyCount: comment.replies.length,
      bodyLength: comment.body.length,
      bodyPreview: options.bodyPreviewChars > 0 ? comment.body.slice(0, options.bodyPreviewChars) : '',
      createdUtc: comment.createdUtc,
      isDeleted,
      ...(options.includeBody ? { body: comment.body } : {}),
    };
    rows.push(row);
    for (const reply of comment.replies) visit(reply);
  };
  for (const comment of comments) visit(comment);
  return rows;
}

function pageRows(
  rows: RedditCommentSkeletonDto[],
  offset: number,
  limit: number,
  maxBytes: number,
): { rows: RedditCommentSkeletonDto[]; nextOffset: number; truncatedBy: 'limit' | 'maxBytes' | 'cursor' | null } {
  const page: RedditCommentSkeletonDto[] = [];
  let index = offset;
  let truncatedBy: 'limit' | 'maxBytes' | 'cursor' | null = null;
  while (index < rows.length && page.length < limit) {
    const candidate = rows[index];
    if (Buffer.byteLength(JSON.stringify([...page, candidate]), 'utf8') > maxBytes) {
      truncatedBy = 'maxBytes';
      if (page.length === 0) {
        page.push(candidate);
        index += 1;
      }
      break;
    }
    page.push(candidate);
    index += 1;
  }
  if (!truncatedBy && page.length >= limit && index < rows.length) truncatedBy = 'limit';
  return { rows: page, nextOffset: index, truncatedBy };
}

function coverageFor(
  reportedTotal: number,
  rows: RedditCommentSkeletonDto[],
  more: { children: string[] }[],
  sort: RedditSort,
  uniqueReturned: number,
  complete: boolean,
): RedditCoverageDto {
  const deleted = rows.filter((row) => row.isDeleted).length;
  const continuationsRemaining = more.reduce((total, continuation) => total + continuation.children.length, 0);
  const knownRemaining = Math.max(0, reportedTotal - uniqueReturned);
  return {
    reportedTotal,
    retrievedUnique: uniqueReturned,
    uniqueReturned,
    deleted,
    unavailable: 0,
    unavailableBranches: 0,
    knownRemaining,
    cursorsRemaining: !complete,
    continuationsRemaining,
    frontierRemaining: more.length,
    sortsSampled: [sort],
    complete: complete && continuationsRemaining === 0,
    snapshotComplete: complete && continuationsRemaining === 0,
  };
}

function commentRowsFromInfoListing(value: unknown): RedditCommentSkeletonDto[] {
  if (!value || typeof value !== 'object') return [];
  const children = (value as { data?: { children?: unknown[] } }).data?.children;
  if (!Array.isArray(children)) return [];
  const rows: RedditCommentSkeletonDto[] = [];
  for (const child of children) {
    const thing = child as { kind?: unknown; data?: Record<string, unknown> };
    const data = thing.data;
    if (thing.kind !== 't1' || !data) continue;
    const id = stringValue(data['id']);
    if (!id) continue;
    const body = stringValue(data['body']);
    const author = stringValue(data['author']);
    const isDeleted = author === '[deleted]' || body === '[deleted]' || body === '[removed]';
    rows.push({
      id: id.toLowerCase(),
      fullname: stringValue(data['name']) || `t1_${id.toLowerCase()}`,
      parentId: stringValue(data['parent_id']),
      author,
      depth: 0,
      score: numberValue(data['score']),
      replyCount: null,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 200),
      createdUtc: numberValue(data['created_utc']),
      isDeleted,
      body,
    });
  }
  return rows;
}

const BATCH_FIELDS = new Set([
  'id',
  'fullname',
  'parentId',
  'author',
  'depth',
  'score',
  'createdUtc',
  'body',
  'bodyPreview',
  'bodyLength',
  'replyCount',
  'isDeleted',
]);

function projectCommentFields(row: RedditCommentSkeletonDto, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    result[field] = (row as unknown as Record<string, unknown>)[field];
  }
  return result;
}

function normalizeBatchIds(input: unknown): string[] {
  const values = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : null;
  if (!values) throw new RedditInputError('ids must be an array of Reddit comment IDs or a comma-separated string.');
  const ids = values
    .map((value) => {
      if (typeof value !== 'string') throw new RedditInputError('ids must contain only Reddit comment ID strings.');
      const id = value.trim().replace(/^t1_/i, '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_]{1,12}$/i.test(id))
        throw new RedditInputError('ids must contain valid Reddit comment IDs.');
      return id;
    })
    .filter(Boolean);
  if (ids.length === 0) throw new RedditInputError('ids must contain at least one Reddit comment ID.');
  return [...new Set(ids)].slice(0, 100);
}

function normalizeBatchFields(input: unknown): string[] {
  if (input === undefined || input === null || input === '')
    return ['id', 'parentId', 'score', 'depth', 'body', 'replyCount'];
  const values = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : null;
  if (!values) throw new RedditInputError('fields must be an array or comma-separated string.');
  const fields = values.map((value) => {
    if (typeof value !== 'string') throw new RedditInputError('fields must contain only strings.');
    const field = value.trim();
    if (!BATCH_FIELDS.has(field)) throw new RedditInputError('fields contains an unsupported comment field.');
    return field;
  });
  return [...new Set(fields)].slice(0, 12);
}

function normalizeQueryLimit(input: unknown): number {
  if (input === undefined || input === null) return 200;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1)
    throw new RedditInputError('limit must be a positive integer.');
  return Math.min(input, 500);
}

function normalizeQuerySnapshotMaxComments(input: unknown): number {
  if (input === undefined || input === null) return 1000;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1)
    throw new RedditInputError('maxComments must be a positive integer.');
  return Math.min(input, 10000);
}

function normalizeBodyPreviewChars(input: unknown): number {
  if (input === undefined || input === null) return 160;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0)
    throw new RedditInputError('bodyPreviewChars must be a non-negative integer.');
  return Math.min(input, 500);
}

function normalizeMaxBytes(input: unknown): number {
  if (input === undefined || input === null) return 500000;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1000)
    throw new RedditInputError('maxBytes must be an integer of at least 1000.');
  return Math.min(input, 2000000);
}

function normalizeOptionalInteger(input: unknown, field: string, min: number, max: number): number | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min)
    throw new RedditInputError(`${field} must be an integer greater than or equal to ${min}.`);
  return Math.min(input, max);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
  const normalized = values
    .map((value) => {
      if (typeof value !== 'string') {
        throw new RedditInputError('children must contain only Reddit comment ID strings.');
      }
      const id = value.trim().replace(/^t1_/i, '');
      if (!/^[a-z0-9][a-z0-9_]{1,12}$/i.test(id)) {
        throw new RedditInputError('children must contain valid Reddit comment IDs.');
      }
      return id.toLowerCase();
    })
    .filter(Boolean);
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
    normalized_post_id: args.normalizedPostId,
    normalized_comment_id: args.normalizedCommentId,
    request_url: stripLogUrl(args.requestUrl),
    final_url: stripLogUrl(args.finalUrl),
    status: args.status,
    content_type: safeLogContentType(args.contentType),
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
    content_type: safeLogContentType(resolution.contentType),
    redirect_count: Math.max(0, resolution.redirectChain.length - 1),
    final_url: finalUrl,
    extracted_post_id: resolution.status === 'resolved' ? resolution.postId : undefined,
    redirect_chain: resolution.redirectChain
      .map((url) => stripLogUrl(url))
      .filter((url): url is string => Boolean(url)),
  });
}

function stripLogUrl(value: string | undefined): string | undefined {
  return sanitizeRedditTelemetryUrl(value);
}

function safeLogContentType(value: string | null | undefined): string | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : undefined;
}

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const sanitized = sanitizeRedditTelemetryUrl(value);
    return sanitized ? new URL(sanitized).hostname.toLowerCase() : undefined;
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
