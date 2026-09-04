export interface YouTubeConfig {
  enabled: boolean;
  apiKey: string;
  storageAccountName: string;
  container: string;
  cursorSecret: string;
  cacheTtlMs: number;
}
export function readYouTubeConfig(env: NodeJS.ProcessEnv = process.env): YouTubeConfig {
  return {
    enabled: env['YOUTUBE_TRANSCRIPT_ENABLED'] === 'true',
    apiKey: env['SUPADATA_API_KEY']?.trim() ?? '',
    storageAccountName: env['YOUTUBE_TRANSCRIPT_STORAGE_ACCOUNT_NAME']?.trim() ?? '',
    container: env['YOUTUBE_TRANSCRIPT_CONTAINER']?.trim() || 'youtube-transcripts',
    cursorSecret: env['YOUTUBE_TRANSCRIPT_CURSOR_HMAC_KEY']?.trim() || 'local-test-only-youtube-cursor-key-32-bytes',
    cacheTtlMs: bounded(env['YOUTUBE_TRANSCRIPT_CACHE_TTL_SECONDS'], 86_400, 300, 172_800) * 1000,
  };
}
function bounded(raw: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}
