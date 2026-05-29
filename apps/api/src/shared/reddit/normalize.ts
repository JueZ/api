import type { RedditCommentContinuationDto, RedditCommentDto, RedditCommentTreeResponse, RedditCommentTreeStats, RedditPostDto, RedditRateLimit, RedditSort, RedditThreadResponse, RedditThreadStats } from './types.js';

export interface RedditListing<T = unknown> {
  kind?: string;
  data?: {
    children?: RedditThing<T>[];
  };
}

export interface RedditThing<T = unknown> {
  kind?: string;
  data?: T;
}

export interface MorePlaceholder {
  parentId: string;
  depth: number;
  children: string[];
}

export interface NormalizedCommentTree {
  post: RedditPostDto;
  comments: RedditCommentDto[];
  commentByFullname: Map<string, RedditCommentDto>;
  more: MorePlaceholder[];
  commentsReturned: number;
  truncated: boolean;
  warnings: string[];
}

export interface NormalizedCommentBlock {
  comments: RedditCommentDto[];
  commentByFullname: Map<string, RedditCommentDto>;
  more: MorePlaceholder[];
  commentsReturned: number;
  truncated: boolean;
  warnings: string[];
}

interface NormalizeOptions {
  maxComments: number;
}

export function normalizeInitialThread(
  input: string,
  listings: unknown,
  options: NormalizeOptions,
): NormalizedCommentTree {
  const [postListing, commentListing] = assertListingPair(listings);
  const postThing = postListing.data?.children?.find((child) => child.kind === 't3');
  if (!postThing?.data || typeof postThing.data !== 'object') {
    throw new RedditContentError('Reddit post was not found.', 404);
  }

  const state = createNormalizeState(options.maxComments);
  const post = normalizePost(postThing.data as Record<string, unknown>);
  const comments = normalizeCommentChildren(commentListing.data?.children ?? [], 0, state);

  return {
    post,
    comments,
    commentByFullname: state.commentByFullname,
    more: state.more,
    commentsReturned: state.commentsReturned,
    truncated: state.truncated,
    warnings: state.warnings,
  };
}

export function attachMoreChildren(
  tree: NormalizedCommentTree | NormalizedCommentBlock,
  things: unknown,
  parentId: string,
  depth: number,
  maxComments: number,
): void {
  const listing = assertMoreChildrenListing(things);
  const state: NormalizeState = {
    commentByFullname: tree.commentByFullname,
    more: tree.more,
    commentsReturned: tree.commentsReturned,
    maxComments,
    truncated: tree.truncated,
    warnings: tree.warnings,
  };

  for (const thing of listing) {
    if (state.commentsReturned >= state.maxComments) {
      markTruncated(state, 'maxComments limit reached while expanding omitted comments.');
      break;
    }

    if (thing.kind === 't1' && thing.data && typeof thing.data === 'object') {
      const comment = normalizeComment(thing.data as Record<string, unknown>, depth, state);
      if (!comment) {
        continue;
      }
      const parent = tree.commentByFullname.get(comment.parentId) ?? tree.commentByFullname.get(parentId);
      if (parent) {
        parent.replies.push(comment);
      } else {
        tree.comments.push(comment);
      }
    } else if (thing.kind === 'more') {
      collectMore(thing.data, parentId, depth, state);
    }
  }

  tree.commentsReturned = state.commentsReturned;
  tree.truncated = state.truncated;
}

export function createThreadResponse(
  input: string,
  tree: NormalizedCommentTree,
  stats: Omit<RedditThreadStats, 'commentsReturned' | 'continuationsReturned'>,
  rateLimit: RedditRateLimit,
  fetchedAt: Date = new Date(),
): RedditThreadResponse {
  const commentContinuations = continuationDtos(tree.more);
  return {
    source: 'reddit',
    fetchedAt: fetchedAt.toISOString(),
    input,
    post: tree.post,
    comments: tree.comments,
    commentContinuations,
    stats: {
      ...stats,
      commentsReturned: tree.commentsReturned,
      truncated: stats.truncated || tree.truncated,
      warnings: [...new Set([...tree.warnings, ...stats.warnings])],
      continuationsReturned: commentContinuations.length,
    },
    redditRateLimit: rateLimit,
  };
}

