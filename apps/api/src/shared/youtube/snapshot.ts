import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as z from 'zod/v4';
import { YOUTUBE_LIMITS, YouTubeError, youtubeChunkSchema, type YouTubeChunk } from './types.js';

export const YOUTUBE_SNAPSHOT_VERSION = 1;
const snapshotSchema = z
  .object({
    version: z.literal(YOUTUBE_SNAPSHOT_VERSION),
    snapshotId: z.string().uuid(),
    cacheKey: z.string().length(64),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    requestedLanguage: z.string().length(2).optional(),
    language: z.string().max(35).optional(),
    availableLanguages: z.array(z.string().max(35)).max(100),
    fetchedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    chunks: z.array(youtubeChunkSchema),
    totalCharacters: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(240)).max(10),
  })
  .strict();
export type YouTubeSnapshot = z.infer<typeof snapshotSchema>;

export interface YouTubeSnapshotStore {
  findByCacheKey(cacheKey: string, nowMs: number): Promise<YouTubeSnapshot | null>;
  load(snapshotId: string): Promise<YouTubeSnapshot | null>;
  save(snapshot: YouTubeSnapshot): Promise<void>;
  withCacheLease<T>(cacheKey: string, action: () => Promise<T>): Promise<T>;
}
export class InMemoryYouTubeSnapshotStore implements YouTubeSnapshotStore {
  private snapshots = new Map<string, YouTubeSnapshot>();
  private cache = new Map<string, string>();
  private locks = new Map<string, Promise<void>>();
  async findByCacheKey(key: string, now: number) {
    const id = this.cache.get(key);
    const value = id ? this.snapshots.get(id) : undefined;
    return value && Date.parse(value.expiresAt) > now ? structuredClone(value) : null;
  }
  async load(id: string) {
    const value = this.snapshots.get(id);
    return value ? structuredClone(value) : null;
  }
  async save(value: YouTubeSnapshot) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > YOUTUBE_LIMITS.snapshotBytes)
      throw new YouTubeError('transcript_too_large', 413, 'Transcript snapshot exceeds the resource limit.');
    snapshotSchema.parse(value);
    this.snapshots.set(value.snapshotId, structuredClone(value));
    this.cache.set(value.cacheKey, value.snapshotId);
  }
  async withCacheLease<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      prior.then(() => mine),
    );
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === mine) this.locks.delete(key);
    }
  }
}
export function parseYouTubeSnapshot(value: string): YouTubeSnapshot {
  const parsed = snapshotSchema.safeParse(JSON.parse(value));
  if (!parsed.success)
    throw new YouTubeError('upstream_invalid_response', 500, 'Stored transcript snapshot is invalid.');
  return parsed.data;
}
export function youtubeCacheKey(videoId: string, language?: string): string {
  return createHash('sha256')
    .update(`youtube|native|v${YOUTUBE_SNAPSHOT_VERSION}|${videoId}|${language ?? '-'}`)
    .digest('hex');
}
export function newSnapshot(args: Omit<YouTubeSnapshot, 'version' | 'snapshotId'>): YouTubeSnapshot {
  return { version: YOUTUBE_SNAPSHOT_VERSION, snapshotId: randomUUID(), ...args };
}

interface Cursor {
  v: number;
  op: 'youtube.transcript';
  sid: string;
  off: number;
  exp: number;
  sub: string;
  sig: string;
}
export function encodeYouTubeCursor(
  snapshot: YouTubeSnapshot,
  offset: number,
  principal: string,
  secret: string,
): string {
  const base = {
    v: 1,
    op: 'youtube.transcript' as const,
    sid: snapshot.snapshotId,
    off: offset,
    exp: Date.parse(snapshot.expiresAt),
    sub: principal,
  };
  const sig = createHmac('sha256', secret).update(JSON.stringify(base)).digest('base64url');
  return Buffer.from(JSON.stringify({ ...base, sig })).toString('base64url');
}
export function decodeYouTubeCursor(
  raw: string,
  principal: string,
  secret: string,
  nowMs: number,
): { snapshotId: string; offset: number } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw cursor('cursor_invalid');
  }
  if (!value || typeof value !== 'object') throw cursor('cursor_invalid');
  const c = value as Partial<Cursor>;
  if (
    c.v !== 1 ||
    c.op !== 'youtube.transcript' ||
    typeof c.sid !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(c.sid) ||
    !Number.isSafeInteger(c.off) ||
    (c.off ?? -1) < 0 ||
    typeof c.exp !== 'number' ||
    c.sub !== principal ||
    typeof c.sig !== 'string'
  )
    throw cursor('cursor_invalid');
  const base = { v: c.v, op: c.op, sid: c.sid, off: c.off, exp: c.exp, sub: c.sub };
  const expected = createHmac('sha256', secret).update(JSON.stringify(base)).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(c.sig, 'base64url');
  } catch {
    throw cursor('cursor_invalid');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw cursor('cursor_invalid');
  if (c.exp <= nowMs) throw cursor('cursor_expired');
  return { snapshotId: c.sid, offset: c.off! };
}
function cursor(code: string) {
  return new YouTubeError(
    code,
    code === 'cursor_expired' ? 410 : 400,
    code === 'cursor_expired'
      ? 'Cursor expired; start a new initial request.'
      : 'Cursor is invalid; start a new initial request.',
  );
}

export function normalizeTranscript(content: { text: string; offsetMs: number; durationMs: number }[]): YouTubeChunk[] {
  const result: YouTubeChunk[] = [];
  let texts: string[] = [];
  let chars = 0;
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!texts.length) return;
    result.push({ index: result.length, startMs: start, endMs: Math.max(start, end), text: texts.join(' ') });
    texts = [];
    chars = 0;
  };
  for (const segment of content) {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > YOUTUBE_LIMITS.chunkChars)
      throw new YouTubeError('transcript_too_large', 413, 'A transcript fragment exceeds the normalization limit.');
    const added = text.length + (texts.length ? 1 : 0);
    if (texts.length && chars + added > YOUTUBE_LIMITS.chunkChars) flush();
    if (!texts.length) start = segment.offsetMs;
    texts.push(text);
    chars += text.length + (texts.length > 1 ? 1 : 0);
    end = segment.offsetMs + segment.durationMs;
    if (chars >= YOUTUBE_LIMITS.targetChunkChars) flush();
  }
  flush();
  return result;
}
