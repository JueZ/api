import { assertRuntimeSafety } from './shared/config/runtime.js';

assertRuntimeSafety();

await import('./functions/health.js');
await import('./functions/hello.js');
await import('./functions/redditThread.js');
await import('./functions/redditCommentTree.js');
await import('./functions/redditCommentsBatch.js');
await import('./functions/redditThreadComments.js');
await import('./functions/redditThreadOverview.js');
await import('./functions/youtubeTranscript.js');
await import('./functions/wlhCategories.js');
await import('./functions/wlhSearch.js');
await import('./functions/wlhOffer.js');
await import('./functions/bring.js');
await import('./functions/mcp.js');
await import('./functions/oauthProtectedResource.js');
