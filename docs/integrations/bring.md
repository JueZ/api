# Unofficial Bring! shopping-list integration

Bring! has no supported public API for this use case. The integration therefore treats every provider response as untrusted and version-unstable. Provider credentials, tokens, headers, raw account data, item names from mutation results, and storage locations are never returned or logged.

## Safety model

- The existing Bring technical account remains in use.
- `test` may read the same account but cannot add, complete, or remove items.
- Production reads require `BRING_READABLE_LIST_UUIDS`.
- Production writes require an explicit UUID in `BRING_WRITABLE_LIST_UUIDS`.
- Shared-list writes require the same UUID in the additional `BRING_WRITABLE_SHARED_LIST_UUIDS` allowlist. Empty denies every shared-list write; unlisted lists are always denied.
- Whole-list creation, deletion, sharing, membership, and notification operations are unsupported.
- `BRING_EXPECTED_ACCOUNT_FINGERPRINT` binds the deployment to the intended technical account without storing its email in state or audit records.

The granular permissions are `bring.read`, `bring.write`, `bring.complete`, and `bring.remove`. Service tokens may read and add when explicitly granted but cannot complete or remove. Destructive operations require a delegated user token.

## Mutation contract

Adds use:

```text
POST /api/bring/lists/{listUuid}/items
{ operationId, expectedListVersion?, items }
```

`operationId` is a caller-generated UUID. Durable state is retained for 30 days. An identical retry returns the recorded result; reusing the UUID with a different action, list, version, item payload, or tenant-bound principal fails. If the upstream result is ambiguous, state becomes `outcome_unknown` and automatic replay is permanently blocked. Read the list before deciding on a new operation.

Complete and remove use two phases:

```text
POST /api/bring/lists/{listUuid}/mutations/prepare
{ operationId, expectedListVersion?, operation, items }

POST /api/bring/lists/{listUuid}/mutations/apply
{ operationId, confirmationToken }
```

Prepare validates policy, input, current list membership, sharing status, and optional optimistic concurrency without calling the mutation endpoint. It returns an HMAC list pseudonym, item count, expiry, and a five-minute v2 token bound to the operation ID, action, list, payload fingerprint, nonce, and a canonical principal identity consisting of token type, tenant, delegated client, and tagged object-ID-or-subject identity. Apply authorizes the action from the current durable record and verifies the complete signed binding before one upstream call. A successful result may be replayed through the 30-day window only with the exact consumed token; this result replay does not call Bring again.

Confirmation tokens and durable mutation records created before integrity format v2 are intentionally non-replayable because their principal pseudonyms did not bind a tenant. They remain retained for audit/lifecycle policy and are never rewritten or decrypted as a compatibility fallback. On a legacy conflict, re-read the list and inspect its current state; use a fresh operation ID only when an operator deliberately determines that another mutation is still required. Never resubmit a destructive operation automatically.

MCP exposes `bring_list_lists`, `bring_get_items`, `bring_add_item`, `bring_remove_item`, and `bring_complete_item`. For a safe removal, call `bring_get_items(listUuid)`, select the exact current item UUID and name, generate a fresh `operationId`, then call `bring_remove_item` with the explicit `listUuid`, returned `expectedListVersion`, and item. The first call prepares the destructive mutation; repeat the same request with its short-lived `confirmationToken` to apply it. Completion uses the same flow. Typo correction should use remove-old plus add-new rather than an in-place rename because Bring clients can retain stale names.

The destructive MCP tools preserve the authenticated REST pipeline's delegated-user permissions, writable-list and shared-list allowlists, durable replay record, optimistic concurrency, and principal/payload-bound confirmation. They never select by name alone: the UUID must identify an active item and its current name must match.

## Storage, encryption, and audit

The Function managed identity accesses separate private blob containers for:

- session cache;
- encrypted durable mutation state;
- append-only audit events.

Prepared item payloads use AES-256-GCM with `BRING_MUTATION_ENCRYPTION_KEY`; v2 authenticated data binds the ciphertext to immutable record metadata, and apply recomputes the action-aware payload fingerprint after decryption. Confirmation, list, principal, nonce, and consumed-token HMACs use separate canonical domains under `BRING_CONFIRMATION_HMAC_KEY`. Durable state stores only the nonce digest while prepared and a one-way full-token HMAC after consumption—never the token or nonce. Key material and provider credentials are Key Vault references in Function settings. Audit events contain operation, state, item count, pseudonyms, correlation ID, timestamp, and deployed commit—not item text. Lifecycle policy retains audit data for 365 days and mutation/replay state for at least 30 days.

The provider wire adapter remains isolated in `shared/bring/client.ts`. It maps normalized operations to the observed private `{ changes, sender }` request, accepts valid empty `204` responses, and streams provider responses through a fixed byte budget. Every write rechecks current list membership even when a list summary already says the list is shared. Mutation endpoints authenticate before reading their bounded request bodies.

## Contract fixtures and canary

`apps/api/test/fixtures/bring/provider-v2026-07-26.json` is sanitized and contains synthetic identifiers/text plus a SHA-256 provenance digest. Tests consume it and never call Bring!.

`Bring Read-Only Canary` is disabled unless `BRING_READ_CANARY_ENABLED=true`. Its schedule and typed repository-dispatch entry point execute only default-branch code. It uses a dedicated GitHub-OIDC/Entra service identity that must have only `bring.read`, binds the credential-bearing destination to the single Azure-discovered test Function hostname, then performs only:

- `GET /api/bring/lists`;
- `GET /api/bring/lists/{configuredUuid}/items`.

The workflow contains no mutation request. Enable it only after configuring the dedicated app identity, `BRING_CANARY_*` variables, and a test-readable list UUID.

## Operations

Rotate the password or keys through repository/environment secrets and Key Vault-backed deployment. Clear only the configured session blob when necessary. Never print settings or use SAS URLs. Validate changes with:

```bash
npm run test:api
npm run ops:check-openapi-drift
npm run eval:agents
npm run ops:policy-guardrails
```

Provider response drift, account lockout, and ambiguous network failures remain residual risks. Roll back only through the repository rollback workflow to a known-good full `main` SHA.
