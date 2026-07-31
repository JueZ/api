# Staged deployment setup

The deployment workflow is intentionally infrastructure-only until all bootstrap prerequisites are verified.

## GitHub

Configure the exact required checks in `.github/autonomous-policy.yml`, squash merge, up-to-date branches, no direct/force push, no `main` deletion, and no admin bypass. Enable the trusted autonomous controller and repository `OPENAI_API_KEY` for independent high-risk review. Human approval is not required by the selected policy.

Create `test` and `production` environments for variable separation and deployment history. Keep `DEPLOY_PRODUCTION_ENABLED=false` until test, identity, RBAC, migration, smoke, telemetry, and rollback posture are proven.

## Azure OIDC and RBAC

Create a GitHub deployment identity with federated subjects for the trusted workflow/environment. Grant only:

- resource-group deployment permission;
- documented role-assignment ability needed by Bicep;
- release/static/WLH-reference container writes scoped as narrowly as Azure supports.

Do not use a long-lived Azure client secret or subscription Owner. The Function uses its own managed identity for host/runtime storage and Key Vault.

## Required configuration

Set exact OIDC/CORS/MCP values, granular permissions, environment-specific resource names, deployment identity object ID, operator alert email, and Bring flags/allowlists. Test Bring add/destructive flags must be false. Secrets include provider credentials, OpenAI API key, and Bring mutation HMAC/encryption keys; deployment stores/references them through Key Vault without printing values.

The combined budget intent is €25: test €10 and production €15.

## Data migration

Before the first split-storage cutover, copy existing WLH reference/session data into the new private account/container using an authorized, logged, read-then-write migration. Verify hashes/counts and retain the old data until runtime validation succeeds. Do not make the normal deployment workflow guess or silently migrate private data.

## Rollout

1. Validate locally and in PR.
2. Run Azure what-if against test.
3. Deploy the exact main-CI artifact to test.
4. Verify health SHA, auth, exact CORS/MCP origin, private/public storage boundaries, Key Vault references, Bring read-only policy, smokes, telemetry correlation, and release ledger.
5. Optionally enable the GET-only Bring canary with its dedicated `bring.read` identity.
6. Set `DEPLOY_PRODUCTION_ENABLED=true` only after test evidence and rollback readiness.
7. Promote the identical test-proven Function, SBOM, and frontend-source digests; render and hash the production frontend configuration before deployment.
8. Verify production runtime truth and keep the release ledger.

Normal promotion uses `Codex Main Delivery` and passes the exact accepted Deploy Test run ID plus correlation; no scan may substitute another run. Every deployment binds the caller's immutable run/workflow SHA, checks out that exact controller, and fails if it is no longer current `main`. Each dispatch must be workflow attempt 1; reruns fail before mutation and must be replaced with a new dispatch/correlation. Production promotion and rollback require both Function and frontend deployment flags. Rollback uses only `rollback-production.yml` with a known-good full `main` SHA plus the exact successful production run ID and delivery correlation for its accepted ledger and preserved release bundle. Current `main` supplies the rollback controller and validation logic, but rollback does not run Bicep or reconcile infrastructure/security settings. It discovers existing resources read-only, validates existing safety settings and the complete rendered frontend before mutation, requires the historical digest-addressed Function blob to exist, switches the Function package pointer/provenance without writing safety settings, and uploads the preserved rendered frontend bytes unchanged. Never deploy production from a local shell.
