import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RedditCommentDto, RedditPostDto, RedditRateLimit, RedditSort } from './types.js';

export const REDDIT_THREAD_SNAPSHOT_VERSION = 2;
export const REDDIT_THREAD_CURSOR_VERSION = 2;
export const DEFAULT_REDDIT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REDDIT_SNAPSHOT_MAX_COMMENTS = 100_000;
export const DEFAULT_REDDIT_SNAPSHOT_MAX_BYTES = 96 * 1024 * 1024;

export interface RedditSnapshotQuery {
  maxDepth?: number;
  parentId?: string;
  minScore?: number;
  minBodyLength?: number;
  includeDeleted: boolean;
}

export interface RedditMoreChildrenWork {
  kind: 'more_children';
  key: string;
  parentId: string;
  depth: number;
  children: string[];
  count: number;
}

export interface RedditContinueThreadWork {
  kind: 'continue_thread';
  key: string;
  parentId: string;
  depth: number;
  count: number;
}

export type RedditTraversalWork = RedditMoreChildrenWork | RedditContinueThreadWork;

export interface RedditThreadSnapshot {
  version: typeof REDDIT_THREAD_SNAPSHOT_VERSION;
  snapshotId: string;
  cursorSecret: string;
  input: string;
  postId: string;
  sort: RedditSort;
  activeSort: RedditSort;
  sortPlan: RedditSort[];
  sortIndex: number;
  sortsSampled: RedditSort[];
  post: RedditPostDto;
  comments: RedditCommentDto[];
  seenCommentIds: string[];
  frontier: RedditTraversalWork[];
  processedFrontierKeys: string[];
  processedChildIds: string[];
  unavailableCommentIds: string[];
  unavailableBranches: number;
  reportedTotal: number;
  query: RedditSnapshotQuery;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  sourceExhausted: boolean;
  resourceLimitReached: boolean;
  warnings: string[];
  redditRateLimit: RedditRateLimit;
  retryAfterSeconds?: number;
  crawlLease?: {
    id: string;
    expiresAt: string;
  };
}

export interface StoredRedditThreadSnapshot {
  snapshot: RedditThreadSnapshot;
  etag: string;
}

export interface RedditThreadSnapshotStore {
  load(snapshotId: string): Promise<StoredRedditThreadSnapshot | null>;
  create(snapshot: RedditThreadSnapshot): Promise<StoredRedditThreadSnapshot>;
  replace(snapshot: RedditThreadSnapshot, expectedEtag: string): Promise<StoredRedditThreadSnapshot>;
}

export class RedditSnapshotConflictError extends Error {
  constructor(message = 'Reddit thread snapshot changed concurrently.') {
    super(message);
    this.name = 'RedditSnapshotConflictError';
  }
}

export class RedditSnapshotNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'REDDIT_SNAPSHOT_NOT_FOUND';

  constructor() {
    super('The Reddit thread snapshot does not exist or is no longer available. Start a new exhaustive crawl.');
    this.name = 'RedditSnapshotNotFoundError';
  }
}

export class RedditSnapshotExpiredError extends Error {
  readonly status = 410;
  readonly code = 'REDDIT_SNAPSHOT_EXPIRED';

  constructor() {
    super('The Reddit thread snapshot expired. Start a new exhaustive crawl.');
    this.name = 'RedditSnapshotExpiredError';
  }
}

export class RedditCursorError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code: 'INVALID_REDDIT_CURSOR' | 'REDDIT_CURSOR_VERSION_MISMATCH' = 'INVALID_REDDIT_CURSOR',
  ) {
    super(message);
    this.name = 'RedditCursorError';
  }
}

export class InMemoryRedditThreadSnapshotStore implements RedditThreadSnapshotStore {
  private readonly snapshots = new Map<string, StoredRedditThreadSnapshot>();
  private revision = 0;

  async load(snapshotId: string): Promise<StoredRedditThreadSnapshot | null> {
    const stored = this.snapshots.get(snapshotId);
    return stored ? cloneStoredSnapshot(stored) : null;
  }

  async create(snapshot: RedditThreadSnapshot): Promise<StoredRedditThreadSnapshot> {
    if (this.snapshots.has(snapshot.snapshotId)) throw new RedditSnapshotConflictError();
    const stored = { snapshot: structuredClone(snapshot), etag: this.nextEtag() };
    this.snapshots.set(snapshot.snapshotId, stored);
    return cloneStoredSnapshot(stored);
  }

  async replace(snapshot: RedditThreadSnapshot, expectedEtag: string): Promise<StoredRedditThreadSnapshot> {
    const current = this.snapshots.get(snapshot.snapshotId);
    if (!current || current.etag !== expectedEtag) throw new RedditSnapshotConflictError();
    const stored = { snapshot: structuredClone(snapshot), etag: this.nextEtag() };
    this.snapshots.set(snapshot.snapshotId, stored);
    return cloneStoredSnapshot(stored);
  }

  private nextEtag(): string {
    this.revision += 1;
    return `memory-${this.revision}`;
  }
}

