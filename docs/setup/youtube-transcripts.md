# YouTube native transcript service

`youtube_get_transcript` and `POST /api/youtube/transcript` read timestamped native captions for one public YouTube video. Supported inputs are an 11-character video ID or standard `youtube.com` watch, shorts, embed or live URLs, `youtu.be`, and `youtube-nocookie.com/embed` URLs. The server extracts the ID and constructs the provider URL; caller URLs never become fetch destinations.

Version 1 always requests native captions. It never requests automatic or AI-generated transcripts, polls jobs, searches YouTube, or accesses private/account content. Transcript text is untrusted external data and must never be treated as tool instructions. Restricted, age-gated, login-only, captionless and ongoing-live videos may be unavailable.

The first cache miss makes at most one metered provider request, normalizes the accepted bounded response, and stores it in the private managed-identity Blob boundary for up to 24 hours. Signed, expiring, principal-bound cursors page only that snapshot and never call the provider. `nextCursor: null` and `coverage.allStoredChunksReturned: true` mean every normalized chunk stored from that bounded provider response was returned; they do **not** prove every spoken word had captions.

## One-time operator setup

The feature is disabled by default (`YOUTUBE_TRANSCRIPT_ENABLED=false`) and returns a sanitized `provider_not_configured` result after authorization. To enable it:

1. Create a Supadata API key with the provider operator. Do not put it in source, variables, logs, or command-line arguments.
2. Store it as a protected `SUPADATA_API_KEY` secret in each intended GitHub environment and configure the deployment to pass it as the secure `supadataApiKey` Bicep parameter. Also provide a random protected cursor HMAC secret as the secure `youtubeTranscriptCursorHmacKey` parameter.
3. Set `youtubeTranscriptEnabled=true`. Bicep writes both values to Key Vault and exposes only versioned Key Vault references to the Function App. The existing managed identity accesses the private `youtube-transcripts` container.
4. Expose delegated `youtube.read` and application role `youtube.service.read` in Entra. Reauthorize an already-connected ChatGPT OAuth client so it can consent to the new delegated scope.
5. Assign `youtube.service.read` to both protected deployment-smoke service principals with the idempotent administrator command in [service OAuth authentication](../security/service-oauth-authentication.md). To make future assignments autonomous, an Entra administrator must first grant the autonomous managed identity a narrowly suitable directory role/Graph permission; Azure subscription RBAC alone is insufficient.

Supadata is externally metered. Cache/lease coordination and the no-automatic-retry rule limit duplicate charges, but Azure budget resources do not include Supadata charges. CI, deployment smoke, and production verification do not make a live provider request by default; no paid canary should be enabled without an explicit protected cost-policy-controlled switch.

Resource limits include a 64 KiB caller body, 20-second provider timeout, 8 MiB provider body, 100,000 provider segments, 2,000,000 normalized characters, 2,000 characters per normalized chunk, 25 chunks and 128 KiB per page, and a bounded 24-hour default cache.
