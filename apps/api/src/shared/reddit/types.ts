export type RedditSort = 'confidence' | 'top' | 'new' | 'controversial' | 'old' | 'qa';

export interface RedditThreadRequest {
  post?: string;
  url?: string;
  redditUrl?: string;
  reddit_url?: string;
  threadUrl?: string;
  thread_url?: string;
  sort?: RedditSort;
  maxComments?: number;
  maxMoreChildrenRequests?: number;
}

export interface RedditPostDto {
  id: string;
  fullname: string;
  subreddit: string;
  title: string;
  author: string;
  selftext: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdUtc: number;
  over18: boolean;
  locked: boolean;
  archived: boolean;
}

export interface RedditCommentDto {
  id: string;
  fullname: string;
  parentId: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  depth: number;
  replies: RedditCommentDto[];
}

export interface RedditCommentContinuationDto {
  parentId: string;
  depth: number;
  children: string[];
  childCount: number;
}

export interface RedditThreadStats {
  commentsReturned: number;
  moreChildrenRequests: number;
  truncated: boolean;
  warnings: string[];
  continuationsReturned: number;
}

export interface RedditRateLimit {
  used: string | null;
  remaining: string | null;
  resetSeconds: string | null;
}

export interface RedditThreadResponse {
  source: 'reddit';
  fetchedAt: string;
  input: string;
  post: RedditPostDto;
  comments: RedditCommentDto[];
  commentContinuations: RedditCommentContinuationDto[];
  stats: RedditThreadStats;
  redditRateLimit: RedditRateLimit;
}

export interface RedditCommentTreeRequest {
  post?: string;
  url?: string;
  redditUrl?: string;
  reddit_url?: string;
  threadUrl?: string;
  thread_url?: string;
  commentId?: string;
  children?: string[] | string;
  parentId?: string;
  sort?: RedditSort;
  depth?: number;
  limit?: number;
  maxMoreChildrenRequests?: number;
}

export interface RedditCommentTreeStats {
  commentsReturned: number;
  moreChildrenRequests: number;
  truncated: boolean;
  warnings: string[];
  continuationsReturned: number;
}

export interface RedditCommentTreeResponse {
  source: 'reddit';
  fetchedAt: string;
  input: string;
  post: RedditPostDto;
  mode: 'comment' | 'children';
  rootCommentId?: string;
  parentId?: string;
  requestedChildren?: string[];
  comments: RedditCommentDto[];
  commentContinuations: RedditCommentContinuationDto[];
  stats: RedditCommentTreeStats;
  redditRateLimit: RedditRateLimit;
}

export interface RedditCoverageDto {
  reportedTotal: number;
  retrievedUnique: number;
  uniqueReturned: number;
  deleted: number;
  unavailable: number;
  unavailableBranches: number;
  knownRemaining: number;
  cursorsRemaining: boolean;
  continuationsRemaining: number;
  frontierRemaining: number;
  sortsSampled: RedditSort[];
  complete: boolean;
  snapshotComplete: boolean;
  stoppedReason?: 'rate_limit' | 'execution_budget' | 'snapshot_resource_limit' | 'upstream_retryable';
  retryAfterSeconds?: number;
}

export interface RedditCommentQueryRequest {
  post?: string;
  url?: string;
  redditUrl?: string;
  reddit_url?: string;
  threadUrl?: string;
  thread_url?: string;
  sort?: RedditSort;
  limit?: number;
  cursor?: string;
  includeBody?: boolean;
  bodyPreviewChars?: number;
  maxDepth?: number;
  parentId?: string;
  minScore?: number;
  minBodyLength?: number;
  includeDeleted?: boolean;
  maxBytes?: number;
  maxComments?: number;
  maxMoreChildrenRequests?: number;
}

export interface RedditCommentSkeletonDto {
  id: string;
  fullname: string;
  parentId: string;
  author: string;
  depth: number;
  score: number;
  replyCount: number | null;
  bodyLength: number;
  bodyPreview: string;
  createdUtc: number;
  isDeleted: boolean;
  body?: string;
}

export interface RedditCommentQueryPageInfo {
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  truncatedBy: 'limit' | 'maxBytes' | 'cursor' | null;
}

export interface RedditThreadSnapshotMetadataDto {
  version: number;
  id: string;
  postId: string;
  sort: RedditSort;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  sourceExhausted: boolean;
}

export interface RedditThreadOverviewRequest {
  post?: string;
  url?: string;
  redditUrl?: string;
  reddit_url?: string;
  threadUrl?: string;
  thread_url?: string;
  sort?: RedditSort;
  maxComments?: number;
}

export interface RedditThreadOverviewStats {
  topLevelComments: number;
  maxDepth: number;
  deletedCount: number;
  loadedSnapshotCommentCount: number;
}

export interface RedditThreadOverviewResponse {
  source: 'reddit';
  fetchedAt: string;
  input: string;
  post: RedditPostDto;
  stats: RedditThreadOverviewStats;
  availableSorts: RedditSort[];
  coverage: RedditCoverageDto;
  redditRateLimit: RedditRateLimit;
}

export interface RedditCommentQueryResponse {
  source: 'reddit';
  fetchedAt: string;
  input: string;
  post: RedditPostDto;
  comments: RedditCommentSkeletonDto[];
  snapshot: RedditThreadSnapshotMetadataDto;
  page: RedditCommentQueryPageInfo;
  coverage: RedditCoverageDto;
  warnings: string[];
  redditRateLimit: RedditRateLimit;
}

export interface RedditCommentsBatchRequest {
  post?: string;
  url?: string;
  redditUrl?: string;
  reddit_url?: string;
  threadUrl?: string;
  thread_url?: string;
  ids: string[] | string;
  fields?: string[] | string;
  maxBytes?: number;
}

export interface RedditCommentsBatchResponse {
  source: 'reddit';
  fetchedAt: string;
  input?: string;
  comments: Record<string, unknown>[];
  found: string[];
  missing: string[];
  unavailable: string[];
  truncatedBy: 'maxBytes' | null;
  redditRateLimit: RedditRateLimit;
}

export interface ParsedRedditPostInput {
  articleId: string;
  fullname: string;
}