export function createRedditThreadSnapshot(args: {
  input: string;
  postId: string;
  sort: RedditSort;
  post: RedditPostDto;
  comments: RedditCommentDto[];
  frontier: RedditTraversalWork[];
  query: RedditSnapshotQuery;
  rateLimit: RedditRateLimit;
  nowMs: number;
  ttlMs: number;
}): RedditThreadSnapshot {
  const now = new Date(args.nowMs).toISOString();
  const sortPlan = redditCoverageSortPlan(args.sort);
  return {
    version: REDDIT_THREAD_SNAPSHOT_VERSION,
    snapshotId: randomUUID(),
    cursorSecret: randomBytes(32).toString('base64url'),
    input: args.input,
    postId: args.postId,
    sort: args.sort,
    activeSort: args.sort,
    sortPlan,
    sortIndex: 0,
    sortsSampled: [args.sort],
    post: args.post,
    comments: args.comments,
    seenCommentIds: args.comments.map((comment) => comment.id.toLowerCase()),
    frontier: args.frontier,
    processedFrontierKeys: [],
    processedChildIds: [],
    unavailableCommentIds: [],
    unavailableBranches: 0,
    reportedTotal: args.post.numComments,
    query: args.query,
    startedAt: now,
    updatedAt: now,
    expiresAt: new Date(args.nowMs + args.ttlMs).toISOString(),
    sourceExhausted: false,
    resourceLimitReached: false,
    warnings: [],
    redditRateLimit: args.rateLimit,
  };
}

export function redditCoverageSortPlan(requested: RedditSort): RedditSort[] {
  // Every Reddit listing is bounded and ordered differently. Even a view that adds no
  // comments can expose different MoreChildren work, so exhaust each supported view.
  // qa is last because it is usually highly overlapping, but it is still a distinct
  // provider discovery view and cannot safely be assumed redundant.
  return [...new Set<RedditSort>([requested, 'old', 'new', 'controversial', 'top', 'confidence', 'qa'])];
}

interface RedditCursorPayload {
  version: number;
  snapshotId: string;
  offset: number;
  signature: string;
}

export function encodeRedditSnapshotCursor(snapshot: RedditThreadSnapshot, offset: number): string {
  const unsigned = cursorSigningInput(REDDIT_THREAD_CURSOR_VERSION, snapshot.snapshotId, offset);
  const signature = createHmac('sha256', snapshot.cursorSecret).update(unsigned).digest('base64url');
  const payload: RedditCursorPayload = {
    version: REDDIT_THREAD_CURSOR_VERSION,
    snapshotId: snapshot.snapshotId,
    offset,
    signature,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeRedditSnapshotCursor(input: unknown): Omit<RedditCursorPayload, 'signature'> & {
  signature: string;
} {
  if (typeof input !== 'string' || input.length < 20 || input.length > 1024) {
    throw new RedditCursorError('cursor must be the opaque cursor returned by the previous Reddit page.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
  } catch {
    throw new RedditCursorError('cursor is malformed.');
  }
  if (!isRecord(parsed) || parsed['version'] !== REDDIT_THREAD_CURSOR_VERSION) {
    if (isRecord(parsed) && typeof parsed['version'] === 'number') {
      throw new RedditCursorError(
        'cursor version is not supported. Start a new exhaustive crawl.',
        'REDDIT_CURSOR_VERSION_MISMATCH',
      );
    }
    throw new RedditCursorError('cursor is malformed.');
  }
  const snapshotId = parsed['snapshotId'];
  const offset = parsed['offset'];
  const signature = parsed['signature'];
  if (
    typeof snapshotId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(snapshotId) ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof signature !== 'string' ||
    signature.length < 20 ||
    signature.length > 100
  ) {
    throw new RedditCursorError('cursor is malformed.');
  }
  return { version: REDDIT_THREAD_CURSOR_VERSION, snapshotId, offset, signature };
}

export function verifyRedditSnapshotCursor(
  cursor: ReturnType<typeof decodeRedditSnapshotCursor>,
  snapshot: RedditThreadSnapshot,
): void {
  if (cursor.snapshotId !== snapshot.snapshotId) throw new RedditCursorError('cursor does not match the snapshot.');
  const expected = createHmac('sha256', snapshot.cursorSecret)
    .update(cursorSigningInput(cursor.version, cursor.snapshotId, cursor.offset))
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(cursor.signature, 'base64url');
  } catch {
    throw new RedditCursorError('cursor signature is invalid.');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new RedditCursorError('cursor signature is invalid.');
  }
}

export function parseRedditThreadSnapshot(text: string): RedditThreadSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Stored Reddit thread snapshot is not valid JSON.');
  }
  if (
    !isRecord(value) ||
    value['version'] !== REDDIT_THREAD_SNAPSHOT_VERSION ||
    typeof value['snapshotId'] !== 'string' ||
    typeof value['cursorSecret'] !== 'string' ||
    typeof value['postId'] !== 'string' ||
    typeof value['sort'] !== 'string' ||
    typeof value['activeSort'] !== 'string' ||
    !Array.isArray(value['sortPlan']) ||
    typeof value['sortIndex'] !== 'number' ||
    !Array.isArray(value['sortsSampled']) ||
    !Array.isArray(value['comments']) ||
    !Array.isArray(value['frontier']) ||
    !Array.isArray(value['seenCommentIds']) ||
    !Array.isArray(value['processedFrontierKeys']) ||
    typeof value['expiresAt'] !== 'string'
  ) {
    throw new RedditCursorError(
      'Stored Reddit thread snapshot version is not supported. Start a new exhaustive crawl.',
      'REDDIT_CURSOR_VERSION_MISMATCH',
    );
  }
  return value as unknown as RedditThreadSnapshot;
}

function cursorSigningInput(version: number, snapshotId: string, offset: number): string {
  return `${version}\u0000${snapshotId}\u0000${offset}`;
}

function cloneStoredSnapshot(stored: StoredRedditThreadSnapshot): StoredRedditThreadSnapshot {
  return { snapshot: structuredClone(stored.snapshot), etag: stored.etag };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
