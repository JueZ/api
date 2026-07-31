# ADR 0002: Same Bring account with read-only test

- Status: accepted locally; not yet deployed
- Date: 2026-07-30

## Decision

Test and production retain the same Bring technical account. Test is structurally read-only. Production writes require an explicit own-list UUID in the writable allowlist; shared and unlisted lists are denied. Complete/remove require delegated-user permission and two-phase confirmation.

Live mutation canaries are prohibited. A disabled-by-default test canary may exercise only list and item GET routes using a dedicated `bring.read` service identity.

## Consequences

Read compatibility can be checked against the real account without risking test mutations. Provider write compatibility relies on sanitized fixtures, staged rollout, durable idempotency, and operator-confirmed production use.
