# Request and provider resource limits

Application authorization is not a substitute for bounded resource use. Anonymous transports reject or cap work before allocating in proportion to caller input, and authenticated provider operations use server-owned budgets.

## MCP transport

- Outside explicit local development, every MCP request requires a syntactically valid bearer header before a POST body is read.
- MCP POST bodies are streamed through a 256 KiB byte limit. A declared or streamed overage returns HTTP 413 before JSON parsing or SDK transport dispatch.
- The gateway forwards the already bounded raw JSON text. It does not serialize a second complete copy of a parsed caller object.
- Host, forwarded-host/scheme, browser-origin, JWT, delegated-client, user, tenant, and per-tool permission checks remain mandatory.

## Reddit expansion

- `maxMoreChildrenRequests` defaults to zero and cannot exceed 10 for any REST or MCP call.
- Expansion uses an abortable 20-second deadline that also bounds provider retries and body reads, and it stops before Reddit's reported remaining quota would fall below the 10-request reserve.
- Only one Reddit expansion operation per authenticated principal may run concurrently in one Function worker. The key is hashed in memory and is always released in a `finally` boundary.
- Truncated results retain continuation handles for work that the request, time, or provider-quota budget deferred. Callers continue in later bounded requests instead of keeping one invocation alive.

The per-worker concurrency gate is defense in depth, not a distributed rate limiter. Azure scale-out can place the same principal on another worker, but the hard per-call request/time/provider budgets still apply on every instance. A shared distributed quota is future work only if monitoring shows the bounded calls can still exhaust provider or Function capacity.

## Delegated OAuth clients

Test and production require a non-empty `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` value in deployment validation, Bicep, startup runtime-safety validation, runtime-settings verification, and delegated authorization. An empty list denies delegated tokens; it never means allow all. App-only service tokens remain governed independently by the service object/client allowlists.
