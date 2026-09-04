import { normalizeYouTubeVideoId } from './input.js';
import {
  decodeYouTubeCursor,
  encodeYouTubeCursor,
  newSnapshot,
  normalizeTranscript,
  youtubeCacheKey,
  type YouTubeSnapshot,
  type YouTubeSnapshotStore,
} from './snapshot.js';
import {
  YOUTUBE_LIMITS,
  YouTubeError,
  youtubeTranscriptInputSchema,
  youtubeTranscriptOutputSchema,
  type YouTubeTranscriptPage,
  type YouTubeTranscriptProvider,
} from './types.js';

export class YouTubeTranscriptService {
  constructor(
    private options: {
      provider: YouTubeTranscriptProvider;
      snapshots: YouTubeSnapshotStore;
      cursorSecret: string;
      cacheTtlMs: number;
      enabled: boolean;
      now?: () => number;
    },
  ) {}
  async getTranscript(raw: unknown, principalPseudonym: string): Promise<YouTubeTranscriptPage> {
    const parsed = youtubeTranscriptInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new YouTubeError(
        'invalid_arguments',
        400,
        'Use exactly one initial url/videoId, or a cursor-only continuation.',
      );
    const input = parsed.data;
    const now = (this.options.now ?? Date.now)();
    if (!this.options.enabled)
      throw new YouTubeError(
        'provider_not_configured',
        503,
        'YouTube transcripts are disabled until the provider is configured.',
      );
    if ('cursor' in input) {
      const decoded = decodeYouTubeCursor(input.cursor, principalPseudonym, this.options.cursorSecret, now);
      const snapshot = await this.options.snapshots.load(decoded.snapshotId);
      if (!snapshot)
        throw new YouTubeError('cursor_expired', 410, 'Snapshot is unavailable; start a new initial request.');
      return this.page(snapshot, decoded.offset, input.pageSize, principalPseudonym);
    }
    const videoId = normalizeYouTubeVideoId(input.url ?? input.videoId);
    const key = youtubeCacheKey(videoId, input.language);
    let snapshot = await this.options.snapshots.findByCacheKey(key, now);
    if (!snapshot)
      snapshot = await this.options.snapshots.withCacheLease(
        key,
        async () =>
          (await this.options.snapshots.findByCacheKey(key, now)) ?? this.fetch(videoId, input.language, key, now),
      );
    return this.page(snapshot, 0, input.pageSize, principalPseudonym);
  }
  private async fetch(
    videoId: string,
    requestedLanguage: string | undefined,
    cacheKey: string,
    now: number,
  ): Promise<YouTubeSnapshot> {
    const provider = await this.options.provider.fetchNativeTranscript({ videoId, language: requestedLanguage });
    const chunks = normalizeTranscript(provider.content);
    const totalCharacters = chunks.reduce((sum, c) => sum + c.text.length, 0);
    if (totalCharacters > YOUTUBE_LIMITS.transcriptChars)
      throw new YouTubeError('transcript_too_large', 413, 'Transcript exceeds the service resource limit.');
    const warnings: string[] = [];
    if (!chunks.length) warnings.push('No speech was present in the native-caption provider response.');
    if (requestedLanguage && provider.language && requestedLanguage !== provider.language)
      warnings.push('Requested language was unavailable; native captions were returned in another language.');
    const snapshot = newSnapshot({
      cacheKey,
      videoId,
      requestedLanguage,
      language: provider.language,
      availableLanguages: provider.availableLanguages,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.cacheTtlMs).toISOString(),
      chunks,
      totalCharacters,
      warnings,
    });
    await this.options.snapshots.save(snapshot);
    return snapshot;
  }
  private page(snapshot: YouTubeSnapshot, offset: number, requested: number, principal: string): YouTubeTranscriptPage {
    if (offset > snapshot.chunks.length)
      throw new YouTubeError('cursor_invalid', 400, 'Cursor offset is invalid; start a new initial request.');
    let end = Math.min(offset + requested, snapshot.chunks.length);
    let chunks = snapshot.chunks.slice(offset, end);
    while (chunks.length && Buffer.byteLength(JSON.stringify(chunks)) > YOUTUBE_LIMITS.pageBytes) {
      end--;
      chunks = snapshot.chunks.slice(offset, end);
    }
    if (!chunks.length && offset < snapshot.chunks.length)
      throw new YouTubeError('transcript_too_large', 413, 'A transcript page exceeds the response resource limit.');
    const hasMore = end < snapshot.chunks.length;
    return youtubeTranscriptOutputSchema.parse({
      source: 'youtube',
      fetchedAt: snapshot.fetchedAt,
      video: { id: snapshot.videoId },
      transcript: {
        requestedLanguage: snapshot.requestedLanguage,
        language: snapshot.language,
        availableLanguages: snapshot.availableLanguages,
        mode: 'native',
        empty: snapshot.chunks.length === 0,
        totalChunks: snapshot.chunks.length,
        totalCharacters: snapshot.totalCharacters,
      },
      chunks,
      page: {
        returned: chunks.length,
        returnedCharacters: chunks.reduce((s, c) => s + c.text.length, 0),
        hasMore,
        nextCursor: hasMore ? encodeYouTubeCursor(snapshot, end, principal, this.options.cursorSecret) : null,
      },
      coverage: {
        basis: 'provider_response',
        providerResponseFullyStored: true,
        storedChunks: snapshot.chunks.length,
        allStoredChunksReturned: !hasMore,
      },
      warnings: snapshot.warnings,
    });
  }
}
