import * as z from 'zod/v4';

export const YOUTUBE_LIMITS = {
  urlChars: 2048,
  cursorChars: 2048,
  pageChunks: 25,
  pageBytes: 128 * 1024,
  providerTimeoutMs: 20_000,
  providerBytes: 8 * 1024 * 1024,
  providerSegments: 100_000,
  segmentChars: 20_000,
  transcriptChars: 2_000_000,
  chunkChars: 2_000,
  targetChunkChars: 1_500,
  snapshotBytes: 12 * 1024 * 1024,
  retryAfterSeconds: 3600,
} as const;

export const youtubePageSizeSchema = z.number().int().min(1).max(YOUTUBE_LIMITS.pageChunks).default(20);
export const youtubeLanguageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/);
export const youtubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const youtubeUrlSchema = z.string().min(1).max(YOUTUBE_LIMITS.urlChars);
export const youtubeCursorSchema = z.string().min(20).max(YOUTUBE_LIMITS.cursorChars);
export const youtubeTranscriptInputSchema = z.union([
  z
    .object({
      url: youtubeUrlSchema,
      videoId: z.never().optional(),
      language: youtubeLanguageSchema.optional(),
      pageSize: youtubePageSizeSchema,
    })
    .strict(),
  z
    .object({
      videoId: youtubeVideoIdSchema,
      url: z.never().optional(),
      language: youtubeLanguageSchema.optional(),
      pageSize: youtubePageSizeSchema,
    })
    .strict(),
  z
    .object({
      cursor: youtubeCursorSchema,
      pageSize: youtubePageSizeSchema,
      url: z.never().optional(),
      videoId: z.never().optional(),
      language: z.never().optional(),
    })
    .strict(),
]);

export const youtubeChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().min(1).max(YOUTUBE_LIMITS.chunkChars),
});
export const youtubeTranscriptOutputSchema = z.object({
  source: z.literal('youtube'),
  fetchedAt: z.string().datetime(),
  video: z.object({ id: youtubeVideoIdSchema }),
  transcript: z.object({
    requestedLanguage: youtubeLanguageSchema.optional(),
    language: z.string().min(1).max(35).optional(),
    availableLanguages: z.array(z.string().min(1).max(35)).max(100),
    mode: z.literal('native'),
    empty: z.boolean(),
    totalChunks: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
  }),
  chunks: z.array(youtubeChunkSchema).max(YOUTUBE_LIMITS.pageChunks),
  page: z.object({
    returned: z.number().int().nonnegative(),
    returnedCharacters: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().max(YOUTUBE_LIMITS.cursorChars).nullable(),
  }),
  coverage: z.object({
    basis: z.literal('provider_response'),
    providerResponseFullyStored: z.literal(true),
    storedChunks: z.number().int().nonnegative(),
    allStoredChunksReturned: z.boolean(),
  }),
  warnings: z.array(z.string().max(240)).max(10),
});

export type YouTubeTranscriptInput = z.infer<typeof youtubeTranscriptInputSchema>;
export type YouTubeChunk = z.infer<typeof youtubeChunkSchema>;
export type YouTubeTranscriptPage = z.infer<typeof youtubeTranscriptOutputSchema>;
export interface ProviderTranscriptSegment {
  text: string;
  offsetMs: number;
  durationMs: number;
}
export interface ProviderTranscript {
  content: ProviderTranscriptSegment[];
  language?: string;
  availableLanguages: string[];
}
export interface YouTubeTranscriptProvider {
  fetchNativeTranscript(input: { videoId: string; language?: string }): Promise<ProviderTranscript>;
}

export class YouTubeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}
