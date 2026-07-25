# Unofficial Bring! shopping-list integration

This private integration uses Bring!'s undocumented HTTP API. It can break without notice when Bring! changes endpoints, headers, authentication payloads, or list/item response shapes. The API catalogue returns only normalized list and item DTOs; it never returns account credentials, access/refresh tokens, raw authentication responses, upstream headers, or the session-blob location.

## Configuration and security model

GitHub repository **variables** provide non-secret runtime configuration:

- `BRING_BASE_URL` (normally `https://api.getbring.com/rest/`)
- `BRING_CLIENT_API_KEY` (the shared unofficial application/client key used by community clients; it is not a personal account credential)
- `BRING_COUNTRY`
- optional `BRING_DEFAULT_LIST_UUID`
- `BRING_SESSION_CACHE_ENABLED`
- `BRING_SESSION_CACHE_CONTAINER`
- `BRING_SESSION_CACHE_BLOB`

GitHub repository **secrets** `BRING_EMAIL` and `BRING_PASSWORD` contain the technical-account credentials. Deployment passes them as secure Bicep parameters. Azure Function settings also include `BRING_STORAGE_ACCOUNT_NAME`, which refers to the existing private deployment storage account. No new storage account, database, Redis service, plan, or always-on resource is created.

All HTTP routes and MCP tools use the existing API/MCP OAuth authorization. `GET /api/bring/lists` returns every own or shared list visible to the configured technical account, including a normalized `shared` marker. HTTP item routes require an explicit list UUID, so callers can select exactly which accessible list to read or edit. MCP and the service layer may omit it and use `BRING_DEFAULT_LIST_UUID`, the login-derived default, or the first available list. Add, complete, and remove calls accept 1–50 strictly validated items per batch.

The MCP gateway exposes `bring_list_lists`, `bring_get_items`, `bring_add_items`, `bring_complete_items`, and `bring_remove_items`. Creating, deleting, sharing, or changing membership of whole lists remains intentionally unsupported; this integration only edits items in lists already accessible to the technical account.

## Authentication and cache lifecycle

Each Function instance maintains one in-memory session and one shared authentication promise, preventing duplicate cold-start logins. Tokens are treated as expired 60 seconds early. On expiry the client attempts one refresh; an invalid refresh token clears the cache and causes one email/password login. A normal upstream `401` causes exactly one reauthentication and request retry.

When durable caching is enabled, `DefaultAzureCredential` and the Function App managed identity read/write a versioned JSON session in the configured private blob container. The blob contains tokens and user/list identifiers, but never the email or password. Blob read/write/clear failures generate sanitized warnings and operations fall back to normal login. Malformed or obsolete payloads are discarded. Last-write-wins is intentional for this low-volume private service.

Set `BRING_SESSION_CACHE_ENABLED=false` to disable durable caching. Process-local caching remains active.

## Password rotation and cache clearing

1. Replace the `BRING_PASSWORD` repository secret without displaying it.
2. Delete only the configured session blob (not the container or storage account) using an authorized Azure operator session, or allow an invalid refresh token to trigger sanitized cache clearing.
3. Run the staged deployment workflow and verify workflow, smoke, runtime-truth, and telemetry evidence. Never paste Function settings, tokens, credential values, storage credentials, or SAS URLs into logs or tickets.

## Testing and operations

Tests mock `fetch`, authentication, time, and session stores; unit/PR CI never calls Bring!. Run `npm run test:api`, `npm run ops:check-openapi-drift`, and `npm run ops:policy-guardrails`. Deployment verification should confirm the exact deployed commit through `/health`, then exercise protected routes only with the established authenticated smoke mechanism. A cache outage should not prevent operations; account-auth failures are dependency failures and do not invalidate the caller's API OAuth token.

Expected upstream failures include rate limiting, timeouts, account-auth rejection, server failures, plain-text/HTML errors, and response drift. The service maps these to sanitized repairable problems. Because the upstream API is unofficial, response drift remains the primary residual risk and rollback is the normal repository rollback workflow to a known-good full `main` SHA.
