export interface RedditConfig {
  clientId: string;
  secret: string;
  userAgent: string;
}

export function readRedditConfig(env: NodeJS.ProcessEnv = process.env): RedditConfig {
  return {
    clientId: normalize(env['REDDIT_CLIENT_ID']),
    secret: normalize(env['REDDIT_CLIENT_SECRET']),
    userAgent: normalize(env['REDDIT_USER_AGENT']),
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
