#!/usr/bin/env node
import { RedditOAuthClient } from '../apps/api/dist/shared/reddit/client.js';
import { readRedditConfig } from '../apps/api/dist/shared/reddit/config.js';
import { resolveRedditShareUrl } from '../apps/api/dist/shared/reddit/shareResolver.js';

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const inputUrl = args.find((arg) => arg !== '--debug');
if (!inputUrl) {
  console.error(
    'Usage: npm run ops:resolve-reddit-share -- [--debug] "https://www.reddit.com/r/<subreddit>/s/<token>"',
  );
  process.exit(2);
}

const config = readRedditConfig();
if (!config.userAgent) {
  config.userAgent = 'script:juez-api-share-resolver:v0.1.0 (by u/operator)';
}
const client = new RedditOAuthClient(config);

try {
  const resolution = await resolveRedditShareUrl(inputUrl, {
    resolveRedirect: (url) => client.resolveRedditUrl(url),
  });
  console.log(JSON.stringify(safeOutput(resolution, debug), null, 2));
  process.exit(resolution.status === 'resolved' ? 0 : 1);
} catch (error) {
  console.log(
    JSON.stringify(
      {
        status: 'error',
        originalUrl: inputUrl,
        safeReason: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

function safeOutput(resolution, debug) {
  const output = {
    status: resolution.status,
    source: resolution.source,
    originalUrl: resolution.originalUrl,
    finalUrl: resolution.finalUrl,
    cleanCanonicalUrl: resolution.cleanCanonicalUrl,
    postId: resolution.postId,
    subreddit: resolution.subreddit,
    commentId: resolution.commentId,
    httpStatus: resolution.httpStatus,
    contentType: resolution.contentType,
    redirectChain: resolution.redirectChain,
    safeReason: resolution.safeReason,
    retryable: resolution.retryable,
  };
  if (debug) {
    output.debug = {
      extractorMatched: resolution.source?.startsWith('html_') ? resolution.source : undefined,
      redirectCount: Math.max(0, (resolution.redirectChain?.length ?? 1) - 1),
    };
  }
  return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined));
}
