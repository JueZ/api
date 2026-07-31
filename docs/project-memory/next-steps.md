# Next steps

## Current delivery boundary

- PR #283 repaired Entra GUID startup validation. Test run `30652787906` proves exact-SHA runtime health, unauthenticated fail-closed auth, and CORS; authenticated smoke remains `403` and prevents accepted test provenance or production promotion.
- The enterprise-hardening branch is prepared locally and must still pass its own exact-head CI, Policy Check, CodeQL, independent review, merge, fresh main CI, and staged delivery.
- Normal test-to-production promotion is authorized by the current task only after the same exact release passes every configured test, authenticated smoke, telemetry, provenance, and runtime-truth gate. No bypass or local production deployment is authorized.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; verify only that deployment wiring and secret references succeed.

## Operational rollout

1. Have a privileged Entra operator run/verify `scripts/configure-entra-service-oauth.sh` for the existing test smoke identity and ensure the exact `catalogue.read,reddit.read` application roles are assigned. The current Codex service principal cannot perform this Microsoft Graph operation.
2. Rotate the credential material identified in the local untracked Codex environment file. Do not copy values into issues, PRs, logs, or project memory.
3. Deliver the enterprise-hardening branch through exact-head CI, Policy Check, CodeQL, and the trusted merge controller. Do not bypass a review or rerun a failed first attempt.
4. Start a fresh exact-main test deployment. Require exact-SHA `/health`, unauthenticated `/api/hello=401`, authenticated hello and Reddit, MCP origin/auth/provider-isolation checks, telemetry correlation scoped to the current activation, release ledger, artifact digests/attestations, and accepted provenance.
5. If and only if test is fully accepted and current `main` is unchanged, allow the normal workflow to promote that exact release to production. Require production authenticated smoke, telemetry, ledger/runtime truth, and preserved rollback bundle.
6. Have a privileged Entra operator verify the granular delegated scopes/application roles and exact current test SPA redirect. Keep complete/remove unavailable to service tokens.
7. Inventory any remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and list fingerprint/allowlist are verified; never add a mutation canary.
8. Deliver explicit Log Analytics workspace ownership/capping as a separate test-first PR and preserve old managed workspaces for at least 90 days.
9. Prove intentionally failing/pending-check and failed-review PRs cannot merge, then record exact PR, CI, test, production, smoke, telemetry, digest, attestation, and runtime-truth evidence in project memory.