export function createCommentTreeResponse(
  input: string,
  post: RedditPostDto,
  block: NormalizedCommentBlock,
  stats: Omit<RedditCommentTreeStats, 'commentsReturned' | 'continuationsReturned'>,
  rateLimit: RedditRateLimit,
  details: { mode: 'comment' | 'children'; rootCommentId?: string; parentId?: string; requestedChildren?: string[] },
  fetchedAt: Date = new Date(),
): RedditCommentTreeResponse {
  const commentContinuations = continuationDtos(block.more);
  return {
    source: 'reddit',
    fetchedAt: fetchedAt.toISOString(),
    input,
    post,
    mode: details.mode,
    ...(details.rootCommentId ? { rootCommentId: details.rootCommentId } : {}),
    ...(details.parentId ? { parentId: details.parentId } : {}),
    ...(details.requestedChildren ? { requestedChildren: details.requestedChildren } : {}),
    comments: block.comments,
    commentContinuations,
    stats: {
      ...stats,
      commentsReturned: block.commentsReturned,
      truncated: stats.truncated || block.truncated,
      warnings: [...new Set([...block.warnings, ...stats.warnings])],
      continuationsReturned: commentContinuations.length,
    },
    redditRateLimit: rateLimit,
  };
}

export function normalizeCommentBlockFromThings(
  things: unknown,
  parentId: string,
  depth: number,
  options: NormalizeOptions,
): NormalizedCommentBlock {
  const state = createNormalizeState(options.maxComments);
  const comments: RedditCommentDto[] = [];
  for (const thing of assertMoreChildrenListing(things)) {
    if (state.commentsReturned >= state.maxComments) {
      markTruncated(state, 'maxComments limit reached while parsing comment block.');
      break;
    }
    if (thing.kind === 't1' && thing.data && typeof thing.data === 'object') {
      const comment = normalizeComment(thing.data as Record<string, unknown>, depth, state);
      if (comment) {
        const parent = state.commentByFullname.get(comment.parentId) ?? state.commentByFullname.get(parentId);
        if (parent) parent.replies.push(comment);
        else comments.push(comment);
      }
    } else if (thing.kind === 'more') {
      collectMore(thing.data, parentId, depth, state);
    }
  }
  return { comments, commentByFullname: state.commentByFullname, more: state.more, commentsReturned: state.commentsReturned, truncated: state.truncated, warnings: state.warnings };
}

export function normalizeFocusedCommentBlock(
  listings: unknown,
  options: NormalizeOptions,
): { post: RedditPostDto; block: NormalizedCommentBlock } {
  const tree = normalizeInitialThread('', listings, options);
  return {
    post: tree.post,
    block: {
      comments: tree.comments,
      commentByFullname: tree.commentByFullname,
      more: tree.more,
      commentsReturned: tree.commentsReturned,
      truncated: tree.truncated,
      warnings: tree.warnings,
    },
  };
}

export class RedditContentError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404,
  ) {
    super(message);
    this.name = 'RedditContentError';
  }
}

interface NormalizeState {
  commentByFullname: Map<string, RedditCommentDto>;
  more: MorePlaceholder[];
  commentsReturned: number;
  maxComments: number;
  truncated: boolean;
  warnings: string[];
}

function createNormalizeState(maxComments: number): NormalizeState {
  return {
    commentByFullname: new Map(),
    more: [],
    commentsReturned: 0,
    maxComments,
    truncated: false,
    warnings: [],
  };
}

function normalizePost(data: Record<string, unknown>): RedditPostDto {
  const id = stringValue(data['id']);
  return {
    id,
    fullname: stringValue(data['name']) || `t3_${id}`,
    subreddit: stringValue(data['subreddit']),
    title: stringValue(data['title']),
    author: stringValue(data['author']),
    selftext: stringValue(data['selftext']),
    url: stringValue(data['url']),
    permalink: stringValue(data['permalink']),
    score: numberValue(data['score']),
    numComments: numberValue(data['num_comments']),
    createdUtc: numberValue(data['created_utc']),
    over18: booleanValue(data['over_18']),
    locked: booleanValue(data['locked']),
    archived: booleanValue(data['archived']),
  };
}

