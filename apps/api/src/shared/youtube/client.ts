import * as z from 'zod/v4';
import { YOUTUBE_LIMITS, YouTubeError, type ProviderTranscript, type YouTubeTranscriptProvider } from './types.js';

const ENDPOINT = 'https://api.supadata.ai/v1/transcript';
const tag = z
  .string()
  .min(1)
  .max(35)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
const responseSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            text: z.string().max(YOUTUBE_LIMITS.segmentChars),
            offset: z.number().finite().nonnegative(),
            duration: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(YOUTUBE_LIMITS.providerSegments),
    lang: tag.optional(),
    availableLangs: z.array(tag).max(100).optional(),
  })
  .strict();

export class SupadataYouTubeTranscriptProvider implements YouTubeTranscriptProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async fetchNativeTranscript(input: { videoId: string; language?: string }): Promise<ProviderTranscript> {
    const url = new URL(ENDPOINT);
    url.searchParams.set('url', `https://www.youtube.com/watch?v=${input.videoId}`);
    url.searchParams.set('text', 'false');
    url.searchParams.set('mode', 'native');
    url.searchParams.set('chunkSize', String(YOUTUBE_LIMITS.targetChunkChars));
    if (input.language) url.searchParams.set('lang', input.language);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), YOUTUBE_LIMITS.providerTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      throw new YouTubeError(
        'upstream_timeout',
        504,
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Transcript provider timed out.'
          : 'Transcript provider is unavailable.',
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) throw mapStatus(response);
    const bytes = new Uint8Array(await boundedBody(response, YOUTUBE_LIMITS.providerBytes));
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new YouTubeError('upstream_invalid_response', 502, 'Transcript provider returned an invalid response.');
    }
    const result = responseSchema.safeParse(parsed);
    if (!result.success)
      throw new YouTubeError('upstream_invalid_response', 502, 'Transcript provider returned an invalid response.');
    let total = 0;
    const content = result.data.content.map((part) => {
      total += part.text.length;
      if (total > YOUTUBE_LIMITS.transcriptChars)
        throw new YouTubeError('transcript_too_large', 413, 'Transcript exceeds the service resource limit.');
      return { text: part.text, offsetMs: Math.round(part.offset), durationMs: Math.round(part.duration) };
    });
    return { content, language: result.data.lang, availableLanguages: result.data.availableLangs ?? [] };
  }
}

function mapStatus(response: Response): YouTubeError {
  if (response.status === 206)
    return new YouTubeError('transcript_unavailable', 422, 'Native captions are unavailable for this video.');
  if (response.status === 404) return new YouTubeError('not_found', 404, 'The video or transcript was not found.');
  if (response.status === 401 || response.status === 403)
    return new YouTubeError('provider_not_configured', 503, 'Transcript provider is not configured.');
  if (response.status === 429) {
    const value = Number(response.headers.get('retry-after'));
    return new YouTubeError(
      'upstream_rate_limited',
      503,
      'Transcript provider is rate limited.',
      Number.isSafeInteger(value) && value >= 0 ? Math.min(value, YOUTUBE_LIMITS.retryAfterSeconds) : undefined,
    );
  }
  if (response.status === 202)
    return new YouTubeError(
      'upstream_invalid_response',
      502,
      'Native transcript provider returned an unsupported asynchronous state.',
    );
  if (response.status === 400)
    return new YouTubeError('transcript_unavailable', 422, 'Native captions are unavailable for this request.');
  return new YouTubeError('upstream_unavailable', 503, 'Transcript provider is unavailable.');
}
async function boundedBody(response: Response, max: number): Promise<ArrayBuffer> {
  if (Number(response.headers.get('content-length')) > max)
    throw new YouTubeError('transcript_too_large', 413, 'Transcript provider response exceeds the resource limit.');
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new YouTubeError('transcript_too_large', 413, 'Transcript provider response exceeds the resource limit.');
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    throw new YouTubeError('upstream_invalid_response', 502, 'Transcript provider response ended unexpectedly.');
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined.buffer;
}
