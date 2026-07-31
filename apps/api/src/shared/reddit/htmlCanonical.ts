import { isSupportedRedditHost, parseDirectRedditPostInput } from './input.js';

export type RedditHtmlCanonicalSource = 'html_canonical' | 'html_metadata' | 'html_embedded_url';

export interface RedditHtmlCanonicalMatch {
  url: string;
  source: RedditHtmlCanonicalSource;
}

export function extractRedditCanonicalUrlFromHtml(html: string): string | null {
  return extractRedditCanonicalMatchFromHtml(html)?.url ?? null;
}

export function extractRedditCanonicalMatchFromHtml(html: string): RedditHtmlCanonicalMatch | null {
  if (!html) return null;

  const canonical = firstAttributeMatch(html, /<link\b[^>]*>/gi, 'rel', /(^|\s)canonical(\s|$)/i, 'href');
  const canonicalUrl = toSafeCanonicalUrl(canonical);
  if (canonicalUrl) return { url: canonicalUrl, source: 'html_canonical' };

  for (const selector of [
    { attr: 'property', value: /^og:url$/i },
    { attr: 'name', value: /^twitter:url$/i },
  ]) {
    const metadata = firstAttributeMatch(html, /<meta\b[^>]*>/gi, selector.attr, selector.value, 'content');
    const metadataUrl = toSafeCanonicalUrl(metadata);
    if (metadataUrl) return { url: metadataUrl, source: 'html_metadata' };
  }

  for (const scriptBody of jsonLdBodies(html)) {
    for (const candidate of jsonLdUrlCandidates(scriptBody)) {
      const jsonLdUrl = toSafeCanonicalUrl(candidate);
      if (jsonLdUrl) return { url: jsonLdUrl, source: 'html_metadata' };
    }
  }

  for (const candidate of embeddedUrlCandidates(html)) {
    const embeddedUrl = toSafeCanonicalUrl(candidate);
    if (embeddedUrl) return { url: embeddedUrl, source: 'html_embedded_url' };
  }

  return null;
}

function firstAttributeMatch(
  html: string,
  tagPattern: RegExp,
  selectorAttribute: string,
  selectorValue: RegExp,
  valueAttribute: string,
): string | null {
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0] ?? '';
    const selector = attributeValue(tag, selectorAttribute);
    if (!selector || !selectorValue.test(selector)) continue;
    const value = attributeValue(tag, valueAttribute);
    if (value) return value;
  }
  return null;
}

function attributeValue(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function* jsonLdBodies(html: string): Iterable<string> {
  const pattern =
    /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    yield decodeHtmlEntities(match[1] ?? '');
  }
}

function* jsonLdUrlCandidates(scriptBody: string): Iterable<string> {
  try {
    yield* walkJsonLd(JSON.parse(scriptBody));
  } catch {
    const pattern = /"(?:url|@id|mainEntityOfPage)"\s*:\s*"([^"]+)"/gi;
    for (const match of scriptBody.matchAll(pattern)) yield match[1] ?? '';
  }
}

function* walkJsonLd(value: unknown): Iterable<string> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkJsonLd(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['url', '@id', 'mainEntityOfPage']) {
    const candidate = record[key];
    if (typeof candidate === 'string') yield candidate;
    else yield* walkJsonLd(candidate);
  }
  for (const nested of Object.values(record)) yield* walkJsonLd(nested);
}

function* embeddedUrlCandidates(html: string): Iterable<string> {
  const decoded = decodeHtmlEntities(html).replace(/\\\//g, '/');
  const patterns = [
    /https:\/\/(?:www\.|old\.|new\.|np\.|m\.)?reddit\.com\/(?:r\/[^\s"'<>\\]+\/)?comments\/[a-z0-9][a-z0-9_]{1,12}[^\s"'<>\\]*/gi,
    /https:\/\/redd\.it\/[a-z0-9][a-z0-9_]{1,12}[^\s"'<>\\]*/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) yield match[0] ?? '';
  }
}

function toSafeCanonicalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const decoded = decodeHtmlEntities(value).replace(/\\\//g, '/').trim();
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !isSupportedRedditHost(url.hostname)) return null;
  url.search = '';
  url.hash = '';
  const clean = url.toString();
  try {
    const parsed = parseDirectRedditPostInput(clean);
    if (!parsed?.post_id) return null;
  } catch {
    return null;
  }
  return clean;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(Number.parseInt(code, 16)));
}

function safeCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
  return String.fromCodePoint(codePoint);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
