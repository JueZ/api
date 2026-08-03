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

`operationId` is a caller-generated UUID. Durable state is retained for 30 days. An identical retry returns the recorded result; reusing the UUID with different input or identity fails. If the upstream result is ambiguous, state becomes `outcome_unknown` and automatic replay is permanently blocked. Read the list before deciding on a new operation.

Complete and remove use two phases:

```text
POST /api/bring/lists/{listUuid}/mutations/prepare
{ operationId, expectedListVersion, operation, items }

POST /api/bring/lists/{listUuid}/mutations/apply
{ operationId, confirmationToken }
```

Prepare requires the SHA-256 list version from the latest read, then validates policy, input, current list membership, sharing status, and optimistic concurrency without calling the mutation endpoint. It returns an HMAC list pseudonym, item count, expiry, and a five-minute token bound to the principal, operation ID, list, operation, version, and encrypted payload. Apply verifies that binding and rechecks the current list version before one upstream call.

MCP and GPT Actions expose only `bring_list_lists` and `bring_get_items`. Mutations stay on the authenticated REST/web-explorer path so provider-controlled Reddit, Willhaben, or Bring content cannot ask the same model session to perform or replay a write or confirmation token. The explorer keeps a prepared confirmation token only in private in-memory state, redacts it from rendered results and generated curl commands, and clears it after use or sign-out.

## Storage, encryption, and audit

The Function managed identity accesses separate private blob containers for:

- session cache;
- encrypted durable mutation state;
- append-only audit events.

Prepared item payloads use AES-256-GCM with `BRING_MUTATION_ENCRYPTION_KEY`. Confirmation/list/principal pseudonyms use `BRING_CONFIRMATION_HMAC_KEY`. Key material and provider credentials are Key Vault references in Function settings. Audit events contain operation, state, item count, pseudonyms, correlation ID, timestamp, and deployed commit—not item text. Lifecycle policy retains audit data for 365 days and mutation/replay state for at least 30 days.

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
