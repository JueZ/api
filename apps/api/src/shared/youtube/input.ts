import { YouTubeError } from './types.js';

const ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

export function normalizeYouTubeVideoId(raw: string): string {
  if (ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('unsupported_url', 'Provide a supported public YouTube video URL or video ID.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw invalid('unsupported_url', 'The YouTube URL is not supported.');
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (WATCH_HOSTS.has(host) && url.pathname === '/watch') {
    const values = url.searchParams.getAll('v');
    if (values.length !== 1) throw invalid('invalid_arguments', 'The URL must contain exactly one video identifier.');
    candidate = values[0] ?? null;
  } else if (host === 'youtu.be') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 1) candidate = parts[0] ?? null;
  } else if (
    (host === 'www.youtube.com' || host === 'youtube.com') &&
    /^\/(shorts|embed|live)\/[^/]+\/?$/.test(url.pathname)
  ) {
    candidate = url.pathname.split('/')[2] ?? null;
  } else if (host === 'www.youtube-nocookie.com' && /^\/embed\/[^/]+\/?$/.test(url.pathname)) {
    candidate = url.pathname.split('/')[2] ?? null;
  }
  if (!candidate || !ID.test(candidate))
    throw invalid('unsupported_url', 'The URL does not identify one supported public YouTube video.');
  const conflicting = url.searchParams.getAll('v').filter((value) => value !== candidate);
  if (conflicting.length) throw invalid('invalid_arguments', 'The URL contains conflicting video identifiers.');
  return candidate;
}

function invalid(code: string, message: string): YouTubeError {
  return new YouTubeError(code, 400, message);
}
