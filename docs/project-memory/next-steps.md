# Next steps

## Current delivery boundary

- PR #283 repaired Entra GUID startup validation. Test run `30652787906` proves exact-SHA runtime health, unauthenticated fail-closed auth, and CORS; authenticated smoke remains `403` and prevents accepted test provenance or production promotion.
- The enterprise-hardening repair is locally validated, but repository Actions and native auto-merge are intentionally disabled. It changes autonomous-delivery trust roots and therefore cannot use the autonomous controller. Remote CI, review, merge, and staged delivery remain security-blocked until external credential rotation and an independent trust root exist.
- Normal test-to-production promotion is authorized by the current task only after the same exact release passes every configured test, authenticated smoke, telemetry, provenance, and runtime-truth gate. No bypass or local production deployment is authorized.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; verify only that deployment wiring and secret references succeed.

## Operational rollout

1. Revoke and rotate every affected GitHub, Azure, and provider credential externally. Do not copy values into issues, PRs, logs, or project memory. Verify the GitHub credential revocation before trusting repository-hosted evidence.
2. Bootstrap an independently controlled out-of-band security trust root, such as a separately controlled security principal or a pre-pinned hardware-backed signing key. Prefer an organization required workflow or independent GitHub App when repository ownership can be moved to an organization. Do not treat a JueZ comment, label, PR field, or workflow result as clearance.
3. Through that independent process, review and merge the enterprise-hardening security-control change, revalidate classic branch protection, and replace the old Azure federated credentials with exact `repo`/`context`/`job_workflow_ref` subjects. Give the OIDC diagnostic a separate Reader-only identity. Keep production disabled.
4. Re-enable only the minimum test-side Actions/workflows after containment and identity/RBAC review. Run a fresh first-attempt exact-main CI and test deployment; do not rerun a failed attempt as acceptance evidence.
5. Have a privileged Entra operator run/verify `scripts/configure-entra-service-oauth.sh` for the existing test smoke identity and ensure the exact `catalogue.read,reddit.read` application roles are assigned. The current Codex service principal cannot perform this Microsoft Graph operation.
6. Require exact-SHA `/health`, unauthenticated `/api/hello=401`, authenticated hello and Reddit, MCP origin/auth/provider-isolation checks, telemetry correlation scoped to the current activation, release ledger, artifact digests/attestations, and accepted provenance in test.
7. If and only if test is fully accepted and current `main` is unchanged, independently authorize restoration of the production workflow and `DEPLOY_PRODUCTION_ENABLED`; then let the normal workflow promote that exact release. Require production authenticated smoke, telemetry, ledger/runtime truth, and preserved rollback bundle.
8. Have a privileged Entra operator verify the granular delegated scopes/application roles and exact current test SPA redirect. Keep complete/remove unavailable to service tokens.
9. Inventory any remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and list fingerprint/allowlist are verified; never add a mutation canary.
10. Deliver explicit Log Analytics workspace ownership/capping as a separate test-first PR and preserve old managed workspaces for at least 90 days.
11. Prove intentionally failing/pending-check and failed-review PRs cannot merge, then record exact PR, CI, test, production, smoke, telemetry, digest, attestation, and runtime-truth evidence in project memory.
