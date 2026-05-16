export type RedditSort = 'confidence' | 'top' | 'new' | 'controversial' | 'old' | 'qa';

export interface RedditThreadRequest {
  post?: string;
  url?: string;
  redditUrl?: string;
  reddit_url?: string;
  threadUrl?: string;
  thread_url?: string;
  sort?: RedditSort;
  maxComments?: number;
  maxMoreChildrenRequests?: number;
}

export interface RedditPostDto {
  id: string;
  fullname: string;
  subreddit: string;
  title: string;
  author: string;
  selftext: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdUtc: number;
  over18: boolean;
  locked: boolean;
  archived: boolean;
}

export interface RedditCommentDto {
  id: string;
  fullname: string;
  parentId: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  depth: number;
  replies: RedditCommentDto[];
}

export interface RedditThreadStats {
  commentsReturned: number;
  moreChildrenRequests: number;
  truncated: boolean;
  warnings: string[];
}

export interface RedditRateLimit {
  used: string | null;
  remaining: string | null;
  resetSeconds: string | null;
}

export interface RedditThreadResponse {
  source: 'reddit';
  fetchedAt: string;
  input: string;
  post: RedditPostDto;
  comments: RedditCommentDto[];
  stats: RedditThreadStats;
  redditRateLimit: RedditRateLimit;
}

export interface ParsedRedditPostInput {
  articleId: string;
  fullname: string;
}
