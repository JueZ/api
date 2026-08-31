# Request and provider resource limits

Application authorization is not a substitute for bounded resource use. Anonymous transports reject or cap work before allocating in proportion to caller input, and authenticated provider operations use server-owned budgets.

## Authenticated provider JSON

- Every Reddit and WLH POST route authenticates and authorizes the operation before reading its body.
- Bodies are streamed through one shared 64 KiB limit. A declared or streamed overage returns deterministic HTTP 413 `application/problem+json`; malformed bounded JSON returns the existing deterministic HTTP 400 contract.
- Rejected bodies never invoke Reddit or WLH providers and never enter optional model-assisted diagnostics.
- Reddit OAuth/provider response text is untrusted. Public errors use stable server-owned messages; internal fetch metadata is bounded to normalized IDs, statuses, media types, and query/fragment-free Reddit URLs.
- Fetch telemetry omits raw caller input and records only normalized identifiers plus route-normalized allowlisted Reddit URLs. The documented successful `input` field remains caller-supplied response data and is not copied into logs or error diagnostics.

## MCP transport

- Outside explicit local development, every MCP request requires a syntactically valid bearer header before a POST body is read.
- MCP POST bodies are streamed through a 256 KiB byte limit. A declared or streamed overage returns HTTP 413 before JSON parsing or SDK transport dispatch.
- The gateway forwards the already bounded raw JSON text. It does not serialize a second complete copy of a parsed caller object.
- In deployed environments, `MCP_RESOURCE_ORIGIN` is one non-localhost, non-IP HTTPS origin. The request URL authority, Host, optional forwarded host/scheme, and exact browser Origin must agree with configured trust; comma-separated or otherwise ambiguous header values are rejected.
- JWT, delegated-client, user, tenant, and per-tool permission checks remain mandatory. Only explicit loopback HTTP/HTTPS requests retain the local-development origin exception.

## Reddit expansion

- `maxMoreChildrenRequests` cannot exceed 10 for any REST or MCP call. Ordinary Reddit reads default to zero expansion work; the explicit exhaustive REST/MCP path defaults to five serial frontier expansions per invocation.
- Expansion uses an abortable 20-second deadline that also bounds provider retries and body reads, and it stops before Reddit's reported remaining quota would fall below the 10-request reserve.
- Only one Reddit expansion operation per authenticated principal may run concurrently in one Function worker. The key is hashed in memory and is always released in a `finally` boundary. Exhaustive cursor continuations additionally acquire a short optimistic-concurrency lease in the shared snapshot so separate Function instances cannot expand the same frontier concurrently.
- Ordinary thread and overview calls remain bounded snapshots. Exhaustive retrieval is explicit through `POST /api/reddit/thread/comments` and MCP `reddit_get_thread_page`.
- The exhaustive path checkpoints normalized comments, deduplication state, and its server-owned traversal frontier in a private Blob after each bounded invocation. Opaque signed cursors reference the snapshot and page offset; callers never carry Reddit child-ID queues.
- Each exhaustive invocation still permits at most ten serial `/api/morechildren` or continue-thread requests, uses the same deadline and provider-quota reserve, and returns a resumable cursor rather than sleeping through a rate reset.
- A high configurable snapshot resource cap protects Function memory and storage. Reaching it is reported as incomplete and never as exhausted traversal.

The per-worker concurrency gate is defense in depth, not a distributed rate limiter. Azure scale-out can place the same principal on another worker, but the hard per-call request/time/provider budgets still apply on every instance. A shared distributed quota is future work only if monitoring shows the bounded calls can still exhaust provider or Function capacity.

## Delegated OAuth clients

Test and production require a non-empty `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` value in deployment validation, Bicep, startup runtime-safety validation, runtime-settings verification, and delegated authorization. An empty list denies delegated tokens; it never means allow all. App-only service tokens remain governed independently by the service object/client allowlists.
