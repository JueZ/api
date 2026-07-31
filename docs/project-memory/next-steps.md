# Next steps

## Current delivery boundary

- PR #264 is merged and its exact commit was deployed to test, but runtime acceptance failed on the unauthenticated auth gate after the two permitted deployment repair attempts.
- Bootstrap PR #274 repaired the trusted reviewer. Focused runtime/bootstrap/settings PR #275 and successors #276/#277/#278/#279 each exhausted two bounded high-risk reviews without bypass. A fresh successor carries the accumulated package-only rollback, attempt rejection, correlation-bound artifact/provenance, immutable Function blob-version binding, activation-last frontend convergence, complete safety-policy, idempotent trigger, and exact CI authorization repairs.
- Production deployment is not authorized for this rollout and remains blocked.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; verify only that deployment wiring and secret references succeed.

## Operational rollout

1. Deliver the focused repair that loads `dist/index.js`, executes `assertRuntimeSafety()` before function registration, and denies disabled-auth requests outside local development.
2. Reconcile Function app settings through the explicit app-settings resource and prove every managed value or exact versioned secret-reference identity, including `AUTH_ENABLED=true`, without reading or exposing secret values.
3. Have a privileged Entra operator verify or configure the granular delegated scopes/application roles and register the exact new test SPA redirect URI. Keep complete/remove unavailable to service tokens.
4. Run the focused repair through exact-head PR CI, Policy Check, CodeQL, and the trusted merge controller. Require first-attempt/idempotent post-merge triggering, each deployment's immutable caller run/workflow SHA to remain current `main` at every Azure mutation boundary, and every downstream dispatch to validate the exact pinned main CI run/correlation plus matching test provenance. Production promotion/rollback must deploy both packages. Rollback must validate the complete existing managed app-setting policy and rendered bundle read-only before mutation, never reconcile safety settings, and download only the bundle preserved by its exact accepted production run. Function deployment must verify and activate one immutable blob-version URL. Normal and rollback static deployment must upload and verify replacement dependencies before activating `index.html`, remove only validated stale blobs after complete expected-content verification, and prove the active container has the exact approved names, sizes, and SHA-256 digests before acceptance.
5. Start a fresh test deployment repair cycle. Require `/health` at the exact SHA, unauthenticated `GET /api/hello` returning `401`, authenticated `GET /api/hello` and `POST /api/reddit/thread` passing, MCP origin/auth checks, telemetry correlation, release ledger, and accepted provenance.
6. Inventory any remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and list fingerprint/allowlist are verified; never add a mutation canary.
7. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
8. Stop after successful test verification. Production promotion requires a later explicit request for this rollout despite the repository enablement variable.
9. Record the repair PR, CI, test, authenticated smoke, telemetry, artifact-digest, and runtime-truth evidence in project memory.