function normalizeCommentChildren(
  things: RedditThing[],
  depth: number,
  state: NormalizeState,
): RedditCommentDto[] {
  const comments: RedditCommentDto[] = [];
  for (const thing of things) {
    if (state.commentsReturned >= state.maxComments) {
      markTruncated(state, 'maxComments limit reached while parsing comments.');
      break;
    }

    if (thing.kind === 't1' && thing.data && typeof thing.data === 'object') {
      const comment = normalizeComment(thing.data as Record<string, unknown>, depth, state);
      if (comment) {
        comments.push(comment);
      }
    } else if (thing.kind === 'more') {
      collectMore(thing.data, '', depth, state);
    }
  }
  return comments;
}

function normalizeComment(
  data: Record<string, unknown>,
  depth: number,
  state: NormalizeState,
): RedditCommentDto | null {
  const id = stringValue(data['id']);
  const fullname = stringValue(data['name']) || (id ? `t1_${id}` : '');
  if (!id || !fullname) {
    return null;
  }

  state.commentsReturned += 1;
  const comment: RedditCommentDto = {
    id,
    fullname,
    parentId: stringValue(data['parent_id']),
    author: stringValue(data['author']),
    body: stringValue(data['body']),
    score: numberValue(data['score']),
    createdUtc: numberValue(data['created_utc']),
    depth,
    replies: [],
  };
  state.commentByFullname.set(fullname, comment);

  const replies = data['replies'];
  if (replies && typeof replies === 'object') {
    const listing = replies as RedditListing;
    comment.replies = normalizeCommentChildren(listing.data?.children ?? [], depth + 1, state);
  }

  return comment;
}

function collectMore(data: unknown, fallbackParentId: string, fallbackDepth: number, state: NormalizeState): void {
  if (!data || typeof data !== 'object') {
    return;
  }
  const more = data as Record<string, unknown>;
  const children = Array.isArray(more['children']) ? more['children'].filter((child): child is string => typeof child === 'string') : [];
  if (children.length === 0) {
    return;
  }
  state.more.push({
    parentId: stringValue(more['parent_id']) || fallbackParentId,
    depth: Number.isFinite(more['depth']) ? numberValue(more['depth']) : fallbackDepth,
    children,
  });
}

function assertListingPair(value: unknown): [RedditListing, RedditListing] {
  if (!Array.isArray(value) || value.length < 2 || !isListing(value[0]) || !isListing(value[1])) {
    throw new RedditContentError('Reddit returned an unexpected thread response.', 404);
  }
  return [value[0], value[1]];
}

function assertMoreChildrenListing(value: unknown): RedditThing[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const data = (value as { json?: { data?: { things?: RedditThing[] } } }).json?.data;
  return Array.isArray(data?.things) ? data.things : [];
}

function isListing(value: unknown): value is RedditListing {
  return Boolean(value && typeof value === 'object' && 'data' in value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function markTruncated(state: NormalizeState, warning: string): void {
  state.truncated = true;
  if (!state.warnings.includes(warning)) {
    state.warnings.push(warning);
  }
}

export function commentsPath(articleId: string): string {
  return `/comments/${articleId}`;
}

export function commentsQuery(sort: RedditSort, maxComments: number): Record<string, string | number> {
  return {
    raw_json: 1,
    sort,
    limit: Math.min(maxComments, 500),
    depth: 10,
  };
}

export function focusedCommentsQuery(sort: RedditSort, commentId: string, depth: number, limit: number): Record<string, string | number> {
  return {
    raw_json: 1,
    sort,
    comment: commentId,
    context: 0,
    depth,
    limit: Math.min(limit, 500),
  };
}

function continuationDtos(more: MorePlaceholder[]): RedditCommentContinuationDto[] {
  return more.map((placeholder) => ({
    parentId: placeholder.parentId,
    depth: placeholder.depth,
    children: placeholder.children,
    childCount: placeholder.children.length,
  }));
}
