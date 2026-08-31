export interface RedditConfig {
  clientId: string;
  secret: string;
  userAgent: string;
  storageAccountName: string;
  snapshotContainer: string;
  snapshotTtlMs: number;
  snapshotMaxComments: number;
  snapshotMaxBytes: number;
}

export function readRedditConfig(env: NodeJS.ProcessEnv = process.env): RedditConfig {
  return {
    clientId: normalize(env['REDDIT_CLIENT_ID']),
    secret: normalize(env['REDDIT_CLIENT_SECRET']),
    userAgent: normalize(env['REDDIT_USER_AGENT']),
    storageAccountName: normalize(env['REDDIT_STORAGE_ACCOUNT_NAME']),
    snapshotContainer: normalize(env['REDDIT_SNAPSHOT_CONTAINER']) || 'reddit-snapshots',
    snapshotTtlMs: positiveInteger(env['REDDIT_SNAPSHOT_TTL_SECONDS'], 86_400) * 1000,
    snapshotMaxComments: positiveInteger(env['REDDIT_SNAPSHOT_MAX_COMMENTS'], 100_000),
    snapshotMaxBytes: positiveInteger(env['REDDIT_SNAPSHOT_MAX_BYTES'], 96 * 1024 * 1024),
  };
}

export function validateRedditConfig(config: RedditConfig): void {
  if (!config.clientId || !config.secret || !config.userAgent) {
    throw new RedditConfigError('Reddit integration is not configured.');
  }
}

export class RedditConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedditConfigError';
  }
}

function normalize(value: string | undefined): string {
  return value?.trim() ?? '';
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
